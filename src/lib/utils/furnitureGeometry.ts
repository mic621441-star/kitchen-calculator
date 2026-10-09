import type { Point, Wall, FurnitureItem } from '$lib/models/types';
import { getFurnitureSize, getFurnitureBody, type FurnitureDef, type DockSides } from '$lib/utils/furnitureCatalog';
import { WALL_SNAP_DIST } from '$lib/utils/canvasInteraction';

/** Keep the back edge flush with a straight wall, using the placed item's real footprint. */
export function snapFurnitureToWalls(
  pos: Point,
  furniture: FurnitureItem | FurnitureDef,
  walls: Wall[],
  snapCoordinate: (value: number) => number = value => value,
  maxDist: number = WALL_SNAP_DIST,
): { position: Point; rotation: number; wallId: string; side: 'normal' | 'anti'; wallAngle: number } | null {
    // A placed item carries per-item size overrides; a bare catalog def (placement
    // preview, before the item exists) is already its own effective size.
    const size = 'catalogId' in furniture ? getFurnitureSize(furniture) : furniture;

    // Furniture half-depth (the "back" dimension that goes against the wall)
    const halfDepth = size.depth / 2;
    const halfWidth = size.width / 2;

    let bestDist = maxDist;
    let bestResult: { position: Point; rotation: number; wallId: string; side: 'normal' | 'anti'; wallAngle: number } | null = null;

    for (const wall of walls) {
      const wx = wall.end.x - wall.start.x;
      const wy = wall.end.y - wall.start.y;
      const wLen = Math.hypot(wx, wy);
      if (wLen < 1 || size.width > wLen || wall.curvePoint) continue;

      // Unit vectors along wall and perpendicular (normal)
      const ux = wx / wLen, uy = wy / wLen;
      const nx = -uy, ny = ux; // normal pointing "left" of wall direction

      // Project furniture center onto wall line
      const dx = pos.x - wall.start.x;
      const dy = pos.y - wall.start.y;
      const along = dx * ux + dy * uy; // projection along wall
      const perp = dx * nx + dy * ny;  // signed distance from wall center-line

      // Check if projection falls within wall segment (with some margin)
      if (along < -halfWidth || along > wLen + halfWidth) continue;

      const wallHalfThickness = wall.thickness / 2;
      // Distance from furniture center to wall surface on the side the furniture is on
      const absDist = Math.abs(perp) - wallHalfThickness;

      // We want the furniture edge to touch the wall, so target distance = halfDepth
      const snapDist = Math.abs(absDist - halfDepth);

      if (snapDist < bestDist) {
        bestDist = snapDist;
        const side: 'normal' | 'anti' = perp >= 0 ? 'normal' : 'anti';
        const sign = perp >= 0 ? 1 : -1;
        // Position: push center so edge is flush with wall surface
        const targetPerp = sign * (wallHalfThickness + halfDepth);
        const clampedAlong = Math.max(halfWidth, Math.min(wLen - halfWidth, along));

        // Grid-snap the position, then keep only the part of that movement that runs along
        // the wall, so the distance to the wall stays exact and the item sits flush.
        const gx = snapCoordinate(wall.start.x + ux * clampedAlong + nx * targetPerp);
        const gy = snapCoordinate(wall.start.y + uy * clampedAlong + ny * targetPerp);
        const gridAlong = (gx - wall.start.x) * ux + (gy - wall.start.y) * uy;
        const finalAlong = Math.max(halfWidth, Math.min(wLen - halfWidth, gridAlong));
        const newX = wall.start.x + ux * finalAlong + nx * targetPerp;
        const newY = wall.start.y + uy * finalAlong + ny * targetPerp;
        // Align rotation: furniture "front" faces away from wall
        const wallAngle = Math.atan2(wy, wx) * 180 / Math.PI;
        // Furniture at 0° has depth along Y axis, so align perpendicular
        const targetRotation = perp >= 0 ? wallAngle : wallAngle + 180;

        bestResult = {
          position: { x: newX, y: newY },
          rotation: ((targetRotation % 360) + 360) % 360,
          wallId: wall.id,
          side,
          wallAngle: wallAngle
        };
      }
    }
    return bestResult;
}

/** Effective axis-aligned half-footprint at a rotation, swapping width/depth
 *  near 90°/270° — covers the common case of modules rotated in 90° steps. */
function axisAlignedHalfSize(rotation: number, width: number, depth: number): { halfW: number; halfD: number } {
  const rot = ((rotation % 180) + 180) % 180;
  const swapped = rot > 45 && rot < 135;
  return swapped ? { halfW: depth / 2, halfD: width / 2 } : { halfW: width / 2, halfD: depth / 2 };
}

/** Maps a module's own left/right/front/back dock flags (defined in its unrotated
 *  frame) onto the world +X/-X/+Y/-Y edges they currently face, snapping rotation
 *  to the nearest 90° step — the same simplifying assumption axisAlignedHalfSize
 *  makes, and the one the rest of this module's docking math relies on. */
function worldEdgeDockable(sides: DockSides, rotation: number): { posX: boolean; negX: boolean; posY: boolean; negY: boolean } {
  const rot = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const local: [boolean, number, number][] = [
    [sides.left, -1, 0], [sides.right, 1, 0], [sides.back, 0, -1], [sides.front, 0, 1],
  ];
  const result = { posX: false, negX: false, posY: false, negY: false };
  for (const [dockable, lx, ly] of local) {
    if (!dockable) continue;
    let wx = lx, wy = ly;
    if (rot === 90) { wx = -ly; wy = lx; }
    else if (rot === 180) { wx = -lx; wy = -ly; }
    else if (rot === 270) { wx = ly; wy = -lx; }
    if (wx > 0) result.posX = true;
    else if (wx < 0) result.negX = true;
    else if (wy > 0) result.posY = true;
    else if (wy < 0) result.negY = true;
  }
  return result;
}

/** Slides a dragged item sideways so one of its corpus edges touches the nearest
 *  dockable neighbor's corpus edge, if within `maxDist`, and turns to match that
 *  neighbor's rotation — a docked module always faces the same way as the row it
 *  joins, never just slides in at its own angle. Docking is measured against each
 *  module's corpus size (bodyWidth/bodyDepth), never its external bounding box, only
 *  pairs modules in the same tier, and only where both facing sides allow it.
 *  Composes with snapFurnitureToWalls(): call this with the wall-snapped position so
 *  the wall keeps setting rotation and depth while this only adjusts the along-row
 *  position. Returns null if nothing dockable is close enough. */
export function snapFurnitureToNeighbors(
  pos: Point,
  furniture: FurnitureItem | FurnitureDef,
  others: FurnitureItem[],
  maxDist: number,
  excludeId?: string,
): { position: Point; rotation: number; neighborId: string } | null {
  const body = getFurnitureBody(furniture);

  let best: { axis: 'x' | 'y'; delta: number; dist: number; rotation: number; neighborId: string } | null = null;

  for (const other of others) {
    if (excludeId && other.id === excludeId) continue;
    const otherBody = getFurnitureBody(other);
    if (otherBody.tier !== body.tier) continue;

    // Test docking as if this item adopted the neighbor's rotation: a module
    // always turns to match the row it joins, so the flush-fit check has to use
    // the corpus size and facing sides it would have *after* turning.
    const testRotation = other.rotation;
    const { halfW, halfD } = axisAlignedHalfSize(testRotation, body.bodyWidth, body.bodyDepth);
    const o = axisAlignedHalfSize(other.rotation, otherBody.bodyWidth, otherBody.bodyDepth);
    const mine = worldEdgeDockable(body.dockSides, testRotation);
    const theirs = worldEdgeDockable(otherBody.dockSides, other.rotation);

    // Side-by-side along X: valid only while corpus Y-extents overlap and both
    // facing sides (this item's -X/+X, the neighbor's opposing +X/-X) dock.
    const yOverlap = Math.min(pos.y + halfD, other.position.y + o.halfD) - Math.max(pos.y - halfD, other.position.y - o.halfD);
    if (yOverlap > 0) {
      if (mine.negX && theirs.posX) {
        const gap = (other.position.x + o.halfW) - (pos.x - halfW);
        if (Math.abs(gap) < maxDist && (!best || Math.abs(gap) < best.dist)) best = { axis: 'x', delta: gap, dist: Math.abs(gap), rotation: testRotation, neighborId: other.id };
      }
      if (mine.posX && theirs.negX) {
        const gap = (other.position.x - o.halfW) - (pos.x + halfW);
        if (Math.abs(gap) < maxDist && (!best || Math.abs(gap) < best.dist)) best = { axis: 'x', delta: gap, dist: Math.abs(gap), rotation: testRotation, neighborId: other.id };
      }
    }
    // Side-by-side along Y: valid only while corpus X-extents overlap and both
    // facing sides (this item's -Y/+Y, the neighbor's opposing +Y/-Y) dock.
    const xOverlap = Math.min(pos.x + halfW, other.position.x + o.halfW) - Math.max(pos.x - halfW, other.position.x - o.halfW);
    if (xOverlap > 0) {
      if (mine.negY && theirs.posY) {
        const gap = (other.position.y + o.halfD) - (pos.y - halfD);
        if (Math.abs(gap) < maxDist && (!best || Math.abs(gap) < best.dist)) best = { axis: 'y', delta: gap, dist: Math.abs(gap), rotation: testRotation, neighborId: other.id };
      }
      if (mine.posY && theirs.negY) {
        const gap = (other.position.y - o.halfD) - (pos.y + halfD);
        if (Math.abs(gap) < maxDist && (!best || Math.abs(gap) < best.dist)) best = { axis: 'y', delta: gap, dist: Math.abs(gap), rotation: testRotation, neighborId: other.id };
      }
    }
  }

  if (!best) return null;
  const position = best.axis === 'x' ? { x: pos.x + best.delta, y: pos.y } : { x: pos.x, y: pos.y + best.delta };
  return { position, rotation: best.rotation, neighborId: best.neighborId };
}
