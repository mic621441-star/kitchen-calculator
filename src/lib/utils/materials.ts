export interface WallColor {
  id: string;
  name: string;
  color: string;
  texture?: 'brick' | 'stone' | 'wood-panel' | 'concrete' | 'tile';
}

export const wallColors: WallColor[] = [
  { id: 'white', name: 'White', color: '#ffffff' },
  { id: 'cream', name: 'Cream', color: '#fffdd0' },
  { id: 'warm-white', name: 'Warm White', color: '#faf7f2' },
  { id: 'light-gray', name: 'Light Gray', color: '#d1d5db' },
  { id: 'medium-gray', name: 'Medium Gray', color: '#9ca3af' },
  { id: 'charcoal', name: 'Charcoal', color: '#374151' },
  { id: 'navy-blue', name: 'Navy Blue', color: '#1e3a8a' },
  { id: 'light-blue', name: 'Light Blue', color: '#dbeafe' },
  { id: 'sage-green', name: 'Sage Green', color: '#d4e2d4' },
  { id: 'olive', name: 'Olive', color: '#a3a058' },
  { id: 'terracotta', name: 'Terracotta', color: '#d2691e' },
  { id: 'blush-pink', name: 'Blush Pink', color: '#f4c2c2' },
  { id: 'lavender', name: 'Lavender', color: '#e6e6fa' },
  { id: 'butter-yellow', name: 'Butter Yellow', color: '#fff8dc' },
  { id: 'taupe', name: 'Taupe', color: '#b8a082' },
  // Textured walls
  { id: 'red-brick', name: 'Red Brick', color: '#8B4513', texture: 'brick' },
  { id: 'exposed-brick', name: 'Exposed Brick', color: '#A0522D', texture: 'brick' },
  { id: 'stone', name: 'Stone', color: '#808080', texture: 'stone' },
  { id: 'wood-panel', name: 'Wood Panel', color: '#8B6914', texture: 'wood-panel' },
  { id: 'concrete-block', name: 'Concrete Block', color: '#999999', texture: 'concrete' },
  { id: 'subway-tile', name: 'Subway Tile', color: '#F0F0F0', texture: 'tile' },
];

export function getWallColor(id: string): WallColor {
  // Handle legacy color IDs
  const legacyMap: Record<string, string> = {
    'gray': 'light-gray',
    'beige': 'cream',
    'sage': 'sage-green',
  };
  
  const colorId = legacyMap[id] || id;
  return wallColors.find(c => c.id === colorId) ?? wallColors[0];
}
