import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { Vector3 } from 'three';
import { buildWallSegments, openingOnWall, roomCeilingHeight, wallPathSpans } from '$lib/utils/wallProfiles';
import { createSlopedBoxGeometry } from '$lib/utils/slopedWallGeometry';
import { addWall, currentProject, createDefaultProject, splitWall, updateWall, undo } from '$lib/stores/project';
import { getWallHeightAt, type Wall, type Window } from '$lib/models/types';

const wall = (overrides: Partial<Wall> = {}): Wall => ({ id: 'a', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, height: 300, startHeight: 100, endHeight: 300, thickness: 20, color: '#444444', ...overrides });
const window = (overrides: Partial<Window> = {}): Window => ({ id: 'w', wallId: 'a', position: 0.25, width: 100, sillHeight: 100, height: 200, type: 'standard', ...overrides });
beforeEach(() => currentProject.set(createDefaultProject()));

it('fits the entire rectangular opening beneath the low edge of the slope', () => {
  expect(openingOnWall(400, 100, 300, 0.5, 200, 0, 220)).toEqual({ left: 100, right: 300, bottom: 0, top: 150 });
  expect(openingOnWall(400, 300, 100, 0.5, 200, 0, 220)).toEqual({ left: 100, right: 300, bottom: 0, top: 150 });
  expect(openingOnWall(400, 100, 300, 0.25, 100, 200, 100)).toBeNull();
});

it('subtracts overlapping windows once, without duplicate wall strips', () => {
  const windows = [window(), window({ id: 'w2', position: 0.375, sillHeight: 150, height: 50 })];
  const originals = JSON.stringify({ windows });
  const pieces = buildWallSegments(400, 200, 400, windows);
  const area = pieces.reduce((sum, p) => sum + p.width * ((p.topYLeft + p.topYRight) / 2 - p.bottomY), 0);
  expect(area).toBe(105_000); // 120,000 trapezoid minus the two windows' (slope-clipped) openings
  expect(JSON.stringify({ windows })).toBe(originals);
  for (const p of pieces) {
    expect(p.width).toBeGreaterThan(0);
    expect(p.topYLeft).toBeGreaterThanOrEqual(p.bottomY);
    expect(p.topYRight).toBeGreaterThanOrEqual(p.bottomY);
    expect(p.topYLeft).toBeLessThanOrEqual(200 + (p.offsetX - p.width / 2) / 2);
    expect(p.topYRight).toBeLessThanOrEqual(200 + (p.offsetX + p.width / 2) / 2);
  }
});

it('positions clipped end openings at the clipped span centre and ignores openings above the wall', () => {
  const pieces = buildWallSegments(400, 200, 400, [window({ position: 0, sillHeight: 0, height: 150 }), window({ id: 'w2', sillHeight: 500 })]);
  expect(pieces[0]).toEqual({ width: 50, offsetX: 25, bottomY: 150, topYLeft: 200, topYRight: 225 });
  expect(pieces[1]).toEqual({ width: 350, offsetX: 225, bottomY: 0, topYLeft: 225, topYRight: 400 });
});

it.each([[0, 350], [350, 0], [200, 350], [280, 280]])('builds the actual mesh within the %s → %s profile with outward triangles', (start, end) => {
  const geo = createSlopedBoxGeometry(400, 20, 0, start, end);
  const positions = geo.getAttribute('position'), indices = geo.getIndex()!, normals = geo.getAttribute('normal');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i);
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(start + (end - start) * (x + 200) / 400 + 0.0001);
  }
  for (let i = 0; i < indices.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(positions, indices.getX(i));
    const b = new Vector3().fromBufferAttribute(positions, indices.getX(i + 1));
    const c = new Vector3().fromBufferAttribute(positions, indices.getX(i + 2));
    const face = b.sub(a).cross(c.sub(a));
    if (face.lengthSq() < 1e-10) continue; // zero-height triangular tip
    expect(face.normalize().dot(new Vector3().fromBufferAttribute(normals, indices.getX(i)))).toBeGreaterThan(0.99);
  }
  geo.dispose();
});

it('uses continuous curved spans and heights in either direction', () => {
  const original = wall({ curvePoint: { x: 160, y: 200 } });
  const spans = wallPathSpans(original);
  expect(spans).toHaveLength(16);
  expect(spans[0].start).toEqual(original.start);
  expect(spans.at(-1)!.end).toEqual(original.end);
  expect(spans[8].start.y).toBe(100);
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i].start).toEqual(spans[i - 1].end);
    expect(spans[i].startHeight).toBe(spans[i - 1].endHeight);
  }
  const reversed = wallPathSpans({ ...original, start: original.end, end: original.start, startHeight: 300, endHeight: 100 }).reverse();
  spans.forEach((span, i) => { expect(span.start).toEqual(reversed[i].end); expect(span.startHeight).toBe(reversed[i].endHeight); });
});

it('evaluates ceilings per room, excluding sloped or uneven boundaries only', () => {
  const flat = wall({ id: 'flat', startHeight: 280, endHeight: 280 });
  expect(roomCeilingHeight(['flat'], [wall(), flat])).toBe(280);
  expect(roomCeilingHeight(['a'], [wall(), flat])).toBeUndefined();
  expect(roomCeilingHeight(['flat', 'other'], [flat, wall({ id: 'other', startHeight: 200, endHeight: 200 })])).toBeUndefined();
  expect(roomCeilingHeight(['missing'], [flat])).toBeUndefined();
});

it('ignores invalid heights and split parameters without corrupting the project', () => {
  const id = addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  const before = JSON.stringify(get(currentProject));
  for (const value of [-1, NaN, Infinity]) updateWall(id, { startHeight: value });
  expect(splitWall(id, NaN)).toBeNull();
  expect(JSON.stringify(get(currentProject))).toBe(before);
  expect(getWallHeightAt(wall({ startHeight: NaN }), 0)).toBe(300);
});

it('retains shared texture and exact slope at a non-midpoint split, with undo', () => {
  // Isolate from the default project's own starter room so the wall count
  // assertions below are about only the wall this test adds.
  const p = get(currentProject)!;
  currentProject.set({ ...p, floors: [{ ...p.floors[0], walls: [] }] });
  const id = addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  updateWall(id, { startHeight: 100, endHeight: 300, texture: 'brick', interiorColor: '#123456' });
  const next = splitWall(id, 0.25)!;
  const walls = get(currentProject)!.floors[0].walls;
  expect(walls.find(w => w.id === next)).toMatchObject({ texture: 'brick', interiorColor: '#123456', startHeight: 150, endHeight: 300 });
  expect(walls.find(w => w.id === id)).toMatchObject({ startHeight: 100, endHeight: 150 });
  undo();
  expect(get(currentProject)!.floors[0].walls).toHaveLength(1);
  expect(get(currentProject)!.floors[0].walls[0]).toMatchObject({ startHeight: 100, endHeight: 300 });
});
