<script lang="ts">
  import { furnitureFinishes } from '$lib/utils/furnitureFinishes';
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import ItemDetailsPanel from './ItemDetailsPanel.svelte';
  import type { DetailTarget } from '$lib/models/types';
  import { catalogAssetUrl } from '$lib/utils/catalogAssetUrl';

  import { activeFloor, selectedElementId, selectedRoomId, updateWall, resizeWallLength, reverseWall, updateWindow, updateRoom, updateFurniture, detectedRoomsStore, updateColumn, updateBackgroundImage, setBackgroundImage, calibrationMode, calibrationPoints, updateTextAnnotation, toggleFurnitureLock, updateEntourageItem, removeElement, elevationWallId, attachFurnitureToWallAndNeighbor, detachFurnitureFromWallAndNeighbor } from '$lib/stores/project';
  import { wallLength as calcWallLength, MIN_WALL_LENGTH, type WallEndpoint } from '$lib/utils/wallEditing';
  import { openingOnWall } from '$lib/utils/wallProfiles';
  import { getEntourageDef } from '$lib/utils/entourageCatalog';
  import { wallColors } from '$lib/utils/materials';
  import { getCatalogItem, MODULE_WIDTHS_CM } from '$lib/utils/furnitureCatalog';
  import { projectSettings, formatLength, formatArea } from '$lib/stores/settings';
  import { t, td } from '$lib/i18n';
    import type { Floor, Wall, Window as Win, Room, FurnitureItem, Column, RoomCategory, TextAnnotation } from '$lib/models/types';
  import { getWallStartHeight, getWallEndHeight } from '$lib/models/types';

  let floor = $state<Floor | null>(null);
  let selId: string | null = $state(null);
  let selRoomId: string | null = $state(null);
  let detectedRooms: Room[] = $state([]);

  onDestroy(activeFloor.subscribe((f) => { floor = f; }));
  onDestroy(selectedElementId.subscribe((id) => { selId = id; }));
  onDestroy(selectedRoomId.subscribe((id) => { selRoomId = id; }));
  onDestroy(detectedRoomsStore.subscribe((rooms) => { detectedRooms = rooms; }));

  let settings = $state($projectSettings);
  onDestroy(projectSettings.subscribe((s) => { settings = s; }));

  function displayValue(cm: number): number {
    return settings.units === 'imperial' ? Math.round(cm / 2.54 * 10) / 10 : Math.round(cm * 1000) / 1000;
  }
  function inputToCm(value: number): number {
    return settings.units === 'imperial' ? value * 2.54 : value;
  }
  function unitLabel(): string {
    return settings.units === 'imperial' ? 'in' : 'cm';
  }

  let { is3D = false }: { is3D?: boolean } = $props();
  let wallSideTab = $state<'interior' | 'exterior'>('interior');
  let selectedWall = $derived(floor?.walls?.find(w => w.id === selId) ?? null);
  let selectedWindow = $derived(floor?.windows?.find(w => w.id === selId) ?? null);
  let selectedFurniture = $derived(floor?.furniture?.find(f => f.id === selId) ?? null);
  // A genuine cabinet module: its depth/height are fixed by its tier and its width
  // is picked from MODULE_WIDTHS_CM — appliances and freestanding items keep free dims.
  let isModuleItem = $derived(!!selectedFurniture && getCatalogItem(selectedFurniture.catalogId)?.module === true);
  let selectedColumn = $derived(floor?.columns?.find(c => c.id === selId) ?? null);
  let selectedTextAnnotation = $derived(floor?.textAnnotations?.find(t => t.id === selId) ?? null);
  let selectedEntourage = $derived(floor?.entourage?.find(en => en.id === selId) ?? null);
  let hasBgImage = $derived(!!floor?.backgroundImage);
  let selectedRoom = $derived(floor?.rooms?.find(r => r.id === selRoomId) ?? detectedRooms.find(r => r.id === selRoomId) ?? null);

  // Helper to get the parent wall for selected window
  let selectedWindowWall = $derived((selectedWindow && floor?.walls?.find(w => w.id === selectedWindow.wallId)) ?? null);

  let wallLength = $derived(selectedWall ? Math.round(calcWallLength(selectedWall) * 1000) / 1000 : 0);
  let fixedEndpoint = $state<WallEndpoint>('start');
  let wallLengthError = $state<string | null>(null);
  $effect(() => { void selId; fixedEndpoint = 'start'; wallLengthError = null; });


  // Calculate window distances  
  let windowDistFromA = $derived(selectedWindow && selectedWindowWall ? calcWallLength(selectedWindowWall) * selectedWindow.position : 0);
  let windowDistFromB = $derived(selectedWindow && selectedWindowWall ? calcWallLength(selectedWindowWall) * (1 - selectedWindow.position) : 0);

  function onWallLength(e: Event) {
    if (!selectedWall) return;
    const input = e.target as HTMLInputElement;
    const current = calcWallLength(selectedWall);
    if (!input.value.trim() || !input.validity.valid || !Number.isFinite(input.valueAsNumber)) {
      wallLengthError = get(t)('properties.wallLengthError');
    } else if (input.valueAsNumber !== displayValue(current)) {
      wallLengthError = resizeWallLength(selectedWall.id, inputToCm(input.valueAsNumber), fixedEndpoint);
    } else { wallLengthError = null; }
    input.value = String(displayValue(calcWallLength(selectedWall)));
  }

  /** Blank/invalid drafts leave geometry untouched; restore the saved value on blur. */
  function dimensionInput(e: Event, current: number, save: (cm: number) => void, zeroAllowed = false, max = Infinity) {
    const input = e.target as HTMLInputElement;
    const value = inputToCm(input.valueAsNumber);
    const valid = input.value.trim() && input.validity.valid && Number.isFinite(value) && (zeroAllowed ? value >= 0 : value > 0) && value <= max;
    if (valid && input.valueAsNumber !== displayValue(current)) save(value);
    else if (!valid && e.type === 'blur') input.value = String(displayValue(current));
  }
  function onWallThickness(e: Event) {
    if (selectedWall) dimensionInput(e, selectedWall.thickness, value => updateWall(selectedWall!.id, { thickness: value }));
  }
  let clippedOpenings = $derived.by(() => {
    if (!selectedWall || !floor) return false;
    const wall = selectedWall;
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    return floor.windows.filter(w => w.wallId === wall.id).map(w => ({ ...w, bottom: w.sillHeight ?? 90 })).some(item => {
      const rect = openingOnWall(length, getWallStartHeight(wall), getWallEndHeight(wall), item.position, item.width, item.bottom, item.height);
      return !rect || rect.right - rect.left < item.width - 0.01 || rect.top - rect.bottom < item.height - 0.01;
    });
  });
  function onWallStartHeight(e: Event) {
    if (selectedWall) dimensionInput(e, getWallStartHeight(selectedWall), value => updateWall(selectedWall!.id, { startHeight: value }), true);
  }
  function onWallEndHeight(e: Event) {
    if (selectedWall) dimensionInput(e, getWallEndHeight(selectedWall), value => updateWall(selectedWall!.id, { endHeight: value }), true);
  }
  function equalizeWallHeights() {
    if (!selectedWall) return;
    const startH = getWallStartHeight(selectedWall);
    updateWall(selectedWall.id, { startHeight: startH, endHeight: startH, height: startH });
  }
  function onWallColor(e: Event) {
    if (!selectedWall) return;
    updateWall(selectedWall.id, { color: (e.target as HTMLInputElement).value });
  }
  function onWindowType(e: Event) {
    if (!selectedWindow) return;
    updateWindow(selectedWindow.id, { type: (e.target as HTMLSelectElement).value as Win['type'] });
  }
  function onWindowWidth(e: Event) {
    if (selectedWindow) dimensionInput(e, selectedWindow.width, value => updateWindow(selectedWindow!.id, { width: value }));
  }
  function onWindowHeight(e: Event) {
    if (selectedWindow) dimensionInput(e, selectedWindow.height, value => updateWindow(selectedWindow!.id, { height: value }));
  }
  function onWindowSill(e: Event) {
    if (selectedWindow) dimensionInput(e, selectedWindow.sillHeight ?? 90, value => updateWindow(selectedWindow!.id, { sillHeight: value }), true);
  }

  // Furniture handlers
  function onFurnitureColor(color: string) {
    if (!selectedFurniture) return;
    updateFurniture(selectedFurniture.id, { color });
  }
  function onFurnitureWidth(e: Event) {
    if (!selectedFurniture) return;
    dimensionInput(e, selectedFurniture.width ?? getCatalogItem(selectedFurniture.catalogId)?.width ?? 100,
      value => updateFurniture(selectedFurniture!.id, { width: value }));
  }
  /** Module width is chosen from MODULE_WIDTHS_CM, already in cm — no unit round-trip needed. */
  function onModuleWidthSelect(e: Event) {
    if (!selectedFurniture) return;
    updateFurniture(selectedFurniture.id, { width: Number((e.target as HTMLSelectElement).value) });
  }
  function onFurnitureDepth(e: Event) {
    if (!selectedFurniture) return;
    dimensionInput(e, selectedFurniture.depth ?? getCatalogItem(selectedFurniture.catalogId)?.depth ?? 80,
      value => updateFurniture(selectedFurniture!.id, { depth: value }));
  }
  function onFurnitureHeight(e: Event) {
    if (!selectedFurniture) return;
    dimensionInput(e, selectedFurniture.height ?? getCatalogItem(selectedFurniture.catalogId)?.height ?? 80,
      value => updateFurniture(selectedFurniture!.id, { height: value }));
  }
  function onFurnitureElevation(e: Event) {
    if (!selectedFurniture) return;
    dimensionInput(e, selectedFurniture.elevation ?? 0,
      value => updateFurniture(selectedFurniture!.id, { elevation: value }), true);
  }
  function onFurnitureMaterial(e: Event) {
    if (!selectedFurniture) return;
    updateFurniture(selectedFurniture.id, { material: (e.target as HTMLSelectElement).value || undefined });
  }
  function onFurnitureRotation(e: Event) {
    if (!selectedFurniture) return;
    updateFurniture(selectedFurniture.id, { rotation: Number((e.target as HTMLInputElement).value) });
  }
  function resetFurnitureDefaults() {
    if (!selectedFurniture) return;
    updateFurniture(selectedFurniture.id, { color: undefined, width: undefined, depth: undefined, height: undefined, elevation: undefined, material: undefined });
  }

  // Window distance handlers
  function onWindowDistFromA(e: Event) {
    if (!selectedWindow || !selectedWindowWall) return;
    const length = calcWallLength(selectedWindowWall);
    if (!Number.isFinite(length) || length <= 0) return;
    dimensionInput(e, length * selectedWindow.position, value => updateWindow(selectedWindow!.id, { position: value / length }), true, length);
  }
  
  function onWindowDistFromB(e: Event) {
    if (!selectedWindow || !selectedWindowWall) return;
    const length = calcWallLength(selectedWindowWall);
    if (!Number.isFinite(length) || length <= 0) return;
    dimensionInput(e, length * (1 - selectedWindow.position), value => updateWindow(selectedWindow!.id, { position: 1 - value / length }), true, length);
  }
  let detailTarget = $derived.by((): DetailTarget | null => {
    if (!floor) return null;
    for (const [kind, item] of [['walls', selectedWall], ['windows', selectedWindow], ['furniture', selectedFurniture], ['rooms', selectedRoom]] as const) {
      if (item) return { floorId: floor.id, kind, id: item.id };
    }
    return null;
  });

  const columnColorPresets = [
    { id: 'white', color: '#ffffff' },
    { id: 'lightGray', color: '#d1d5db' },
    { id: 'concrete', color: '#999999' },
    { id: 'charcoal', color: '#374151' },
    { id: 'black', color: '#000000' },
    { id: 'cream', color: '#fffdd0' },
    { id: 'wood', color: '#8B6914' },
    { id: 'bronze', color: '#cd7f32' },
    { id: 'silver', color: '#c0c0c0' },
    { id: 'navy', color: '#1e3a8a' },
  ];

  function updateDetectedRoom(id: string, updates: Partial<{ name: string }>) {
    detectedRoomsStore.update(rooms => rooms.map(r => r.id === id ? { ...r, ...updates } : r));
  }

  function onRoomName(e: Event) {
    if (!selectedRoom) return;
    const name = (e.target as HTMLInputElement).value;
    updateRoom(selectedRoom.id, { name });
    updateDetectedRoom(selectedRoom.id, { name });
  }

  const roomTypes = [
    { id: 'living', label: 'Living Room', icon: '🛋️' },
    { id: 'bedroom', label: 'Bedroom', icon: '🛏️' },
    { id: 'kitchen', label: 'Kitchen', icon: '🍳' },
    { id: 'bathroom', label: 'Bathroom', icon: '🚿' },
    { id: 'dining', label: 'Dining Room', icon: '🍽️' },
    { id: 'office', label: 'Office', icon: '💻' },
    { id: 'hallway', label: 'Hallway', icon: '🚶' },
    { id: 'closet', label: 'Closet', icon: '👔' },
    { id: 'laundry', label: 'Laundry', icon: '🧺' },
    { id: 'garage', label: 'Garage', icon: '🚗' },
    { id: 'custom', label: 'Custom', icon: '✏️' },
  ];

  function onRoomType(e: Event) {
    if (!selectedRoom) return;
    const typeId = (e.target as HTMLSelectElement).value;
    const rt = roomTypes.find(t => t.id === typeId);
    if (rt && rt.id !== 'custom') {
      updateRoom(selectedRoom.id, { name: rt.label });
      updateDetectedRoom(selectedRoom.id, { name: rt.label });
    }
  }

  let selectedRoomType = $derived(() => {
    if (!selectedRoom) return 'custom';
    const match = roomTypes.find(t => t.label === selectedRoom!.name);
    return match ? match.id : 'custom';
  });

  const wallTexPaths: Record<string, string> = {
    'red-brick': catalogAssetUrl(`/textures/brick.webp`), 'exposed-brick': catalogAssetUrl(`/textures/exposed-brick.webp`),
    'stone': catalogAssetUrl(`/textures/stone.webp`), 'wood-panel': catalogAssetUrl(`/textures/wood-panel.webp`),
    'concrete-block': catalogAssetUrl(`/textures/concrete.webp`), 'subway-tile': catalogAssetUrl(`/textures/subway-tile.webp`),
  };

  let hasSelection = $derived(!!selectedWall || !!selectedWindow || !!selectedFurniture || !!selectedRoom || !!selectedColumn || !!selectedTextAnnotation || !!selectedEntourage || (!is3D && hasBgImage));
</script>

<!-- Right sidebar on md+; slides up as a bottom sheet on phones -->
<div class="{is3D ? 'w-80' : 'w-64'} shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-y-auto p-3 fixed md:static right-0 top-12 bottom-9 z-40 shadow-lg max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:w-full max-md:max-h-[45vh] max-md:border-l-0 max-md:border-t max-md:rounded-t-xl max-md:shadow-2xl" class:hidden={!hasSelection}>
  {#if selectedWall}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-gray-200 rounded flex items-center justify-center text-xs">▭</span>
      {$t('properties.wallTitle')}
    </h3>
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.length')} ({unitLabel()})</span>
        <input type="number" value={displayValue(wallLength)} onblur={onWallLength} onkeydown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} min={settings.units === 'imperial' ? MIN_WALL_LENGTH / 2.54 : MIN_WALL_LENGTH} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.keepFixed')}</span>
        <select bind:value={fixedEndpoint} class="w-full px-2 py-1 border border-gray-200 rounded text-sm">
          <option value="start">{$t('properties.startA')}</option>
          <option value="end">{$t('properties.endB')}</option>
        </select>
      </label>
      <p class="text-xs text-gray-500">{$t('properties.jointCornersHint')}</p>
      {#if wallLengthError}<p role="alert" class="text-xs text-red-700">{wallLengthError}</p>{/if}
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.thickness')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedWall.thickness)} oninput={onWallThickness} onblur={onWallThickness} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <div class="grid grid-cols-2 gap-2">
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.startHeight')} ({unitLabel()})</span>
          <input type="number" value={displayValue(getWallStartHeight(selectedWall))} min="0" step="any" oninput={onWallStartHeight} onblur={onWallStartHeight} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
        </label>
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.endHeight')} ({unitLabel()})</span>
          <input type="number" value={displayValue(getWallEndHeight(selectedWall))} min="0" step="any" oninput={onWallEndHeight} onblur={onWallEndHeight} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
        </label>
      </div>
      {#if clippedOpenings}
        <p role="status" class="text-xs text-amber-800 bg-amber-50 rounded p-2">{$t('properties.openingsDontFit')}</p>
      {/if}
      <div class="flex items-center gap-2">
        {#if getWallStartHeight(selectedWall) !== getWallEndHeight(selectedWall)}
          <button
            onclick={equalizeWallHeights}
            class="text-xs text-blue-600 hover:text-blue-800 underline flex items-center gap-1"
          >
            {$t('properties.equalize', { val: `${displayValue(getWallStartHeight(selectedWall))} ${unitLabel()}` })}
          </button>
        {/if}
        <button
          onclick={() => { if (selectedWall) reverseWall(selectedWall.id); }}
          class="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 px-2 py-0.5 rounded flex items-center gap-1 ml-auto"
          title={$t('properties.reverseWallTitle')}
        >
          {$t('properties.reverseDirection')}
        </button>
      </div>
      <button
        class="w-full py-1.5 text-sm rounded-md bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors flex items-center justify-center gap-1.5"
        onclick={() => { if (selectedWall) elevationWallId.set(selectedWall.id); }}
        title={$t('properties.viewElevationTitle')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="1"/><line x1="3" y1="18" x2="21" y2="18"/><rect x="7" y="9" width="4" height="4"/><rect x="14" y="10" width="3" height="8"/></svg>
        {$t('topbar.elevation')}
      </button>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500">{$t('properties.curved')}</span>
        <button
          class="px-2 py-0.5 text-xs rounded {selectedWall.curvePoint ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-gray-100 text-gray-500 border border-gray-200'}"
          onclick={() => {
            if (selectedWall) {
              if (selectedWall.curvePoint) {
                updateWall(selectedWall.id, { curvePoint: undefined });
              } else {
                // Set curve point to offset midpoint
                const mx = (selectedWall.start.x + selectedWall.end.x) / 2;
                const my = (selectedWall.start.y + selectedWall.end.y) / 2;
                const dx = selectedWall.end.x - selectedWall.start.x;
                const dy = selectedWall.end.y - selectedWall.start.y;
                const len = Math.hypot(dx, dy) || 1;
                updateWall(selectedWall.id, { curvePoint: { x: mx + (-dy / len) * 60, y: my + (dx / len) * 60 } });
              }
            }
          }}
        >
          {selectedWall.curvePoint ? $t('properties.curveOn') : $t('properties.curveOff')}
        </button>
      </div>
      <!-- Wall Material Tabs: Interior / Exterior -->
      <div>
        <div class="flex border-b border-gray-200 mb-3">
          <button
            class="flex-1 py-1.5 text-xs font-medium border-b-2 transition-colors {wallSideTab === 'interior' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'}"
            onclick={() => wallSideTab = 'interior'}
          >{$t('properties.interior')}</button>
          <button
            class="flex-1 py-1.5 text-xs font-medium border-b-2 transition-colors {wallSideTab === 'exterior' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'}"
            onclick={() => wallSideTab = 'exterior'}
          >{$t('properties.exterior')}</button>
        </div>
        {#if wallSideTab === 'interior'}
          {@const sideColor = selectedWall.interiorColor || selectedWall.color}
          {@const sideTex = selectedWall.interiorTexture === 'none' ? undefined : (selectedWall.interiorTexture || selectedWall.texture)}
          <div class="space-y-2">
            <span class="text-xs text-gray-500">{$t('properties.color')}</span>
            <div class="grid grid-cols-6 gap-1.5">
              {#each wallColors as wc}
                <button
                  class="w-7 h-7 rounded-md border-2 hover:border-gray-300 transition-colors {sideColor === wc.color ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200'}"
                  style="background-color: {wc.color}"
                  title={td('wallcolor.' + wc.id)}
                  onclick={() => { if (selectedWall) updateWall(selectedWall.id, { interiorColor: wc.color }); }}
                ></button>
              {/each}
            </div>
            <label class="flex items-center gap-2">
              <span class="text-xs text-gray-500">{$t('properties.customLabel')}</span>
              <input type="color" value={sideColor} oninput={(e) => { if (selectedWall) updateWall(selectedWall.id, { interiorColor: (e.target as HTMLInputElement).value }); }} class="w-8 h-6 rounded border border-gray-200 cursor-pointer" />
            </label>
            <span class="text-xs text-gray-500">{$t('properties.texture')}</span>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                class="p-1.5 rounded-md border-2 text-[10px] text-center h-14 {!sideTex ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300'}"
                onclick={() => { if (selectedWall) updateWall(selectedWall.id, { interiorTexture: 'none' }); }}
              >{$t('properties.none')}</button>
              {#each wallColors.filter(wc => wc.texture) as wc}
                {@const texPath = wallTexPaths[wc.id] ?? ''}
                <button
                  class="rounded-md border-2 text-[10px] text-center h-14 flex flex-col items-center justify-end overflow-hidden relative {sideTex === wc.id ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300'}"
                  style={texPath ? `background-image: url(${texPath}); background-size: cover; background-position: center;` : `background-color: ${wc.color}20`}
                  onclick={() => { if (selectedWall) updateWall(selectedWall.id, { interiorTexture: wc.id, interiorColor: wc.color }); }}
                ><span class="bg-white/80 backdrop-blur-sm rounded px-1 py-0.5 mb-0.5 text-gray-700">{td('wallcolor.' + wc.id)}</span></button>
              {/each}
            </div>
          </div>
        {:else}
          {@const sideColor = selectedWall.exteriorColor || selectedWall.color}
          {@const sideTex = selectedWall.exteriorTexture === 'none' ? undefined : (selectedWall.exteriorTexture || selectedWall.texture)}
          <div class="space-y-2">
            <span class="text-xs text-gray-500">{$t('properties.color')}</span>
            <div class="grid grid-cols-6 gap-1.5">
              {#each wallColors as wc}
                <button
                  class="w-7 h-7 rounded-md border-2 hover:border-gray-300 transition-colors {sideColor === wc.color ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200'}"
                  style="background-color: {wc.color}"
                  title={td('wallcolor.' + wc.id)}
                  onclick={() => { if (selectedWall) updateWall(selectedWall.id, { exteriorColor: wc.color }); }}
                ></button>
              {/each}
            </div>
            <label class="flex items-center gap-2">
              <span class="text-xs text-gray-500">{$t('properties.customLabel')}</span>
              <input type="color" value={sideColor} oninput={(e) => { if (selectedWall) updateWall(selectedWall.id, { exteriorColor: (e.target as HTMLInputElement).value }); }} class="w-8 h-6 rounded border border-gray-200 cursor-pointer" />
            </label>
            <span class="text-xs text-gray-500">{$t('properties.texture')}</span>
            <div class="grid grid-cols-3 gap-1.5">
              <button
                class="p-1.5 rounded-md border-2 text-[10px] text-center h-14 {!sideTex ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300'}"
                onclick={() => { if (selectedWall) updateWall(selectedWall.id, { exteriorTexture: 'none' }); }}
              >{$t('properties.none')}</button>
              {#each wallColors.filter(wc => wc.texture) as wc}
                {@const texPath = wallTexPaths[wc.id] ?? ''}
                <button
                  class="rounded-md border-2 text-[10px] text-center h-14 flex flex-col items-center justify-end overflow-hidden relative {sideTex === wc.id ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200 hover:border-gray-300'}"
                  style={texPath ? `background-image: url(${texPath}); background-size: cover; background-position: center;` : `background-color: ${wc.color}20`}
                  onclick={() => { if (selectedWall) updateWall(selectedWall.id, { exteriorTexture: wc.id, exteriorColor: wc.color }); }}
                ><span class="bg-white/80 backdrop-blur-sm rounded px-1 py-0.5 mb-0.5 text-gray-700">{td('wallcolor.' + wc.id)}</span></button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>

  {:else if selectedWindow}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-cyan-100 rounded flex items-center justify-center text-xs">🪟</span>
      {$t('properties.windowTitle')}
    </h3>
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.type')}</span>
        <select value={selectedWindow.type ?? 'standard'} onchange={onWindowType} class="w-full px-2 py-1 border border-gray-200 rounded text-sm">
          <option value="standard">{$t('window.standard')}</option>
          <option value="fixed">{$t('window.fixed')}</option>
          <option value="casement">{$t('window.casement')}</option>
          <option value="sliding">{$t('window.sliding')}</option>
          <option value="bay">{$t('window.bay')}</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.width')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedWindow.width)} oninput={onWindowWidth} onblur={onWindowWidth} step="any" min="0" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.distFromA')} ({unitLabel()})</span>
        <input type="number" value={displayValue(windowDistFromA)} oninput={onWindowDistFromA} onblur={onWindowDistFromA} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.distFromB')} ({unitLabel()})</span>
        <input type="number" value={displayValue(windowDistFromB)} oninput={onWindowDistFromB} onblur={onWindowDistFromB} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.height')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedWindow.height)} oninput={onWindowHeight} onblur={onWindowHeight} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.sillHeight')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedWindow.sillHeight)} oninput={onWindowSill} onblur={onWindowSill} step="any" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
    </div>

  {:else if selectedFurniture}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-purple-100 rounded flex items-center justify-center text-xs">
        {getCatalogItem(selectedFurniture.catalogId)?.icon ?? '🪑'}
      </span>
      {getCatalogItem(selectedFurniture.catalogId) ? td('catalog.' + selectedFurniture.catalogId) : td('catalog.unknown')} {$t('properties.suffixProperties')}
      <button
        onclick={() => { if (selectedFurniture) toggleFurnitureLock(selectedFurniture.id); }}
        class="ml-auto px-1.5 py-0.5 rounded text-xs border transition-colors {selectedFurniture.locked ? 'bg-amber-100 border-amber-400 text-amber-700' : 'border-gray-200 hover:bg-gray-50 text-gray-500'}"
        title={selectedFurniture.locked ? $t('properties.unlock') : $t('properties.lock')}
      >{selectedFurniture.locked ? $t('properties.lockedBadge') : '🔓'}</button>
    </h3>
    {#if selectedFurniture.catalogId === 'imported_object'}
      <p class="mb-3 text-xs text-gray-500 break-words">{$t('properties.importedObjectHint', { category: selectedFurniture.sourceCategory || $t('category.Unknown') })}</p>
    {:else if selectedFurniture.catalogId === 'stairs'}
      <p class="mb-3 text-xs text-gray-500">{$t('properties.stairsHint')}</p>
    {/if}
    <div class="space-y-3">
      <!-- Snap to wall/neighbor -->
      <label class="flex items-center justify-between cursor-pointer" title={$t('properties.snapToggleTitle')}>
        <span class="text-xs text-gray-500">{$t('settings.snapModules')}</span>
        <input
          type="checkbox"
          checked={settings.snapToWalls}
          onchange={(e) => projectSettings.update(s => ({ ...s, snapToWalls: (e.target as HTMLInputElement).checked }))}
          class="w-9 h-5 rounded-full appearance-none cursor-pointer bg-gray-300 checked:bg-slate-700 relative transition-colors
            before:content-[''] before:absolute before:w-4 before:h-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 before:transition-transform checked:before:translate-x-4"
        />
      </label>

      <!-- Color -->
      <div>
        <div class="flex items-center gap-1 mb-2">
          <span class="text-xs text-gray-500">{$t('properties.color')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="9" cy="9" r="2"/>
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
          </svg>
        </div>
        <div class="grid grid-cols-5 gap-1.5 mb-2">
          {#each ['#ffffff', '#f5f5dc', '#d2b48c', '#daa520', '#8b4513', '#696969', '#191970', '#000000', '#dc143c', '#228b22'] as color}
            <button
              class="w-6 h-6 rounded border-2 hover:border-gray-300 transition-colors {(selectedFurniture.color ?? getCatalogItem(selectedFurniture.catalogId)?.color) === color ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200'}"
              style="background-color: {color}"
              title={$t('properties.colorSwatchTitle', { color })}
              onclick={() => onFurnitureColor(color)}
            ></button>
          {/each}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">{$t('properties.customLabel')}</span>
          <input
            type="color" 
            value={selectedFurniture.color ?? getCatalogItem(selectedFurniture.catalogId)?.color ?? '#888888'} 
            oninput={(e) => onFurnitureColor((e.target as HTMLInputElement).value)} 
            class="w-8 h-6 rounded border border-gray-200 cursor-pointer" 
          />
        </div>
      </div>
      
      <!-- Dimensions -->
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.width')} ({unitLabel()})</span>
        {#if isModuleItem}
          <select
            value={selectedFurniture.width ?? getCatalogItem(selectedFurniture.catalogId)?.width ?? MODULE_WIDTHS_CM[0]}
            onchange={onModuleWidthSelect}
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm bg-white"
          >
            {#each MODULE_WIDTHS_CM as w}
              <option value={w}>{displayValue(w)} {unitLabel()}</option>
            {/each}
          </select>
        {:else}
          <input
            type="number"
            value={displayValue(selectedFurniture.width ?? getCatalogItem(selectedFurniture.catalogId)?.width ?? 100)}
            oninput={onFurnitureWidth} onblur={onFurnitureWidth} min={settings.units === 'imperial' ? 1 / 2.54 : 1} step="any"
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
          />
        {/if}
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.depth')} ({unitLabel()})</span>
        {#if isModuleItem}
          <input
            type="number" disabled
            value={displayValue(selectedFurniture.depth ?? getCatalogItem(selectedFurniture.catalogId)?.depth ?? 80)}
            title={$t('properties.setByTier')}
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
          />
        {:else}
          <input
            type="number"
            value={displayValue(selectedFurniture.depth ?? getCatalogItem(selectedFurniture.catalogId)?.depth ?? 80)}
            oninput={onFurnitureDepth} onblur={onFurnitureDepth} min={settings.units === 'imperial' ? 1 / 2.54 : 1} step="any"
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
          />
        {/if}
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.height')} ({unitLabel()})</span>
        {#if isModuleItem}
          <input
            type="number" disabled
            value={displayValue(selectedFurniture.height ?? getCatalogItem(selectedFurniture.catalogId)?.height ?? 80)}
            title={$t('properties.setByTier')}
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
          />
        {:else}
          <input
            type="number"
            value={displayValue(selectedFurniture.height ?? getCatalogItem(selectedFurniture.catalogId)?.height ?? 80)}
            oninput={onFurnitureHeight} onblur={onFurnitureHeight} min={settings.units === 'imperial' ? 1 / 2.54 : 1} step="any"
            class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
          />
        {/if}
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.heightAboveFloor')} ({unitLabel()})</span>
        <input
          type="number"
          value={displayValue(selectedFurniture.elevation ?? 0)}
          oninput={onFurnitureElevation} onblur={onFurnitureElevation} min="0" step="any"
          class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
        />
      </label>

      <!-- Material -->
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.material')}</span>
        <select
          value={selectedFurniture.material ?? ''}
          onchange={onFurnitureMaterial}
          class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
        >
          <option value="">{$t('properties.originalMaterials')}</option>
          {#if selectedFurniture.material && !Object.hasOwn(furnitureFinishes, selectedFurniture.material)}
            <option value={selectedFurniture.material}>{$t('properties.materialRetained', { material: selectedFurniture.material })}</option>
          {/if}
          {#each Object.keys(furnitureFinishes) as finish}<option value={finish}>{td('material.' + finish)}</option>{/each}
        </select>
      </label>

      <p class="text-xs text-gray-500">{$t('properties.colorMaterialHint')}</p>

      <!-- Rotation -->
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.rotation')}</span>
        <input
          type="number"
          value={Math.round(selectedFurniture.rotation * 100) / 100}
          oninput={onFurnitureRotation}
          class="w-full px-2 py-1 border border-gray-200 rounded text-sm"
        />
      </label>

      <!-- Rotate / Flip controls -->
      <div class="flex gap-1">
        <button
          onclick={() => { if (selectedFurniture) updateFurniture(selectedFurniture.id, { rotation: selectedFurniture.rotation - 90 }); }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.rotateLeftTitle')}
        >↺ 90°</button>
        <button
          onclick={() => { if (selectedFurniture) updateFurniture(selectedFurniture.id, { rotation: selectedFurniture.rotation + 90 }); }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.rotateRightTitle')}
        >↻ 90°</button>
      </div>

      <!-- Attach / detach from wall & neighbor -->
      <div class="flex gap-1">
        <button
          onclick={() => { if (selectedFurniture) attachFurnitureToWallAndNeighbor(selectedFurniture.id); }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.attachTitle')}
        >{$t('properties.attach')}</button>
        <button
          onclick={() => { if (selectedFurniture) detachFurnitureFromWallAndNeighbor(selectedFurniture.id); }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.detachTitle')}
        >{$t('properties.detach')}</button>
      </div>
      <div class="flex gap-1">
        <button
          onclick={() => { if (selectedFurniture) { const s = selectedFurniture.scale; updateFurniture(selectedFurniture.id, { scale: { x: s.x * -1, y: s.y, z: s.z } }); } }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.flipHorizontalTitle')}
        >{$t('properties.flipH')}</button>
        <button
          onclick={() => { if (selectedFurniture) { const s = selectedFurniture.scale; updateFurniture(selectedFurniture.id, { scale: { x: s.x, y: s.y * -1, z: s.z } }); } }}
          class="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm hover:bg-gray-50 transition-colors"
          title={$t('properties.flipVerticalTitle')}
        >{$t('properties.flipV')}</button>
      </div>

      <!-- Reset button -->
      <button
        onclick={resetFurnitureDefaults}
        class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors"
      >
        {$t('properties.resetDefaults')}
      </button>

      <!-- Delete button -->
      <button
        onclick={() => { if (selectedFurniture) { removeElement(selectedFurniture.id); selectedElementId.set(null); } }}
        class="w-full px-2 py-1.5 border border-red-200 text-red-600 rounded text-sm hover:bg-red-50 transition-colors"
      >
        {$t('properties.delete')}
      </button>
    </div>

  {:else if selectedRoom}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-green-100 rounded flex items-center justify-center text-xs">⬜</span>
      {$t('properties.roomTitle')}
    </h3>
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.roomType')}</span>
        <select value={selectedRoomType()} onchange={onRoomType} class="w-full px-2 py-1 border border-gray-200 rounded text-sm">
          {#each roomTypes as rt}
            <option value={rt.id}>{rt.icon} {td('roomtype.' + rt.id)}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.roomName')}</span>
        <input type="text" value={selectedRoom.name} oninput={onRoomName} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.roomCategory')}</span>
        <select value={selectedRoom.roomType ?? 'indoor'} onchange={(e) => { if (selectedRoom) { const v = (e.target as HTMLSelectElement).value as RoomCategory; updateRoom(selectedRoom.id, { roomType: v }); updateDetectedRoom(selectedRoom.id, { roomType: v } as any); } }} class="w-full px-2 py-1 border border-gray-200 rounded text-sm">
          <option value="indoor">{$t('roomcat.indoor')}</option>
          <option value="outdoor">{$t('roomcat.outdoor')}</option>
          <option value="garage">{$t('roomcat.garage')}</option>
          <option value="utility">{$t('roomcat.utility')}</option>
        </select>
      </label>
      <div>
        <span class="text-xs text-gray-500">{$t('properties.area')}</span>
        <p class="text-sm text-gray-700">{formatArea(selectedRoom.area, settings.units)}</p>
      </div>
    </div>

  {:else if selectedEntourage}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-green-100 rounded flex items-center justify-center text-xs">🌳</span>
      {$t('buildpanel.entourage')}
    </h3>
    <div class="space-y-3">
      <div>
        <span class="text-xs text-gray-500">{$t('properties.symbol')}</span>
        <p class="text-sm text-gray-700">{getEntourageDef(selectedEntourage.defId) ? td('entourage.' + selectedEntourage.defId) : $t('properties.customImage')}</p>
      </div>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.width')} ({unitLabel()})</span>
        <input type="number" value={displayValue(Math.round(selectedEntourage.width))} oninput={(e) => { if (selectedEntourage) updateEntourageItem(selectedEntourage.id, { width: Math.max(1, inputToCm(Number((e.target as HTMLInputElement).value)) || 1) }); }} min="1" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.rotation')}</span>
        <input type="number" value={Math.round(selectedEntourage.rotation || 0)} oninput={(e) => { if (selectedEntourage) updateEntourageItem(selectedEntourage.id, { rotation: Number((e.target as HTMLInputElement).value) || 0 }); }} step="15" class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.opacity', { pct: Math.round((selectedEntourage.opacity ?? 1) * 100) })}</span>
        <input type="range" min="0.1" max="1" step="0.05" value={selectedEntourage.opacity ?? 1} oninput={(e) => { if (selectedEntourage) updateEntourageItem(selectedEntourage.id, { opacity: Number((e.target as HTMLInputElement).value) }); }} class="w-full" />
      </label>
      <div class="flex gap-2">
        <button onclick={() => { if (selectedEntourage) updateEntourageItem(selectedEntourage.id, { locked: !selectedEntourage.locked }); }} class="flex-1 px-2 py-1.5 border rounded text-sm transition-colors {selectedEntourage.locked ? 'bg-amber-50 border-amber-300 text-amber-700' : 'border-gray-200 hover:bg-gray-50'}">{selectedEntourage.locked ? $t('properties.lockedBadge') : $t('properties.unlockedBadge')}</button>
        <button onclick={() => { if (selectedEntourage) { removeElement(selectedEntourage.id); selectedElementId.set(null); } }} class="flex-1 px-2 py-1.5 border border-red-200 text-red-600 rounded text-sm hover:bg-red-50 transition-colors">{$t('properties.delete')}</button>
      </div>
    </div>

  {:else if selectedColumn}
    <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      <span class="w-6 h-6 bg-gray-200 rounded flex items-center justify-center text-xs">🏛️</span>
      {$t('properties.columnTitle')}
    </h3>
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.shape')}</span>
        <div class="flex gap-2">
          <button onclick={() => updateColumn(selectedColumn!.id, { shape: 'round' })} class="flex-1 px-2 py-1.5 border rounded text-sm transition-colors {selectedColumn.shape === 'round' ? 'bg-blue-100 border-blue-400 text-blue-700' : 'border-gray-200 hover:bg-gray-50'}">{$t('properties.round')}</button>
          <button onclick={() => updateColumn(selectedColumn!.id, { shape: 'square' })} class="flex-1 px-2 py-1.5 border rounded text-sm transition-colors {selectedColumn.shape === 'square' ? 'bg-blue-100 border-blue-400 text-blue-700' : 'border-gray-200 hover:bg-gray-50'}">{$t('properties.square')}</button>
        </div>
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{selectedColumn.shape === 'round' ? $t('properties.diameter') : $t('properties.sideLength')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedColumn.diameter)} min="10" max="200" oninput={(e) => updateColumn(selectedColumn!.id, { diameter: inputToCm(Number((e.target as HTMLInputElement).value)) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.height')} ({unitLabel()})</span>
        <input type="number" value={displayValue(selectedColumn.height)} min="50" max="1000" oninput={(e) => updateColumn(selectedColumn!.id, { height: inputToCm(Number((e.target as HTMLInputElement).value)) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <div>
        <span class="text-xs text-gray-500 mb-1.5 block">{$t('properties.color')}</span>
        <div class="grid grid-cols-5 gap-1.5 mb-2">
          {#each columnColorPresets as preset}
            <button
              class="w-7 h-7 rounded-md border-2 hover:border-gray-300 transition-colors {selectedColumn.color === preset.color ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200'}"
              style="background-color: {preset.color}"
              title={td('columncolor.' + preset.id)}
              onclick={() => updateColumn(selectedColumn!.id, { color: preset.color })}
            ></button>
          {/each}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">{$t('properties.customLabel')}</span>
          <input type="color" value={selectedColumn.color} oninput={(e) => updateColumn(selectedColumn!.id, { color: (e.target as HTMLInputElement).value })} class="w-8 h-6 rounded border border-gray-200 cursor-pointer" />
        </div>
      </div>
      {#if selectedColumn.shape === 'square'}
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.rotation')}</span>
          <input type="number" value={selectedColumn.rotation} oninput={(e) => updateColumn(selectedColumn!.id, { rotation: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
        </label>
      {/if}
    </div>
  {:else if selectedTextAnnotation}
    <div class="space-y-3">
      <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span class="w-6 h-6 bg-emerald-100 rounded flex items-center justify-center text-xs">🏷️</span>
        {$t('properties.textAnnotationTitle')}
      </h3>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.text')}</span>
        <input type="text" value={selectedTextAnnotation.text} oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { text: (e.target as HTMLInputElement).value })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.fontSize')}</span>
        <input type="number" value={selectedTextAnnotation.fontSize} min="8" max="72" oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { fontSize: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.color')}</span>
        <div class="flex items-center gap-2">
          <input type="color" value={selectedTextAnnotation.color} oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { color: (e.target as HTMLInputElement).value })} class="w-8 h-6 rounded border border-gray-200 cursor-pointer" />
          <span class="text-xs text-gray-400">{selectedTextAnnotation.color}</span>
        </div>
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.rotation')}</span>
        <input type="number" value={selectedTextAnnotation.rotation} oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { rotation: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.x')}</span>
        <input type="number" value={Math.round(selectedTextAnnotation.x)} oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { x: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
      <label class="block">
        <span class="text-xs text-gray-500">{$t('properties.y')}</span>
        <input type="number" value={Math.round(selectedTextAnnotation.y)} oninput={(e) => updateTextAnnotation(selectedTextAnnotation!.id, { y: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
      </label>
    </div>
  {/if}

  {#if detailTarget}
    {#key `${detailTarget.floorId}:${detailTarget.kind}:${detailTarget.id}`}
      <ItemDetailsPanel target={detailTarget} />
    {/key}
  {/if}

  <!-- Background Image Controls (always show when bg image exists) -->
  {#if hasBgImage && floor?.backgroundImage}
    <div class="mt-4 pt-3 border-t border-gray-200">
      <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span class="w-6 h-6 bg-blue-100 rounded flex items-center justify-center text-xs">🖼️</span>
        {$t('properties.backgroundImageTitle')}
      </h3>
      <div class="space-y-3">
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.opacityPlain')}</span>
          <input type="range" min="0.05" max="1" step="0.05" value={floor.backgroundImage.opacity} oninput={(e) => updateBackgroundImage({ opacity: Number((e.target as HTMLInputElement).value) })} class="w-full" />
        </label>
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.scale')}</span>
          <input type="range" min="0.1" max="5" step="0.05" value={floor.backgroundImage.scale} oninput={(e) => updateBackgroundImage({ scale: Number((e.target as HTMLInputElement).value) })} class="w-full" />
        </label>
        <label class="block">
          <span class="text-xs text-gray-500">{$t('properties.rotationPlain')}</span>
          <input type="number" value={floor.backgroundImage.rotation} oninput={(e) => updateBackgroundImage({ rotation: Number((e.target as HTMLInputElement).value) })} class="w-full px-2 py-1 border border-gray-200 rounded text-sm" />
        </label>
        <div class="flex gap-2">
          <button
            onclick={() => updateBackgroundImage({ locked: !floor!.backgroundImage!.locked })}
            class="flex-1 px-2 py-1.5 border rounded text-sm {floor.backgroundImage.locked ? 'bg-amber-100 border-amber-400 text-amber-700' : 'border-gray-200 hover:bg-gray-50'}"
          >{floor.backgroundImage.locked ? $t('properties.lockedBadge') : $t('properties.unlockedBadge')}</button>
          <button
            onclick={() => { calibrationPoints.set([]); calibrationMode.set(true); }}
            class="flex-1 px-2 py-1.5 border rounded text-sm border-gray-200 hover:bg-gray-50"
          >{$t('properties.setScale')}</button>
        </div>
        <button
          onclick={() => setBackgroundImage(undefined)}
          class="w-full px-2 py-1.5 border border-red-300 rounded text-sm text-red-600 hover:bg-red-50"
        >{$t('properties.removeImage')}</button>
      </div>
    </div>
  {/if}
</div>
