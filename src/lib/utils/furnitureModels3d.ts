import * as THREE from 'three';
import type { FurnitureDef } from './furnitureCatalog';

// Helper to create standard material
function createMaterial(color: string, roughness = 0.7, metalness = 0.1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
  });
}

// Helper to add shadow casting to all meshes in a group
function enableShadows(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

// Bundled per-item procedural geometry removed along with the third-party
// model catalog. Every placed item now renders as a plain box sized to its
// FurnitureDef/FurnitureItem dimensions — the immediate fallback shown before
// (and in place of) any GLB model. The 'stairs' import-preview id keeps its
// stepped placeholder since it is not part of the removed bundled catalog.
export function createFurnitureModel(catalogId: string, def: FurnitureDef): THREE.Group {
  const group = new THREE.Group();
  const { width: w, depth: d, height: h, color } = def;

  if (catalogId === 'stairs') {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const stepHeight = h * (i + 1) / steps;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, stepHeight, d / steps), createMaterial(color));
      mesh.position.set(0, stepHeight / 2, d / 2 - (i + 0.5) * d / steps);
      group.add(mesh);
    }
  } else {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const material = createMaterial(color);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = h / 2;
    group.add(mesh);
  }

  enableShadows(group);
  return group;
}
