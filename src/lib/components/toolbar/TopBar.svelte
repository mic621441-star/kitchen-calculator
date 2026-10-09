<script lang="ts">
  import { modalDialog, hasOpenModal } from '$lib/utils/modalDialog';
  import { openProject } from '$lib/services/projectOpening';
  import { saveConflict, savingCopy, saveCurrentAsCopy } from '$lib/stores/saveStatus';
  import ImportError from '$lib/components/ImportError.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import { orderedFloors } from '$lib/utils/floors';
  import type { FloorSeed } from '$lib/stores/project';
  import { currentProject, viewMode, undo, redo, addFloor, removeFloor, setActiveFloor, updateProjectName, createDefaultProject, snapEnabled, canvasZoom, panMode, showFurnitureStore, layerVisibility, activeFloor, selectedElementId, elevationWallId, elevationPickMode } from '$lib/stores/project';
  import { get } from 'svelte/store';
  import type { Floor } from '$lib/models/types';
  import { exportAsPNG, exportAsJSON, exportAsSVG, exportPDF } from '$lib/utils/export';
  import { exportDXF, exportDWG } from '$lib/utils/cadExport';
  import { createProjectFromRoomPlan, extractRoomJsonFromZip, isRoomPlanJson } from '$lib/utils/roomplanImport';
  import SettingsDialog from './SettingsDialog.svelte';
  import AreaSummaryPanel from '$lib/components/sidebar/AreaSummaryPanel.svelte';
  import { saveState, saveError, lastSavedAt, manualSave, autoSave, initAutoSave } from '$lib/stores/saveStatus';
  import { initVersionHistory, stopVersionHistory, snapshotOnAction } from '$lib/stores/versionHistory';
  import VersionHistoryPanel from './VersionHistoryPanel.svelte';
  import { locale, t } from '$lib/i18n';

  const openingLifetime = new AbortController();
  onDestroy(() => openingLifetime.abort());

  let importError = $state<string | null>(null);
  let packageError = $state<string | null>(null);

  let settingsOpen = $state(false);
  let areaOpen = $state(false);
  let versionHistoryOpen = $state(false);

  let projectName = $state('');
  let mode = $state<'2d' | '3d'>('2d');
  let floors: Floor[] = $state([]);
  let activeFloorId = $state('');
  let editingName = $state(false);
  let exportOpen = $state(false);
  import { triggerTip } from '$lib/stores/onboarding.svelte';
  let snapOn = $state(true);
  let exportRef: HTMLDivElement;
  // Mobile (< md) overflow menu for secondary actions
  let moreOpen = $state(false);
  let moreRef: HTMLDivElement | undefined = $state();
  // Floor-seed menu on the desktop + button
  let floorMenuOpen = $state(false);
  let floorMenuRef: HTMLDivElement | undefined = $state();

  onDestroy(currentProject.subscribe((p) => {
    if (p) {
      projectName = p.name;
      floors = orderedFloors(p.floors).map(entry => entry.floor);
      activeFloorId = p.activeFloorId;
    }
  }));
  onDestroy(viewMode.subscribe((m) => { mode = m; }));

  function setMode(m: '2d' | '3d') {
    viewMode.set(m);
  }

  /** Switch the 2D canvas area to the integrated elevation view.
   *  With a wall selected it opens that wall; otherwise it stays in Plan and
   *  arms pick mode — the next wall clicked in the canvas opens its elevation.
   *  In 3D this switches back to 2D first. */
  function enterElevation() {
    if (mode === '3d') viewMode.set('2d');
    const floor = get(activeFloor);
    const selId = get(selectedElementId);
    const wall = selId ? floor?.walls.find((w) => w.id === selId) : undefined;
    if (wall) {
      elevationPickMode.set(false);
      selectedElementId.set(wall.id);
      elevationWallId.set(wall.id);
    } else {
      // No wall selected — prompt the user to pick one on the plan canvas
      elevationPickMode.update((v) => !v); // pressing again cancels
    }
    moreOpen = false;
  }

  /** Return the 2D canvas area to the plan view */
  function exitElevation() {
    elevationWallId.set(null);
    elevationPickMode.set(false);
    moreOpen = false;
  }

  /** Mobile overflow item: toggle between plan and elevation */
  function toggleElevationView() {
    if (get(elevationWallId)) exitElevation();
    else enterElevation();
  }

  function onNameBlur() {
    editingName = false;
    updateProjectName(projectName);
  }

  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  }

  function onAddFloor(seed: FloorSeed = 'outer') {
    addFloor(undefined, seed);
    floorMenuOpen = false;
    moreOpen = false;
  }

  function onRemoveFloor(id: string) {
    if (floors.length <= 1) return;
    removeFloor(id);
  }

  async function save() {
    await manualSave();
  }

  // Relative time for tooltip
  let lastSavedText = $state('');
  let lastSavedTime: Date | null = $state(null);
  onDestroy(lastSavedAt.subscribe(v => { lastSavedTime = v; updateLastSavedText(); }));

  function updateLastSavedText() {
    if (!lastSavedTime) { lastSavedText = ''; return; }
    const diff = Math.floor((Date.now() - lastSavedTime.getTime()) / 1000);
    const tr = get(t);
    if (diff < 5) lastSavedText = tr('topbar.lastSavedJustNow');
    else if (diff < 60) lastSavedText = tr('topbar.lastSavedSecondsAgo', { s: diff });
    else if (diff < 3600) lastSavedText = tr('topbar.lastSavedMinutesAgo', { m: Math.floor(diff / 60) });
    else lastSavedText = tr('topbar.lastSavedHoursAgo', { h: Math.floor(diff / 3600) });
  }

  function onExport2DPNG() {
    const p = get(currentProject);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (canvas) exportAsPNG(canvas, p ?? undefined);
    exportOpen = false;
  }

  function onExport3DPNG() {
    const p = get(currentProject);
    const name = p?.name || 'floorplan';
    // Switch to 3D, wait a tick, then screenshot
    const oldMode = mode;
    viewMode.set('3d');
    setTimeout(() => {
      const c = document.querySelector('.w-full.h-full canvas, div canvas') as HTMLCanvasElement;
      if (c) {
        c.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `${name}-3d.png`; a.click();
            URL.revokeObjectURL(url);
          }
        });
      }
      if (oldMode === '2d') viewMode.set('2d');
    }, 500);
    exportOpen = false;
  }

  function onExportJSON() {
    const p = get(currentProject);
    if (p) exportAsJSON(p);
    exportOpen = false;
  }

  async function onExportPackage() {
    const project = get(currentProject);
    exportOpen = false; packageError = null;
    if (!project) return;
    const snapshot = structuredClone(project);
    try {
      const { downloadProjectPackage } = await import('$lib/services/projectPackage');
      if (!openingLifetime.signal.aborted) downloadProjectPackage(snapshot);
    } catch (error) { packageError = error instanceof Error ? error.message : get(t)('topbar.couldntExportPackageGeneric'); }
  }

  function onExportSVG() {
    const p = get(currentProject);
    if (p) exportAsSVG(p);
    exportOpen = false;
  }

  function onExportDXF() {
    const p = get(currentProject);
    if (p) exportDXF(p);
    exportOpen = false;
  }

  function onExportDWG() {
    const p = get(currentProject);
    if (p) exportDWG(p);
    exportOpen = false;
  }

  function onExportPDF() {
    const p = get(currentProject);
    if (p) exportPDF(p);
    exportOpen = false;
  }

  function onShareProject() {
    const p = get(currentProject);
    if (!p) return;
    const json = JSON.stringify(p, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name || 'floorplan'}.openplan.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function newProject() {
    importError = null;
    exportOpen = false;
    try { await openProject(() => createDefaultProject(), 'new', openingLifetime.signal); }
    catch (error) { importError = error instanceof Error ? error.message : get(t)('topbar.couldntOpenNewProject'); }
  }

  onMount(() => {
    const stopAutoSave = initAutoSave();
    initVersionHistory();
    const openSettings = () => { if (!hasOpenModal()) settingsOpen = true; };
    window.addEventListener('open-settings', openSettings);

    // Update relative timestamp every 15s
    const interval = setInterval(updateLastSavedText, 15000);

    function handleClickOutside(e: MouseEvent) {
      if (exportOpen && exportRef && !exportRef.contains(e.target as Node)) {
        exportOpen = false;
      }
      if (moreOpen && moreRef && !moreRef.contains(e.target as Node)) {
        moreOpen = false;
      }
      if (floorMenuOpen && floorMenuRef && !floorMenuRef.contains(e.target as Node)) {
        floorMenuOpen = false;
      }
    }
    function handleKeydown(e: KeyboardEvent) {
      if (hasOpenModal()) return;
      if (e.key !== 'Escape') return;
      if (exportOpen) exportOpen = false;
      if (e.key === 'Escape' && moreOpen) moreOpen = false;
      if (e.key === 'Escape' && floorMenuOpen) floorMenuOpen = false;
      if (e.key === 'Escape' && versionHistoryOpen) versionHistoryOpen = false;
      if (e.key === 'Escape' && areaOpen) areaOpen = false;
    }
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleKeydown, true);
    return () => {
      window.removeEventListener('open-settings', openSettings);
      if (get(saveState) === 'unsaved') void autoSave();
      stopAutoSave();
      stopVersionHistory();
      document.removeEventListener('click', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeydown, true);
      clearInterval(interval);
    };
  });

  function onImportJSON() {
    importError = null;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await openProject(async () => {
          const data = /\.zip$/i.test(file.name)
            ? await extractRoomJsonFromZip(file)
            : JSON.parse(await file.text());
          return isRoomPlanJson(data)
            ? createProjectFromRoomPlan(data, file.name.replace(/\.(json|zip)$/i, ''))
            : data;
        }, 'import', openingLifetime.signal);
      } catch (e: any) {
        const tr = get(t);
        const noProjectImported = tr('topbar.noProjectImported');
        const message = e?.message ?? tr('topbar.couldntReadFile');
        importError = message.includes(noProjectImported) ? message : `${message} ${noProjectImported}`;
      }
    };
    input.click();
    exportOpen = false;
  }
</script>

<div class="h-12 bg-gradient-to-r from-slate-800 to-slate-700 flex items-center px-4 gap-2 max-xl:px-2 max-xl:gap-1 shrink-0 shadow-sm">
  <!-- Back to Projects -->
  <a
    href={base || '/'}
    class="flex items-center gap-1 text-white/70 hover:text-white text-sm transition-colors"
    title={$t('topbar.backToProjects')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    <span class="hidden sm:inline">{$t('topbar.backToProjects')}</span>
  </a>

  <div class="h-5 w-px bg-white/20 max-xl:hidden"></div>

  {#if editingName}
    <input
      type="text"
      aria-label={$t('topbar.projectName')}
      bind:value={projectName}
      onblur={onNameBlur}
      onkeydown={onNameKeydown}
      class="bg-white/20 text-white font-semibold px-2 py-0.5 rounded border border-white/30 outline-none text-sm w-40"
    />
  {:else}
    <button
      class="font-semibold text-white text-sm hover:bg-white/10 px-2 py-0.5 rounded transition-colors max-w-[12rem] truncate max-xl:max-w-[4rem]"
      onclick={() => editingName = true}
      title={$t('topbar.clickToRename')}
    >{projectName}</button>
  {/if}

  <div class="h-5 w-px bg-white/20 max-xl:hidden"></div>

  <!-- Floor selector as buttons (in overflow menu on mobile) -->
  <div class="flex items-center gap-1 max-xl:hidden">
    <select aria-label={$t('topbar.currentFloor')} value={activeFloorId} onchange={(e) => setActiveFloor(e.currentTarget.value)}
      class="w-32 rounded bg-slate-700 px-2 py-1 text-xs text-white" title={$t('topbar.switchFloor')}>
      {#each floors as fl}<option value={fl.id}>{fl.name}</option>{/each}
    </select>
    <div class="relative" bind:this={floorMenuRef}>
      <button
        onclick={() => floorMenuOpen = !floorMenuOpen}
        class="text-white/80 hover:text-white text-xs hover:bg-white/10 px-1.5 py-0.5 rounded transition-colors"
        title={$t('topbar.addFloor')}
        aria-label={$t('topbar.addFloor')}
        aria-expanded={floorMenuOpen}
      >+</button>
      {#if floorMenuOpen}
        <div class="absolute left-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-64 z-50">
          <div class="px-3 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">{$t('topbar.addTopFloor')}</div>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => onAddFloor('outer')}>
            {$t('topbar.exteriorWalls')} <span class="text-gray-400">{$t('topbar.exteriorWallsHint')}</span>
          </button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => onAddFloor('copy')}>
            {$t('topbar.allWalls')} <span class="text-gray-400">{$t('topbar.allWallsHint')}</span>
          </button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => onAddFloor('empty')}>
            {$t('topbar.emptyFloor')}
          </button>
          <hr class="my-1 border-gray-100" />
          <button class="w-full px-3 py-2 text-sm text-red-700 hover:bg-gray-100 text-left disabled:opacity-40" disabled={floors.length <= 1}
            onclick={() => { onRemoveFloor(activeFloorId); floorMenuOpen = false; }}>{$t('topbar.removeCurrentFloor')}</button>
        </div>
      {/if}
    </div>
    <span class="text-white/40 text-[10px] ml-1">{$t('topbar.floorsBadge', { n: floors.length })}</span>
  </div>

  <div class="flex-1"></div>

  <button onclick={undo} class="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors" title="{$t('topbar.undo')} (Ctrl+Z)" aria-label={$t('topbar.undo')}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
  </button>
  <button onclick={redo} class="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors" title="{$t('topbar.redo')} (Ctrl+Y)" aria-label={$t('topbar.redo')}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
  </button>

  <div class="h-5 w-px bg-white/20 max-xl:hidden"></div>

  <!-- Snap to grid toggle -->
  <button
    onclick={() => { snapEnabled.update(v => !v); snapOn = !snapOn; }}
    class="p-1.5 rounded transition-colors max-xl:hidden {snapOn ? 'text-white bg-white/20' : 'text-white/40 hover:text-white/70 hover:bg-white/10'}"
    title="{$t('topbar.snapToGrid')} ({snapOn ? $t('topbar.on') : $t('topbar.off')})"
    aria-label={$t('topbar.snapToGrid')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  </button>

  <!-- Language switcher -->
  <div class="flex bg-white/15 rounded-full p-0.5 max-xl:hidden" title={$t('lang.switch')}>
    <button
      onclick={() => locale.set('uk')}
      class="px-2 py-1 text-xs font-semibold rounded-full transition-colors {$locale === 'uk' ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
      aria-label={$t('lang.uk')}
    >УКР</button>
    <button
      onclick={() => locale.set('ru')}
      class="px-2 py-1 text-xs font-semibold rounded-full transition-colors {$locale === 'ru' ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
      aria-label={$t('lang.ru')}
    >РУС</button>
  </div>

  <!-- Select / Pan toggle (mobile pans with two fingers; toggle lives in overflow menu) -->
  {#if mode === '2d'}
  <div class="flex bg-white/15 rounded-full p-0.5 max-xl:hidden">
    <button
      onclick={() => panMode.set(false)}
      class="px-2 py-1 text-xs font-semibold rounded-full transition-colors {!$panMode ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
      title="{$t('topbar.selectMode')} (V)"
      aria-label={$t('topbar.selectMode')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg>
    </button>
    <button
      onclick={() => panMode.set(true)}
      class="px-2 py-1 text-xs font-semibold rounded-full transition-colors {$panMode ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
      title="{$t('topbar.panMode')} (H)"
      aria-label={$t('topbar.panMode')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    </button>
  </div>
  {/if}

  <!-- Furniture visibility toggle -->
  <button
    onclick={() => layerVisibility.update(v => ({ ...v, furniture: !v.furniture }))}
    class="p-1.5 rounded transition-colors max-xl:hidden {$showFurnitureStore ? 'text-white bg-white/20' : 'text-white/40 hover:text-white/70 hover:bg-white/10'}"
    title="{$t('topbar.toggleFurniture')} ({$showFurnitureStore ? $t('topbar.visible') : $t('topbar.hidden')})"
    aria-label={$t('topbar.toggleFurniture')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="12" width="20" height="8" rx="1"/><path d="M4 12V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><line x1="12" y1="12" x2="12" y2="20"/>
    </svg>
  </button>

  <div class="h-5 w-px bg-white/20 max-xl:hidden"></div>

  <!-- Plan / Elevation sub-toggle (2D only) — sits left of the 2D/3D pill so the
       two switches read as a family; mobile (<md) uses the overflow menu instead -->
  {#if mode === '2d'}
    <div class="flex bg-white/15 rounded-full p-0.5 max-xl:hidden">
      <button
        onclick={exitElevation}
        class="px-3 py-1 text-xs font-semibold rounded-full transition-colors flex items-center gap-1.5 {!$elevationWallId ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
        title={$t('topbar.planView')}
        aria-pressed={!$elevationWallId}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h8"/><path d="M11 12v9"/><path d="M15 3v6"/></svg>
        <span>{$t('topbar.plan')}</span>
      </button>
      <button
        onclick={enterElevation}
        class="px-3 py-1 text-xs font-semibold rounded-full transition-colors flex items-center gap-1.5 {$elevationWallId ? 'bg-white text-slate-800' : $elevationPickMode ? 'bg-blue-500 text-white' : 'text-white/80 hover:text-white'}"
        title={$elevationPickMode ? $t('topbar.elevationPick') : $t('topbar.elevationView')}
        aria-pressed={!!$elevationWallId || $elevationPickMode}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9H3z"/><rect x="10" y="14" width="4" height="6"/><rect x="5.5" y="13" width="3" height="3"/></svg>
        <span>{$t('topbar.elevation')}</span>
      </button>
    </div>
  {/if}

  <!-- 2D/3D pill toggle -->
  <div class="flex bg-white/15 rounded-full p-0.5">
    <button
      onclick={() => setMode('2d')}
      class="px-3 max-xl:px-2 py-1 text-xs font-semibold rounded-full transition-colors {mode === '2d' ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
    >2D</button>
    <button
      onclick={() => setMode('3d')}
      class="px-3 max-xl:px-2 py-1 text-xs font-semibold rounded-full transition-colors {mode === '3d' ? 'bg-white text-slate-800' : 'text-white/80 hover:text-white'}"
    >3D</button>
  </div>

  <!-- Zoom remains available on the canvas and in the compact toolbar menu. -->

  <!-- Version History button -->
  <button
    onclick={() => versionHistoryOpen = true}
    class="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors max-xl:hidden"
    title={$t('topbar.versionHistory')}
    aria-label={$t('topbar.versionHistory')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  </button>

  <!-- Area summary button -->
  <button
    onclick={() => areaOpen = true}
    class="px-2 py-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors max-xl:hidden"
    title={$t('topbar.areaSummary')}
    aria-label={$t('topbar.areaSummary')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v18"/></svg>
  </button>

  <!-- Settings button -->
  <button
    onclick={() => settingsOpen = true}
    class="px-2 py-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors max-xl:hidden"
    title={$t('topbar.settings')}
    aria-label={$t('topbar.settings')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  </button>

  <!-- Overflow menu (mobile only): secondary actions hidden from the condensed bar -->
  <div class="relative xl:hidden" bind:this={moreRef}>
    <button
      onclick={() => moreOpen = !moreOpen}
      class="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
      title={$t('topbar.more')}
      aria-label={$t('topbar.more')}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>
    {#if moreOpen}
      <div class="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-56 z-50 max-h-[70vh] overflow-y-auto">
        {#if floors.length > 1 || mode === '2d'}
          <div class="px-3 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">{$t('topbar.floors')}</div>
          {#each floors as fl}
            <button class="w-full px-3 py-2 text-sm hover:bg-gray-100 text-left flex items-center gap-2 {fl.id === activeFloorId ? 'text-blue-600 font-semibold' : 'text-gray-700'}" onclick={() => { setActiveFloor(fl.id); moreOpen = false; }}>
              {fl.name}{fl.id === activeFloorId ? ' ✓' : ''}
            </button>
          {/each}
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { onAddFloor('outer'); }}>+ {$t('topbar.addFloor')} <span class="text-gray-400">({$t('topbar.exteriorWalls')})</span></button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { onAddFloor('copy'); }}>+ {$t('topbar.addFloor')} <span class="text-gray-400">({$t('topbar.allWalls')})</span></button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { onAddFloor('empty'); }}>+ {$t('topbar.addFloor')} <span class="text-gray-400">({$t('topbar.emptyFloor')})</span></button>
          <button class="w-full px-3 py-2 text-sm text-red-700 hover:bg-gray-100 text-left disabled:opacity-40" disabled={floors.length <= 1}
            onclick={() => { onRemoveFloor(activeFloorId); moreOpen = false; }}>{$t('topbar.removeCurrentFloor')}</button>
          <div class="h-px bg-gray-100 my-1"></div>
        {/if}
        {#if mode === '2d'}
          <div class="px-3 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">{$t('topbar.view')}</div>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => canvasZoom.update(z => Math.min(10, z * 1.25))}>{$t('topbar.zoomIn')}</button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => canvasZoom.update(z => Math.max(0.1, z / 1.25))}>{$t('topbar.zoomOut')}</button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => canvasZoom.set(1)}>{$t('topbar.resetZoom', { pct: Math.round($canvasZoom * 100) })}</button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => panMode.update(v => !v)}>{$panMode ? '✓ ' : ''}{$t('topbar.panMode')}</button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { snapEnabled.update(v => !v); snapOn = !snapOn; }}>{snapOn ? '✓ ' : ''}{$t('topbar.snapToGrid')}</button>
          <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => layerVisibility.update(v => ({ ...v, furniture: !v.furniture }))}>{$showFurnitureStore ? '✓ ' : ''}{$t('topbar.showFurniture')}</button>
          <div class="h-px bg-gray-100 my-1"></div>
        {/if}
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={toggleElevationView}>{$elevationWallId ? '✓ ' : ''}{$t('topbar.elevation')}</button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { versionHistoryOpen = true; moreOpen = false; }}>{$t('topbar.versionHistory')}</button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { areaOpen = true; moreOpen = false; }}>{$t('topbar.areaSummary')}</button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={() => { settingsOpen = true; moreOpen = false; }}>{$t('topbar.settings')}</button>
      </div>
    {/if}
  </div>

  <div class="h-5 w-px bg-white/20 max-xl:hidden"></div>

  <!-- Export dropdown -->
  <div class="relative" bind:this={exportRef}>
    <button
      onclick={() => { exportOpen = !exportOpen; if (exportOpen) triggerTip('first-export', 300, 60); }}
      class="px-3 py-1.5 max-xl:px-2 text-sm text-white/90 hover:text-white hover:bg-white/10 rounded transition-colors flex items-center gap-1.5"
      title={$t('topbar.export')}
      aria-label={$t('topbar.export')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <span class="max-xl:hidden">{$t('topbar.export')}</span>
    </button>
    {#if exportOpen}
      <div class="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-48 z-50">
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={() => { exportOpen = false; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true })); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          {$t('topbar.printLayout')}
        </button>
        <div class="h-px bg-gray-100 my-1"></div>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExport2DPNG}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          {$t('topbar.export2dPng')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExport3DPNG}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          {$t('topbar.export3dPng')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExportSVG}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
          {$t('topbar.exportSvg')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExportDXF}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 16h2"/><path d="M14 16h2"/></svg>
          {$t('topbar.exportDxf')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExportDWG}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 16h6"/></svg>
          {$t('topbar.exportDwg')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExportPDF}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 11v6"/><path d="M8 11v6"/><path d="M12 11v6"/></svg>
          {$t('topbar.exportPdf')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onExportJSON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          {$t('topbar.downloadJson')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left" onclick={onExportPackage}>{$t('topbar.downloadPackage')}</button>
        <p class="px-3 pb-2 text-xs text-gray-500">{$t('topbar.packageHint')}</p>
        <div class="h-px bg-gray-100 my-1"></div>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={onImportJSON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          {$t('topbar.importJson')}
        </button>
        <button class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left flex items-center gap-2" onclick={newProject}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {$t('topbar.newProject')}
        </button>
      </div>
    {/if}
  </div>

  <span
    class="text-[11px] font-medium transition-all duration-300 max-xl:hidden {$saveState === 'saved' ? 'text-emerald-400' : $saveState === 'saving' ? 'text-amber-300 animate-pulse' : 'text-white/50'}"
    title={lastSavedText || $t('topbar.notSavedYet')}
  >
    {#if $saveState === 'saving'}
      {$t('topbar.savingStatus')}
    {:else if $saveState === 'saved'}
      {$t('topbar.savedStatus')}
    {:else}
      {$t('topbar.unsavedStatus')}
    {/if}
  </span>
  <button onclick={save} class="px-3 py-1.5 max-xl:px-2.5 text-sm bg-white text-slate-800 font-semibold rounded-lg hover:bg-blue-50 transition-colors shadow-sm">
    {$t('topbar.save')}
  </button>
</div>

{#if $saveError}
  <div role="alert" class="flex flex-wrap items-center gap-3 bg-red-50 border-b border-red-200 px-4 py-3 text-sm text-red-900">
    <span class="flex-1 min-w-48">{$t('topbar.changesNotSaved', { error: $saveError })}</span>
    {#if $saveConflict}
      <button class="font-semibold underline disabled:opacity-50" disabled={$savingCopy} onclick={saveCurrentAsCopy}>{$savingCopy ? $t('topbar.savingCopy') : $t('topbar.saveAsCopy')}</button>
    {:else}
      <button class="font-semibold underline" onclick={save}>{$t('topbar.retrySave')}</button>
    {/if}
    <button class="font-semibold underline" onclick={onExportJSON}>{$t('topbar.downloadJsonBackup')}</button>
  </div>
{/if}

<SettingsDialog bind:open={settingsOpen} />
<VersionHistoryPanel bind:open={versionHistoryOpen} />

{#if areaOpen}
<dialog use:modalDialog class="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40" aria-label={$t('topbar.areaSummary')} onclick={(e) => { if (e.target === e.currentTarget) areaOpen = false; }} oncancel={(e) => { e.preventDefault(); areaOpen = false; }}>
  <div class="bg-white rounded-xl shadow-2xl w-[420px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-hidden">
    <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
      <h2 class="text-base font-semibold text-gray-800">{$t('topbar.areaSummaryTitle')}</h2>
      <button aria-label={$t('topbar.closeAreaSummary')} onclick={() => areaOpen = false} class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
    </div>
    <div class="overflow-y-auto max-h-[calc(80vh-52px)] p-1">
      <AreaSummaryPanel />
    </div>
  </div>
</dialog>
{/if}

{#if importError}
  <ImportError title={$t('topbar.couldntOpenPlan')} message={importError} onDismiss={() => importError = null} />
{/if}
{#if packageError}<ImportError title={$t('topbar.couldntExportPackage')} message={packageError} onDismiss={() => packageError = null} />{/if}
