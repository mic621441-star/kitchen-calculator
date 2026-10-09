import type { FurnitureItem } from '$lib/models/types';

/** Vertical zone a module belongs to — modules only dock to neighbors in the same tier. */
export type FurnitureTier = 'base' | 'wall' | 'tall';

/** Whether a module's corpus can dock to a neighboring module on that side, in the
 *  module's own unrotated frame (width along X, depth along Y): left/right are the
 *  X-axis sides, back/front are the Y-axis sides (back is the wall-facing side). */
export interface DockSides {
  left: boolean;
  right: boolean;
  front: boolean;
  back: boolean;
}

const NO_DOCK_SIDES: DockSides = { left: false, right: false, front: false, back: false };

/** Real corpus depth/height per tier, in cm (600x820mm base, 320x720mm wall,
 *  600x2100mm tall) — the single source of truth a module's depth and height
 *  are drawn from; only its width varies (see MODULE_WIDTHS_CM). */
export const TIER_DIMENSIONS: Record<FurnitureTier, { depth: number; height: number }> = {
  base: { depth: 60, height: 82 },
  wall: { depth: 32, height: 72 },
  tall: { depth: 60, height: 210 },
};

/** Standard module widths in cm (300/400/450/500/600/800/900mm) — a cabinet
 *  module's width is chosen from this list, never entered freely. */
export const MODULE_WIDTHS_CM = [30, 40, 45, 50, 60, 80, 90];

export interface FurnitureDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  color: string;
  /** width x depth x height in cm — the item's external footprint (may include
   *  countertop overhang, handles, etc.) */
  width: number;
  depth: number;
  height: number;
  /** Structural corpus footprint in cm, distinct from the external width/depth above.
   *  Module-to-module docking is measured against these, never the external footprint.
   *  Defaults to width/depth when omitted. */
  bodyWidth?: number;
  bodyDepth?: number;
  /** Defaults to 'base' when omitted. */
  tier?: FurnitureTier;
  /** Defaults to no dockable sides (the module never docks to a neighbor) when omitted. */
  dockSides?: DockSides;
  /** True for a genuine cabinet module (a real box, not an appliance or freestanding
   *  piece): its depth and height follow TIER_DIMENSIONS and its width is picked from
   *  MODULE_WIDTHS_CM, all locked from free editing in the properties panel. Appliances
   *  (fridge, stove, dishwasher, range hood) and freestanding items (island, table) share
   *  a tier for docking purposes but keep their own real, freely-editable dimensions. */
  module?: boolean;
  /** If set, this is a 2D-only architectural symbol (not rendered in 3D) */
  symbol?: boolean;
}

// The bundled third-party model catalog was removed for licensing reasons; every
// entry below is a plain parametric box (see createFurnitureModel in
// furnitureModels3d.ts) sized and colored to read as its real-world counterpart,
// with no GLB asset required.
const SIDE_DOCK: DockSides = { left: true, right: true, front: false, back: false };

export const furnitureCatalog: FurnitureDef[] = [
  // Kitchen
  { id: 'kitchen_base_cabinet', name: 'Base Cabinet', category: 'Kitchen', icon: '🗄️', color: '#e2e8f0', width: 60, depth: TIER_DIMENSIONS.base.depth, height: TIER_DIMENSIONS.base.height, bodyWidth: 60, bodyDepth: TIER_DIMENSIONS.base.depth, tier: 'base', module: true, dockSides: SIDE_DOCK },
  { id: 'kitchen_wall_cabinet', name: 'Wall Cabinet', category: 'Kitchen', icon: '🗄️', color: '#e2e8f0', width: 60, depth: TIER_DIMENSIONS.wall.depth, height: TIER_DIMENSIONS.wall.height, bodyWidth: 60, bodyDepth: TIER_DIMENSIONS.wall.depth, tier: 'wall', module: true, dockSides: SIDE_DOCK },
  { id: 'kitchen_island', name: 'Kitchen Island', category: 'Kitchen', icon: '🏝️', color: '#cbd5e1', width: 120, depth: 90, height: 90, bodyWidth: 120, bodyDepth: 88, tier: 'base', dockSides: NO_DOCK_SIDES },
  { id: 'kitchen_fridge', name: 'Refrigerator', category: 'Kitchen', icon: '🧊', color: '#94a3b8', width: 90, depth: 70, height: 180, bodyWidth: 90, bodyDepth: 67, tier: 'base', dockSides: SIDE_DOCK },
  { id: 'kitchen_stove', name: 'Stove / Range', category: 'Kitchen', icon: '🔥', color: '#475569', width: 60, depth: 60, height: 90, bodyWidth: 60, bodyDepth: 60, tier: 'base', dockSides: SIDE_DOCK },
  { id: 'kitchen_range_hood', name: 'Range Hood', category: 'Kitchen', icon: '💨', color: '#64748b', width: 60, depth: 45, height: 20, bodyWidth: 60, bodyDepth: 45, tier: 'wall', dockSides: SIDE_DOCK },
  { id: 'kitchen_sink_base', name: 'Sink Base Cabinet', category: 'Kitchen', icon: '🚰', color: '#e2e8f0', width: 80, depth: TIER_DIMENSIONS.base.depth, height: TIER_DIMENSIONS.base.height, bodyWidth: 80, bodyDepth: TIER_DIMENSIONS.base.depth, tier: 'base', module: true, dockSides: SIDE_DOCK },
  { id: 'kitchen_dishwasher', name: 'Dishwasher', category: 'Kitchen', icon: '🍽️', color: '#94a3b8', width: 60, depth: 60, height: 85, bodyWidth: 60, bodyDepth: 60, tier: 'base', dockSides: SIDE_DOCK },
  { id: 'kitchen_table', name: 'Kitchen Table', category: 'Kitchen', icon: '🍽️', color: '#b08968', width: 120, depth: 80, height: 75, bodyWidth: 120, bodyDepth: 80, tier: 'base', dockSides: NO_DOCK_SIDES },
];

// Import previews stay out of the placement catalog and need no model downloads.
const importPreviews: FurnitureDef[] = [
  { id: 'imported_object', name: 'Unrecognized item', category: 'Imported', icon: '📦', color: '#94a3b8', width: 50, depth: 50, height: 50 },
  { id: 'stairs', name: 'Imported stairs', category: 'Imported', icon: '🪜', color: '#78716c', width: 90, depth: 300, height: 200 },
];

export function getCatalogItem(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find(f => f.id === id) ?? importPreviews.find(f => f.id === id);
}

const UNKNOWN_ITEM_DEF: FurnitureDef = { id: 'unknown', name: 'Furniture', category: 'Unknown', icon: '📦', color: '#94a3b8', width: 50, depth: 50, height: 50 };

/**
 * Same lookup as getCatalogItem, but never undefined — a placed item always has
 * *some* definition to render and interact with, even with an empty or custom
 * catalog that no longer lists its catalogId. Use this (not getCatalogItem) for
 * anything that draws, hit-tests or measures an already-placed FurnitureItem;
 * reserve getCatalogItem for placement-picker lookups where "nothing to place"
 * is a legitimate outcome.
 */
export function getCatalogItemOrFallback(id: string): FurnitureDef {
  return getCatalogItem(id) ?? UNKNOWN_ITEM_DEF;
}

/**
 * Effective footprint of a placed item in cm — per-item overrides applied over the
 * catalog defaults, then multiplied by scale. Use this wherever geometry is derived
 * from a FurnitureItem.
 */
export function getFurnitureSize(fi: FurnitureItem): { width: number; depth: number; height: number } {
  const cat = getCatalogItem(fi.catalogId);
  return {
    width: (fi.width ?? cat?.width ?? 50) * Math.abs(fi.scale?.x ?? 1),
    depth: (fi.depth ?? cat?.depth ?? 50) * Math.abs(fi.scale?.y ?? 1),
    height: (fi.height ?? cat?.height ?? 50) * Math.abs(fi.scale?.z ?? 1),
  };
}

/**
 * Corpus footprint and docking rules for a module — used by the module-to-module
 * docking geometry, which measures against these (never against the external
 * width/depth returned by getFurnitureSize). A bare catalog def (placement preview)
 * uses its own values directly; a placed item's corpus scales in proportion to
 * however its effective size deviates from the catalog default (per-item overrides
 * or scale), so a resized module still docks correctly.
 */
export function getFurnitureBody(fi: FurnitureItem | FurnitureDef): { bodyWidth: number; bodyDepth: number; tier: FurnitureTier; dockSides: DockSides } {
  const isItem = 'catalogId' in fi;
  const cat = isItem ? getCatalogItemOrFallback((fi as FurnitureItem).catalogId) : (fi as FurnitureDef);
  const tier = cat.tier ?? 'base';
  const dockSides = cat.dockSides ?? NO_DOCK_SIDES;
  const catBodyWidth = cat.bodyWidth ?? cat.width;
  const catBodyDepth = cat.bodyDepth ?? cat.depth;
  if (!isItem) return { bodyWidth: catBodyWidth, bodyDepth: catBodyDepth, tier, dockSides };

  const size = getFurnitureSize(fi as FurnitureItem);
  return {
    bodyWidth: catBodyWidth * (size.width / cat.width),
    bodyDepth: catBodyDepth * (size.depth / cat.depth),
    tier,
    dockSides,
  };
}

export const furnitureCategories = [...new Set(furnitureCatalog.map(f => f.category))];
