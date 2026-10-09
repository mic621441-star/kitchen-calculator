import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Regression coverage for a bug where placing a module from the 3D "Add
// furniture" panel left furniturePlacementMode stuck on: every following
// click silently stamped another copy of the last-picked catalog item
// instead of ever reaching selection/drag/delete. Uses the real, current
// kitchen catalog (kitchen_base_cabinet / kitchen_wall_cabinet) and the
// exact flow a user follows — new project, 3D view, panel — never a
// fixture, since fixtures can reference catalog items already removed
// from the live catalog.
//
// Coordinate notes:
// - Selecting anything opens the Properties panel, which narrows the 3D
//   canvas, so a screen point computed before a selection is invalid
//   after one. The wall cabinet is placed first (canvas still full width,
//   placement itself doesn't need pixel precision) so its auto-select
//   settles the canvas at its final width *before* the base cabinet's
//   point is computed.
// - A wall-tier item (kitchen_wall_cabinet) renders hung near the wall,
//   well above the floor-level Y used to click-place it, so it can't be
//   reliably re-clicked with the same point. All precision
//   select/drag/delete testing below targets the base cabinet instead,
//   which sits at floor level where it was placed.

type Furniture = { id: string; catalogId: string; position: { x: number; y: number } };

async function dismissTooltip(page: Page) {
  const gotIt = page.getByRole('button', { name: 'Понятно', exact: true });
  if (await gotIt.count()) await gotIt.click();
}

async function open3DWithKitchenPanel(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('o3d_locale', 'ru'); } catch {} });
  await page.goto('/editor');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Просмотр 3D плана' }).locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForLoadState('networkidle');
  await dismissTooltip(page);
  await page.getByRole('button', { name: 'Кухня', exact: true }).click();
  return canvas;
}

async function floorPoint(canvas: Locator, dx: number) {
  const box = (await canvas.boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height * 0.75 };
}

async function placeItem(page: Page, label: string, point: { x: number; y: number }) {
  await page.getByRole('button').filter({ hasText: label }).first().click();
  await page.mouse.click(point.x, point.y);
  await dismissTooltip(page);
}

async function exportedFurniture(page: Page): Promise<Furniture[]> {
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать JSON', exact: true }).click();
  const path = await (await download).path();
  const project = JSON.parse(await readFile(path!, 'utf8'));
  const floor = project.floors.find((f: { id: string }) => f.id === project.activeFloorId);
  await dismissTooltip(page); // exporting can trigger its own onboarding tip
  return floor.furniture as Furniture[];
}

test('placing, selecting, dragging and deleting a kitchen module in the 3D view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  const canvas = await open3DWithKitchenPanel(page);

  // Place the wall cabinet first, while the canvas is still full width.
  await placeItem(page, 'Навесной шкафчик', await floorPoint(canvas, -200));

  // Placing it auto-selects it, which opens the Properties panel and
  // narrows the canvas. Turn off wall/neighbor snapping now (default on)
  // so the next item lands exactly where it's clicked instead of sliding
  // to the nearest wall.
  await page.getByLabel('Прилипание модулей к стене и соседу').uncheck();

  // Place the base cabinet against this now-stable, narrower canvas — it
  // stays at floor level, so this point remains valid for re-clicking it.
  const p2 = await floorPoint(canvas, 150);
  await placeItem(page, 'Нижняя тумба', p2);

  let furniture = await exportedFurniture(page);
  expect(furniture).toHaveLength(2);
  expect(furniture.map(f => f.catalogId).sort()).toEqual(['kitchen_base_cabinet', 'kitchen_wall_cabinet']);

  // A plain click on the module just placed must select it, not stamp
  // another copy — this is exactly the bug: placement mode used to stay
  // stuck on, so this click would have silently added a third item.
  await page.mouse.click(p2.x, p2.y);
  await expect(page.getByRole('heading', { name: 'Нижняя тумба Свойства' })).toBeVisible();
  furniture = await exportedFurniture(page);
  expect(furniture).toHaveLength(2);
  const cabinet = furniture.find(f => f.catalogId === 'kitchen_base_cabinet')!;

  // A plain click-drag (no prior double-click) must NOT move it — dragging
  // only arms after a double-click, same rule as the 2D editor.
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.move(p2.x + 60, p2.y, { steps: 5 });
  await page.mouse.up();
  furniture = await exportedFurniture(page);
  expect(furniture.find(f => f.catalogId === 'kitchen_base_cabinet')!.position).toEqual(cabinet.position);

  // Double-click to arm it, then drag — this must move it.
  await page.mouse.dblclick(p2.x, p2.y);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.move(p2.x + 120, p2.y, { steps: 10 });
  await page.mouse.up();
  furniture = await exportedFurniture(page);
  const moved = furniture.find(f => f.catalogId === 'kitchen_base_cabinet')!;
  expect(Math.hypot(moved.position.x - cabinet.position.x, moved.position.y - cabinet.position.y)).toBeGreaterThan(10);
  expect(furniture).toHaveLength(2); // dragging must not stamp a copy either

  // Delete the selected module.
  await page.keyboard.press('Delete');
  furniture = await exportedFurniture(page);
  expect(furniture.find(f => f.catalogId === 'kitchen_base_cabinet')).toBeUndefined();
  expect(furniture).toHaveLength(1);
  expect(furniture[0].catalogId).toBe('kitchen_wall_cabinet');

  expect(errors).toEqual([]);
});
