<script lang="ts">
  import { hasOpenModal } from '$lib/utils/modalDialog';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { openAISettings, setOpenAIModel } from '$lib/stores/aiKeys';
  import { generateOpenAIRenderImage, validateOpenAIConfig, getEffectiveModel, normalizeBaseUrl } from '$lib/utils/openaiClient';
  import OpenAIModelPicker from '$lib/components/ai/OpenAIModelPicker.svelte';
  import { activeFloor, currentProject, selectedElementId } from '$lib/stores/project';
  import type { Floor, Wall, Window as Win, Point } from '$lib/models/types';
  import { getWallStartHeight, getWallEndHeight } from '$lib/models/types';
  import { wallColors, type WallColor } from '$lib/utils/materials';
  import { projectSettings } from '$lib/stores/settings';
  import * as THREE from 'three';
  import { createSlopedBoxGeometry } from '$lib/utils/slopedWallGeometry';
  import { buildWallSegments, openingOnWall, roomCeilingHeight, wallPathSpans } from '$lib/utils/wallProfiles';
  import { assembleFloorStack } from '$lib/utils/floorStack';
  import { setFloorCameraPose } from '$lib/utils/floorCamera';
  import { sceneSignature } from '$lib/utils/sceneSignature';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import MaterialPicker from './MaterialPicker.svelte';
  import { getCatalogItem, getCatalogItemOrFallback, furnitureCatalog, furnitureCategories } from '$lib/utils/furnitureCatalog';
  import type { FurnitureDef } from '$lib/utils/furnitureCatalog';
  import { createWallHighlight } from '$lib/utils/wallHighlight';
  import { disposeModel, ownTexture } from '$lib/utils/furnitureModelResources';
  import { createFurnitureModelWithGLB } from '$lib/utils/furnitureModelLoader';
  import { addFurniture, resizeMainRoom, getMainRoomBounds, transformFurnitureDuringDrag, beginUndoGroup, endUndoGroup, removeElement, rotateFurniture } from '$lib/stores/project';
  import { detectRooms, resolveRooms, getRoomPolygon, roomCentroid } from '$lib/utils/roomDetection';
  import { getWallTextureCanvas, setTextureLoadCallback } from '$lib/utils/textureGenerator';
  import { pointToSegmentDist } from '$lib/utils/hitTesting';
  import { snapFurnitureToWalls, snapFurnitureToNeighbors } from '$lib/utils/furnitureGeometry';
  import { isEditingField } from '$lib/utils/shortcuts';
  // This file uses `t` extensively as a local variable name (parametric
  // position values), so it uses td() everywhere instead of $t()/get(t)() to
  // avoid shadowing the i18n store.
  import { td } from '$lib/i18n';

  let container: HTMLDivElement;
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let controls: OrbitControls;
  // The main viewport camera never leaves the room: it only orbits a fixed
  // point at its center, confined to the room's own volume — the four walls
  // horizontally, floor and ceiling vertically — so no exterior view of the
  // building is possible even in principle. This is a furniture builder, not
  // a walkthrough, so the cursor stays free.
  let cameraPositioned = false;
  const orbitTarget = new THREE.Vector3(0, 150, 0);
  let panningCamera = false; // true while the right mouse button pans the view — see animate()
  let roomBoundaryPoly: Point[] = []; // room polygon (plan x/y) the camera is confined inside
  let roomWallIds: string[] = [];
  let roomFloorY = 0;
  let roomCeilingY = 270;
  let culledWallId: string | null = null;
  const ORBIT_MIN_RADIUS = 60;    // cm — closest the camera may approach its pivot
  const ORBIT_WALL_MARGIN = 25;   // cm kept clear between the camera and any wall surface
  const ORBIT_ZOOM_STEP = 40;     // cm per wheel notch, identical both directions
  const ORBIT_FLOOR_MARGIN = 20;
  const ORBIT_CEILING_MARGIN = 15;
  const ORBIT_CULL_DISTANCE = 150; // only the wall this close to the camera hides

  // Dirty flag — only render when scene changes or camera moves
  let sceneDirty = true;
  let viewerMounted = false;
  let animId: number | undefined;
  function requestRender() {
    if (viewerMounted && animId === undefined) animId = requestAnimationFrame(animate);
  }
  function markSceneDirty() {
    sceneDirty = true;
    requestRender();
  }
  let currentFloor = $state.raw<Floor | null>(null);
  let renderedSignature: string | null = null;
  let wallGroup: THREE.Group;

  // Raycasting for wall/furniture selection in 3D
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const wallMeshMap = new Map<THREE.Object3D, string>(); // mesh → wallId
  let selectedWallId3D: string | null = null;
  const wallHighlight = createWallHighlight();

  // Furniture selection/drag in 3D
  const furnitureMeshMap = new Map<THREE.Object3D, string>(); // mesh → furnitureId
  let furnitureObjects: THREE.Object3D[] = []; // one root group per placed item, for recursive raycasting
  const furnitureHighlight = createWallHighlight(); // generic per-mesh emissive tint, reused for furniture
  // Same highlight technique, dedicated to the snap targets lit up while dragging
  // a module — kept separate from the selection highlights above so the two
  // never clobber each other mid-drag.
  const wallSnapHighlight = createWallHighlight();
  const neighborSnapHighlight = createWallHighlight();
  // Furniture drag rebuilds the whole scene every frame (position is part of
  // sceneSignature), which recreates every mesh and would instantly wipe a
  // highlight applied directly from the pointermove handler. Track the target
  // ids here instead and re-apply them from rebuildScene() itself, the same
  // place the selection highlight already gets reapplied after every rebuild.
  let dragWallSnapId: string | null = null;
  let dragNeighborSnapId: string | null = null;
  let draggingFurnitureId: string | null = null;
  // A furniture item only becomes draggable after a double-click "activates"
  // it; a plain click just selects it. Clicking anything else clears this.
  let activeFurnitureId3D: string | null = null;
  const furnitureDragOffset = { x: 0, z: 0 };
  /** Walks up from a raycast hit to the furniture root that owns it. */
  function findFurnitureIdFromObject(obj: THREE.Object3D | null): string | null {
    for (let o = obj; o; o = o.parent) if (o.userData.furnitureId) return o.userData.furnitureId as string;
    return null;
  }

  // 3D Edit mode — enables click-to-select
  let editMode = $state(false);
  // Material picker state
  let materialPickerPos = $state<{ x: number; y: number } | null>(null);
  let materialPickerWall = $state<Wall | null>(null);
  // Wall transparency toggle
  let wallsTransparent = $state(false);
  // Multi-floor stacking
  let showAllFloors = $state(false);
  let activeFloorElevation = $state(0);
  let sceneGround: THREE.Mesh;
  // Stacked geometry uses the same floor levels as the 2D reference layer.

  // Room size controls state
  let roomSizePanelOpen = $state(false);
  let roomBoundsCm = $derived(currentFloor ? getMainRoomBounds(currentFloor) : null);

  function onRoomDimInputMm(field: 'width' | 'depth' | 'height', raw: string) {
    const mm = Number(raw);
    if (!Number.isFinite(mm) || mm < 500) return;
    const cm = mm / 10;
    const current = roomBoundsCm ?? { width: 600, depth: 500, height: 250 };
    resizeMainRoom(
      field === 'width' ? cm : current.width,
      field === 'depth' ? cm : current.depth,
      field === 'height' ? cm : current.height
    );
  }

  // Lighting controls state
  let lightingPanelOpen = $state(false);
  let sunAzimuth = $state(135);      // 0-360 degrees
  let sunElevation = $state(60);     // 0-90 degrees
  let ambientIntensity = $state(0.35);
  let timeOfDay = $state<'morning' | 'noon' | 'evening' | 'night' | null>(null);

  // Light references
  let ambientLight: THREE.AmbientLight;
  let hemiLight: THREE.HemisphereLight;
  let sunLight: THREE.DirectionalLight;
  let fillLight: THREE.DirectionalLight;
  let rimLight: THREE.DirectionalLight;
  let skyCanvas: HTMLCanvasElement;
  let skyTexture: THREE.CanvasTexture;

  // Interior Camera placement
  let cameraPlacementMode = $state(false);
  let interiorCamera: THREE.PerspectiveCamera | null = null;
  let cameraHelper: THREE.Group | null = null;
  let cameraPosition = $state<{ x: number; y: number; z: number }>({ x: 0, y: 160, z: 0 });
  let cameraLookAt = $state<{ x: number; y: number; z: number }>({ x: 100, y: 120, z: 0 });
  let cameraFOV = $state(90);
  let cameraHeight = $state(160);
  let cameraPreviewOpen = $state(false);
  let cameraPreviewCanvas = $state<HTMLCanvasElement | null>(null);
  let cameraPreviewRenderer: THREE.WebGLRenderer | null = null;
  let previewAnimId: number | undefined;
  let cameraPlaced = $state(false);
  let cameraDragMode = $state<'position' | 'lookat' | null>(null);
  let cameraYaw = $state(0);   // degrees, 0 = initial direction
  let cameraPitch = $state(0); // degrees, negative = look down, positive = look up
  let cameraBaseDir = { x: 1, z: 0 }; // normalized direction from position to lookAt
  let cameraPreviewDirty = $state(false);
  let cameraXrayWalls = $state(false);
  let previewDragStart: { x: number; y: number; yaw: number; pitch: number } | null = null;
  let aiRenderOpen = $state(false);
  let aiRendering = $state(false);
  let aiRenderResult = $state<string | null>(null);
  let aiRenderError = $state<string | null>(null);
  let aiRenderStyle = $state('photorealistic');
  let aiRenderLighting = $state('natural daylight');
  let aiRenderMood = $state('warm and inviting');
  let aiRenderExtra = $state('');
  const STYLE_OPTIONS = ['photorealistic', 'architectural visualization', 'interior design magazine', 'minimalist', 'scandinavian', 'industrial', 'mid-century modern', 'luxury'];
  const LIGHTING_OPTIONS = ['natural daylight', 'warm afternoon', 'golden hour', 'soft ambient', 'dramatic shadows', 'bright and airy', 'moody evening', 'studio lighting'];
  const MOOD_OPTIONS = ['warm and inviting', 'clean and modern', 'cozy', 'elegant', 'rustic charm', 'sophisticated', 'relaxed', 'vibrant'];
  let aiProvider = $state<'gemini' | 'openai'>('gemini');
  let aiModel = $state('gemini-2.5-flash-image');
  const AI_MODELS = [
    { id: 'gemini-2.5-flash-image', name: 'Nano Banana (2.5 Flash)', desc: 'Fast & efficient image gen ✓' },
    { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro (3 Pro)', desc: 'Best quality, thinking, up to 4K ✓' },
  ];
  let openaiModel = $state('');
  let renderController: AbortController | null = null;

  function cancelAIRender() {
    if (!renderController) return;
    renderController.abort(); renderController = null; aiRendering = false;
    aiRenderError = td('viewer3d.requestCancelled');
  }

  function saveRenderModel() {
    try { setOpenAIModel(openaiModel); }
    catch { aiRenderError = td('viewer3d.storageUnavailable'); }
  }

  function providerDestination(): string {
    try { return normalizeBaseUrl($openAISettings.baseUrl); }
    catch { return td('viewer3d.invalidProviderUrl'); }
  }

  function buildAIPrompt(): string {
    let prompt = `Transform this interior 3D floor plan render into a ${aiRenderStyle} image. `;
    prompt += `Lighting: ${aiRenderLighting}. Mood: ${aiRenderMood}. `;
    prompt += `Keep the exact same room geometry, furniture placement, and camera angle. `;
    prompt += `Add realistic materials, textures, shadows, and reflections. `;
    prompt += `Make walls, floors, and furniture look like real materials (wood, fabric, metal, etc). `;
    if (aiRenderExtra.trim()) prompt += aiRenderExtra.trim() + ' ';
    prompt += `Do NOT change the room layout, furniture positions, or camera perspective.`;
    return prompt;
  }

  /** Capture scene from interior camera as base64 PNG */
  function captureSceneBase64(width: number, height: number): string {
    updateInteriorCamera();
    const offRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    offRenderer.setSize(width, height);
    offRenderer.shadowMap.enabled = true;
    offRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    offRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    try {
      return withInteriorScene(() => {
        offRenderer.render(scene, interiorCamera!);
        return offRenderer.domElement.toDataURL('image/png');
      }, false);
    } finally {
      releaseRenderer(offRenderer);
    }
  }

  async function runAIRender() {
    if (!scene || !interiorCamera || aiRendering) return;
    const controller = new AbortController();
    renderController = controller; aiRendering = true;
    aiRenderResult = null; aiRenderError = null;
    try {
      const result = aiProvider === 'gemini' ? await runGeminiRender(controller.signal) : await runOpenAIRender(controller.signal);
      if (renderController === controller) aiRenderResult = result;
    } catch (error) {
      if (renderController === controller) aiRenderError = error instanceof Error ? error.message : td('viewer3d.renderingFailed');
    } finally {
      if (renderController === controller) { aiRendering = false; renderController = null; }
    }
  }

  async function runGeminiRender(signal: AbortSignal): Promise<string> {
    const geminiKey = localStorage.getItem('o3d_gemini_key');
    if (!geminiKey) {
      throw new Error(td('viewer3d.geminiKeyMissing'));
    }

    const imageDataUrl = captureSceneBase64(1024, 576);
    const base64Image = imageDataUrl.split(',')[1];
    const prompt = buildAIPrompt();

    const requestBody: any = {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: base64Image } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      }
    };
    requestBody.generationConfig.imageConfig = { aspectRatio: '16:9' };

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(td('viewer3d.apiErrorPrefix', { status: response.status, err }));
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (imagePart) {
      return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
    } else {
      const textPart = parts.find((p: any) => p.text && !p.thought);
      throw new Error(textPart?.text || td('viewer3d.noImageReturned'));
    }
  }

  async function runOpenAIRender(signal: AbortSignal): Promise<string> {
    const config = { ...get(openAISettings), model: openaiModel };
    validateOpenAIConfig(config);
    const imageDataUrl = captureSceneBase64(1024, 576);
    return generateOpenAIRenderImage(config, imageDataUrl.split(',')[1], buildAIPrompt(), fetch, signal);
  }

  function downloadAIRender() {
    if (!aiRenderResult) return;
    const link = document.createElement('a');
    const projectName = get(currentProject)?.name ?? 'floorplan';
    link.download = `${projectName}-ai-render.png`;
    link.href = aiRenderResult;
    link.click();
  }

  /** Move camera in the XZ plane relative to current facing direction.
   *  forward/right are in camera-local space (forward = facing dir, right = perpendicular). */
  function moveCameraRelative(forward: number, right: number) {
    const yawRad = cameraYaw * Math.PI / 180;
    const cos = Math.cos(yawRad);
    const sin = Math.sin(yawRad);
    // Current facing direction (rotated baseDir by yaw)
    const fwdX = cameraBaseDir.x * cos - cameraBaseDir.z * sin;
    const fwdZ = cameraBaseDir.x * sin + cameraBaseDir.z * cos;
    // Right is perpendicular to forward in XZ
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const dx = fwdX * forward + rightX * right;
    const dz = fwdZ * forward + rightZ * right;
    cameraPosition = { ...cameraPosition, x: cameraPosition.x + dx, z: cameraPosition.z + dz };
    updateCameraMarkerFromState();
    cameraPreviewDirty = true;
  }

  /** Rebuild the 3D camera marker to match current yaw/pitch/position state */
  function updateCameraMarkerFromState() {
    const yawRad = cameraYaw * Math.PI / 180;
    const cos = Math.cos(yawRad);
    const sin = Math.sin(yawRad);
    const dirX = cameraBaseDir.x * cos - cameraBaseDir.z * sin;
    const dirZ = cameraBaseDir.x * sin + cameraBaseDir.z * cos;
    const lookDist = 200;
    createCameraMarker(
      new THREE.Vector3(cameraPosition.x, 0, cameraPosition.z),
      new THREE.Vector3(cameraPosition.x + dirX * lookDist, 0, cameraPosition.z + dirZ * lookDist)
    );
  }

  function createCameraMarker(pos: THREE.Vector3, lookAt: THREE.Vector3) {
    if (cameraHelper) {
      clearGroup(cameraHelper);
      wallGroup.remove(cameraHelper);
    }
    cameraHelper = new THREE.Group();
    cameraHelper.name = 'interior_camera';

    // Camera body — small box
    const bodyGeo = new THREE.BoxGeometry(20, 15, 25);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.3, metalness: 0.5 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.copy(pos);
    body.position.y = cameraHeight;
    cameraHelper.add(body);

    // Lens — cylinder
    const lensGeo = new THREE.CylinderGeometry(6, 8, 10, 8);
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x1e40af, roughness: 0.1, metalness: 0.7 });
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.rotation.z = Math.PI / 2;
    const dir = new THREE.Vector3().subVectors(lookAt, pos).normalize();
    lens.position.copy(pos);
    lens.position.y = cameraHeight;
    lens.position.add(dir.clone().multiplyScalar(17));
    lens.lookAt(lookAt.x, cameraHeight, lookAt.z);
    lens.rotateX(Math.PI / 2);
    cameraHelper.add(lens);

    // Direction line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(pos.x, cameraHeight, pos.z),
      new THREE.Vector3(lookAt.x, cameraHeight * 0.75, lookAt.z)
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2 });
    const line = new THREE.Line(lineGeo, lineMat);
    cameraHelper.add(line);

    // FOV cone wireframe
    const halfFov = (cameraFOV / 2) * Math.PI / 180;
    const coneLen = 150;
    const coneW = Math.tan(halfFov) * coneLen;
    const conePoints = [
      new THREE.Vector3(pos.x, cameraHeight, pos.z),
      new THREE.Vector3(pos.x + dir.x * coneLen + dir.z * coneW, cameraHeight, pos.z + dir.z * coneLen - dir.x * coneW),
      new THREE.Vector3(pos.x, cameraHeight, pos.z),
      new THREE.Vector3(pos.x + dir.x * coneLen - dir.z * coneW, cameraHeight, pos.z + dir.z * coneLen + dir.x * coneW),
    ];
    const coneGeo = new THREE.BufferGeometry().setFromPoints(conePoints);
    const coneLine = new THREE.LineSegments(coneGeo, new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.6 }));
    cameraHelper.add(coneLine);

    // Target marker — small sphere
    const targetGeo = new THREE.SphereGeometry(5, 8, 8);
    const targetMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.3 });
    const target = new THREE.Mesh(targetGeo, targetMat);
    target.position.set(lookAt.x, cameraHeight * 0.75, lookAt.z);
    cameraHelper.add(target);

    cameraHelper.position.y = activeFloorElevation;
    wallGroup.add(cameraHelper);
    markSceneDirty();
  }

  function updateInteriorCamera() {
    if (!interiorCamera) {
      interiorCamera = new THREE.PerspectiveCamera(cameraFOV, 16 / 9, 1, 5000);
    }
    interiorCamera.fov = cameraFOV;

    // Apply yaw (horizontal) and pitch (vertical) rotation to base direction
    const yawRad = cameraYaw * Math.PI / 180;
    const pitchRad = cameraPitch * Math.PI / 180;
    const cos = Math.cos(yawRad);
    const sin = Math.sin(yawRad);
    const dirX = cameraBaseDir.x * cos - cameraBaseDir.z * sin;
    const dirZ = cameraBaseDir.x * sin + cameraBaseDir.z * cos;
    const lookDist = 500;
    const lookY = cameraHeight + Math.tan(pitchRad) * lookDist;

    setFloorCameraPose(interiorCamera, activeFloorElevation,
      { x: cameraPosition.x, y: cameraHeight, z: cameraPosition.z },
      { x: cameraPosition.x + dirX * lookDist, y: lookY, z: cameraPosition.z + dirZ * lookDist });
    interiorCamera.updateProjectionMatrix();
  }

  /** Set wall/ceiling meshes to transparent for x-ray preview.
   *  Saves original material state so it can be restored cleanly. */
  const xrayOriginals = new Map<THREE.Mesh, { transparent: boolean; opacity: number; depthWrite: boolean }>();
  function setWallsXray(xray: boolean) {
    if (!wallGroup) return;
    if (xray) {
      xrayOriginals.clear();
      wallGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh && !(obj instanceof THREE.Sprite)) {
          const mat = obj.material as THREE.MeshStandardMaterial;
          if (!mat) return;
          xrayOriginals.set(obj, { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite });
          mat.transparent = true;
          mat.opacity = 0.12;
          mat.depthWrite = false;
          mat.needsUpdate = true;
        }
      });
    } else {
      for (const [mesh, orig] of xrayOriginals) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (!mat) continue;
        mat.transparent = orig.transparent;
        mat.opacity = orig.opacity;
        mat.depthWrite = orig.depthWrite;
        mat.needsUpdate = true;
      }
      xrayOriginals.clear();
    }
  }

  function captureInteriorPhoto() {
    if (!scene || !interiorCamera) return;
    updateInteriorCamera();

    // Create high-res offscreen renderer
    const width = 1920;
    const height = 1080;
    const offRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    offRenderer.setSize(width, height);
    offRenderer.setPixelRatio(1);
    offRenderer.shadowMap.enabled = true;
    offRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    offRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    offRenderer.toneMappingExposure = 1.0;

    let dataUrl: string;
    try {
      dataUrl = withInteriorScene(() => {
        offRenderer.render(scene, interiorCamera!);
        return offRenderer.domElement.toDataURL('image/png');
      });
    } finally {
      releaseRenderer(offRenderer);
    }

    // Download
    const link = document.createElement('a');
    const projectName = get(currentProject)?.name ?? 'floorplan';
    link.download = `${projectName}-interior-photo.png`;
    link.href = dataUrl;
    link.click();
  }

  function releaseRenderer(target: THREE.WebGLRenderer) {
    try { target.dispose(); }
    finally { target.forceContextLoss(); }
  }

  function releaseCameraPreview() {
    if (previewAnimId !== undefined) cancelAnimationFrame(previewAnimId);
    previewAnimId = undefined;
    if (cameraPreviewRenderer) {
      releaseRenderer(cameraPreviewRenderer);
      cameraPreviewRenderer = null;
    }
  }

  function attachCameraPreview(canvas: HTMLCanvasElement) {
    cameraPreviewCanvas = canvas;
    cameraPreviewDirty = true;
    return { destroy() {
      releaseCameraPreview();
      cameraPreviewCanvas = null;
    } };
  }

  function closeCamera() {
    cancelAIRender();
    releaseCameraPreview();
    cameraPreviewOpen = cameraPlaced = cameraPlacementMode = false;
    previewDragStart = null;
    if (cameraHelper) {
      clearGroup(cameraHelper);
      cameraHelper.removeFromParent();
      cameraHelper = null;
    }
    interiorCamera = null;
    aiRenderOpen = false; aiRenderResult = null; aiRenderError = null;
    markSceneDirty();
  }

  /** All temporary presentation changes are restored even if rendering fails. */
  function withInteriorScene<T>(render: () => T, xray = cameraXrayWalls): T {
    const helperVisible = cameraHelper?.visible ?? true;
    const sprites = new Map<THREE.Sprite, boolean>();
    scene.traverse(obj => {
      if (obj instanceof THREE.Sprite) { sprites.set(obj, obj.visible); obj.visible = false; }
    });
    try {
      if (cameraHelper) cameraHelper.visible = false;
      if (xray) setWallsXray(true);
      return render();
    } finally {
      if (xray) setWallsXray(false);
      if (cameraHelper) cameraHelper.visible = helperVisible;
      for (const [sprite, visible] of sprites) sprite.visible = visible;
    }
  }

  function renderCameraPreview() {
    if (!cameraPreviewCanvas || !scene) return;
    updateInteriorCamera();
    if (!interiorCamera) return;

    if (!cameraPreviewRenderer) {
      cameraPreviewRenderer = new THREE.WebGLRenderer({ canvas: cameraPreviewCanvas, antialias: true, alpha: false });
      cameraPreviewRenderer.shadowMap.enabled = true;
      cameraPreviewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      cameraPreviewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      cameraPreviewRenderer.toneMappingExposure = 1.0;
      cameraPreviewRenderer.setSize(384, 216);
      cameraPreviewRenderer.setPixelRatio(1);
    }
    withInteriorScene(() => cameraPreviewRenderer!.render(scene, interiorCamera!));
    cameraPreviewDirty = false;
  }

  // Cancel pending callbacks when the panel disappears or another update wins.
  $effect(() => {
    if (cameraPreviewDirty && cameraPreviewCanvas && cameraPlaced) {
      previewAnimId = requestAnimationFrame(() => {
        previewAnimId = undefined;
        updateCameraMarkerFromState();
        renderCameraPreview();
      });
      return () => {
        if (previewAnimId !== undefined) cancelAnimationFrame(previewAnimId);
        previewAnimId = undefined;
      };
    }
  });

  // 3D Furniture Placement
  let furniturePlacementMode = $state(false);
  let selectedCatalogId = $state<string | null>(null);
  let furniturePickerCategory = $state<string>('Kitchen');
  let ghostGroup: THREE.Group | null = null;
  let floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0 plane
  let ghostIntersection = new THREE.Vector3();

  const TIME_PRESETS = {
    morning: { azimuth: 90, elevation: 25, ambient: 0.3, sunColor: 0xffe0a0, sunIntensity: 0.8, skyTop: '#f5a86c', skyMid: '#fdd89b', skyHorizon: '#ffe8c0', hemiSky: '#fdd89b', hemiGround: '#9b8060' },
    noon:    { azimuth: 180, elevation: 80, ambient: 0.45, sunColor: 0xffffff, sunIntensity: 1.2, skyTop: '#3a7bd5', skyMid: '#87ceeb', skyHorizon: '#c8e8f8', hemiSky: '#87ceeb', hemiGround: '#8b7355' },
    evening: { azimuth: 270, elevation: 15, ambient: 0.2, sunColor: 0xff8040, sunIntensity: 0.6, skyTop: '#2d1b69', skyMid: '#c84e3c', skyHorizon: '#f4a460', hemiSky: '#c84e3c', hemiGround: '#4a3520' },
    night:   { azimuth: 0, elevation: 5, ambient: 0.08, sunColor: 0x8899cc, sunIntensity: 0.15, skyTop: '#0a0a2e', skyMid: '#141432', skyHorizon: '#1a1a3e', hemiSky: '#141432', hemiGround: '#0a0a15' },
  };

  function updateSunPosition() {
    if (!sunLight) return;
    const azRad = (sunAzimuth * Math.PI) / 180;
    const elRad = (sunElevation * Math.PI) / 180;
    const dist = 1500;
    sunLight.position.set(
      dist * Math.cos(elRad) * Math.sin(azRad),
      dist * Math.sin(elRad),
      dist * Math.cos(elRad) * Math.cos(azRad)
    );
    markSceneDirty();
  }

  function updateAmbientIntensity() {
    if (ambientLight) ambientLight.intensity = ambientIntensity;
    markSceneDirty();
  }

  function updateSkyGradient(topColor: string, midColor: string, horizonColor: string) {
    if (!skyCanvas || !skyTexture) return;
    const cx = skyCanvas.getContext('2d')!;
    const grad = cx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, topColor);
    grad.addColorStop(0.4, midColor);
    grad.addColorStop(0.55, horizonColor);
    grad.addColorStop(0.7, '#d4cfc4');
    grad.addColorStop(1.0, '#b8b0a0');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, 4, 512);
    skyTexture.needsUpdate = true;
  }

  function applyTimePreset(preset: 'morning' | 'noon' | 'evening' | 'night') {
    const p = TIME_PRESETS[preset];
    timeOfDay = preset;
    sunAzimuth = p.azimuth;
    sunElevation = p.elevation;
    ambientIntensity = p.ambient;
    updateSunPosition();
    updateAmbientIntensity();
    if (sunLight) {
      sunLight.color.set(p.sunColor);
      sunLight.intensity = p.sunIntensity;
    }
    if (hemiLight) {
      hemiLight.color.set(p.hemiSky);
      hemiLight.groundColor.set(p.hemiGround);
      hemiLight.intensity = preset === 'night' ? 0.1 : 0.4;
    }
    if (fillLight) fillLight.intensity = preset === 'night' ? 0.05 : 0.4;
    if (rimLight) rimLight.intensity = preset === 'night' ? 0.05 : 0.25;
    updateSkyGradient(p.skyTop, p.skyMid, p.skyHorizon);
  }

  const WALL_THICKNESS = 15;
  const BASEBOARD_HEIGHT = 8;

  // Create a canvas-based floor texture
  function createFloorTexture(): THREE.CanvasTexture {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const cx = c.getContext('2d')!;
    // Hardwood pattern
    cx.fillStyle = '#c4a882';
    cx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 32) {
      for (let x = 0; x < size; x += 64) {
        const offset = (y / 32) % 2 === 0 ? 0 : 32;
        cx.fillStyle = y % 64 < 32 ? '#b89b72' : '#d4b892';
        cx.fillRect(x + offset, y, 62, 30);
        cx.strokeStyle = '#a08060';
        cx.lineWidth = 0.5;
        cx.strokeRect(x + offset, y, 62, 30);
      }
    }
    const tex = ownTexture(new THREE.CanvasTexture(c));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(10, 10);
    return tex;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (hasOpenModal()) return;
    if (isEditingField(event.target)) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const id = get(selectedElementId);
      if (id) {
        removeElement(id);
        selectedElementId.set(null);
        activeFurnitureId3D = null;
      }
      return;
    }
    // ESC exits edit mode
    if (event.code === 'Escape' && editMode) {
      if (furniturePlacementMode) {
        furniturePlacementMode = false;
        selectedCatalogId = null;
        removeGhostPreview();
        return;
      }
      if (materialPickerWall) {
        materialPickerWall = null;
        materialPickerPos = null;
        return;
      }
      editMode = false;
      selectedElementId.set(null);
      activeFurnitureId3D = null;
      return;
    }
    // Escape also just deselects outside edit mode, same as clicking empty space.
    if (event.code === 'Escape' && get(selectedElementId)) {
      selectedElementId.set(null);
      activeFurnitureId3D = null;
    }
  }

  function init() {
    scene = new THREE.Scene();

    // Sky dome — hemisphere with gradient texture mapped inside
    skyCanvas = document.createElement('canvas');
    skyCanvas.width = 4; skyCanvas.height = 512;
    const cx = skyCanvas.getContext('2d')!;
    const grad = cx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#4a90d9');
    grad.addColorStop(0.3, '#87ceeb');
    grad.addColorStop(0.5, '#b8ddf0');
    grad.addColorStop(0.55, '#f0ece4');
    grad.addColorStop(0.7, '#d4cfc4');
    grad.addColorStop(1.0, '#b8b0a0');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, 4, 512);
    skyTexture = ownTexture(new THREE.CanvasTexture(skyCanvas));
    // Use as scene background (maps onto equirectangular projection)
    skyTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = skyTexture;

    // Ground plane — textured concrete with grid overlay
    const groundSize = 40000;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
    // Generate a subtle concrete texture with grid
    const groundCanvas = document.createElement('canvas');
    groundCanvas.width = 1024; groundCanvas.height = 1024;
    const gctx = groundCanvas.getContext('2d')!;
    // Base concrete color with noise
    gctx.fillStyle = '#c8c2b8';
    gctx.fillRect(0, 0, 1024, 1024);
    // Add subtle noise for concrete feel
    for (let i = 0; i < 30000; i++) {
      const nx = Math.random() * 1024;
      const ny = Math.random() * 1024;
      const v = 180 + Math.random() * 30;
      gctx.fillStyle = `rgba(${v},${v-5},${v-12},0.15)`;
      gctx.fillRect(nx, ny, 2, 2);
    }
    // Grid lines every 128px (= 500cm real-world at current repeat)
    gctx.strokeStyle = 'rgba(0,0,0,0.08)';
    gctx.lineWidth = 1;
    const gridStep = 128;
    for (let x = 0; x <= 1024; x += gridStep) {
      gctx.beginPath(); gctx.moveTo(x, 0); gctx.lineTo(x, 1024); gctx.stroke();
    }
    for (let y = 0; y <= 1024; y += gridStep) {
      gctx.beginPath(); gctx.moveTo(0, y); gctx.lineTo(1024, y); gctx.stroke();
    }
    // Thicker lines every 4 grid cells (= 2000cm / 20m)
    gctx.strokeStyle = 'rgba(0,0,0,0.15)';
    gctx.lineWidth = 2;
    for (let x = 0; x <= 1024; x += gridStep * 4) {
      gctx.beginPath(); gctx.moveTo(x, 0); gctx.lineTo(x, 1024); gctx.stroke();
    }
    for (let y = 0; y <= 1024; y += gridStep * 4) {
      gctx.beginPath(); gctx.moveTo(0, y); gctx.lineTo(1024, y); gctx.stroke();
    }
    const groundTex = ownTexture(new THREE.CanvasTexture(groundCanvas));
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(groundSize / 4000, groundSize / 4000);
    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTex,
      roughness: 0.92,
      metalness: 0
    });
    groundMat.polygonOffset = true;
    groundMat.polygonOffsetFactor = 2;
    groundMat.polygonOffsetUnits = 2;
    const ground = new THREE.Mesh(groundGeo, groundMat);
    sceneGround = ground;
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    ground.receiveShadow = true;
    scene.add(ground);

    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 1, 20000);
    // Placeholder pose only — positionCameraInterior() (run from the first
    // buildWalls()) puts it inside the active room before the first real paint.
    camera.position.set(0, 150, 500);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true; // right-drag pans the whole scene, in parallel, no rotation
    controls.screenSpacePanning = true; // pan follows the mouse in screen space, not along the ground plane
    controls.enableZoom = false; // wheel zoom is handled manually below (symmetric step)
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    // Free rotation and viewing height, confined by enforceRoomBounds() to
    // stay between the floor and ceiling — this just avoids the near-vertical
    // poles where OrbitControls' own spherical math degenerates.
    controls.minPolarAngle = Math.PI * 0.05;
    controls.maxPolarAngle = Math.PI * 0.95;
    controls.addEventListener('change', markSceneDirty);
    renderer.domElement.addEventListener('wheel', onOrbitWheel, { passive: false });
    // The right button pans (see mouseButtons above); it must never fall
    // through to the browser's native right-click menu.
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    // While the right button pans, suspend the room-bounds clamp (see animate()) —
    // it clamps the camera's distance from orbitTarget every frame, which would
    // otherwise fight a pan that only moves the target, pulling the camera back
    // and introducing an unwanted apparent rotation instead of a clean translate.
    // The default framing already sits exactly at the room-bounds clamp limit
    // (positionCameraInterior() pulls the camera in to that same boundary), so
    // once a pan moves the camera away from that pose, resuming the clamp on
    // any timer would immediately "correct" it again — there's no safe delay
    // for that. Instead, suspend it for the rest of the pan session entirely,
    // and only resume on the next deliberate rotate (or a wheel zoom, which
    // re-clamps itself directly in onOrbitWheel regardless of this flag).
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 2) panningCamera = true;
      else if (e.button === 0) panningCamera = false;
    });

    // Click-to-select walls/furniture via raycasting, and grab-to-move furniture
    let pointerDownPos = { x: 0, y: 0 };
    let furnitureGestureStarted = false;
    // pointerup always re-raycasts against walls to select/deselect them; when the
    // press landed on furniture instead, that wall pass must not clobber the
    // furniture selection it just made.
    let pointerDownHitFurniture = false;
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // left button only — right button pans the camera
      pointerDownPos = { x: e.clientX, y: e.clientY };
      pointerDownHitFurniture = false;
      if (cameraPlacementMode || furniturePlacementMode) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObjects(furnitureObjects, true)[0];
      const hitId = hit ? findFurnitureIdFromObject(hit.object) : null;
      const fi = hitId ? currentFloor?.furniture.find(f => f.id === hitId) : null;
      if (!fi || fi.locked) return;
      pointerDownHitFurniture = true;
      selectedElementId.set(hitId);
      materialPickerWall = null; materialPickerPos = null;
      // A plain click only selects; only an already-activated item (double-click
      // first) actually starts a drag — see the dblclick listener below.
      if (hitId !== activeFurnitureId3D) return;
      const floorHit = new THREE.Vector3();
      furnitureDragOffset.x = 0; furnitureDragOffset.z = 0;
      if (raycaster.ray.intersectPlane(floorPlane, floorHit)) {
        furnitureDragOffset.x = floorHit.x - fi.position.x;
        furnitureDragOffset.z = floorHit.z - fi.position.y;
      }
      draggingFurnitureId = hitId;
      furnitureGestureStarted = false;
      controls.enabled = false;
    });
    renderer.domElement.addEventListener('dblclick', (e) => {
      if (e.button !== 0) return;
      if (cameraPlacementMode || furniturePlacementMode) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObjects(furnitureObjects, true)[0];
      const hitId = hit ? findFurnitureIdFromObject(hit.object) : null;
      const fi = hitId ? currentFloor?.furniture.find(f => f.id === hitId) : null;
      if (!fi || fi.locked) return;
      activeFurnitureId3D = hitId;
      selectedElementId.set(hitId);
      markSceneDirty();
    });
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!draggingFurnitureId) return;
      if (!furnitureGestureStarted) {
        if (Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) < 3) return;
        beginUndoGroup();
        furnitureGestureStarted = true;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(floorPlane, hit)) return;
      const basePos = { x: hit.x - furnitureDragOffset.x, y: hit.z - furnitureDragOffset.z };
      const fi = currentFloor?.furniture.find(f => f.id === draggingFurnitureId);
      const snapSettings = get(projectSettings);
      if (fi && currentFloor && snapSettings.snapToWalls) {
        const wallSnap = snapFurnitureToWalls(basePos, fi, currentFloor.walls, undefined, snapSettings.wallSnapDistance);
        if (wallSnap) {
          // The wall always wins rotation; the neighbor only adjusts position along the row.
          const neighborHit = snapFurnitureToNeighbors(wallSnap.position, fi, currentFloor.furniture, snapSettings.neighborSnapDistance, draggingFurnitureId);
          dragWallSnapId = wallSnap.wallId;
          dragNeighborSnapId = neighborHit ? neighborHit.neighborId : null;
          transformFurnitureDuringDrag(draggingFurnitureId, { position: neighborHit ? neighborHit.position : wallSnap.position, rotation: wallSnap.rotation });
          return;
        }
        const neighborHit = snapFurnitureToNeighbors(basePos, fi, currentFloor.furniture, snapSettings.neighborSnapDistance, draggingFurnitureId);
        dragWallSnapId = null;
        dragNeighborSnapId = neighborHit ? neighborHit.neighborId : null;
        transformFurnitureDuringDrag(draggingFurnitureId, {
          position: neighborHit ? neighborHit.position : basePos,
          ...(neighborHit ? { rotation: neighborHit.rotation } : {}),
        });
        return;
      }
      dragWallSnapId = null;
      dragNeighborSnapId = null;
      transformFurnitureDuringDrag(draggingFurnitureId, { position: basePos });
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return; // left button only — right button pans the camera
      if (draggingFurnitureId) {
        if (furnitureGestureStarted) endUndoGroup(td('undo.movedFurniture'));
        draggingFurnitureId = null;
        furnitureGestureStarted = false;
        controls.enabled = true;
        dragWallSnapId = null;
        dragNeighborSnapId = null;
        wallSnapHighlight.clear();
        neighborSnapHighlight.clear();
        markSceneDirty();
        return;
      }
      // The matching pointerdown already selected furniture; don't let the
      // wall-only raycast below immediately deselect it again.
      if (pointerDownHitFurniture) return;
      // Only select if the mouse didn't move much (not a drag/orbit)
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (Math.hypot(dx, dy) > 5) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      // Camera placement mode: first click = position, second click = look-at target
      if (cameraPlacementMode) {
        const hit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(floorPlane, hit)) {
          if (!cameraPlaced) {
            // First click: place camera position
            cameraPosition = { x: hit.x, y: cameraHeight, z: hit.z };
            cameraLookAt = { x: hit.x + 200, y: cameraHeight * 0.75, z: hit.z };
            cameraBaseDir = { x: 1, z: 0 };
            cameraYaw = 0;
            cameraPitch = 0;
            cameraPlaced = true;
            updateInteriorCamera();
            createCameraMarker(new THREE.Vector3(hit.x, 0, hit.z), new THREE.Vector3(hit.x + 200, 0, hit.z));
            cameraPreviewOpen = true;
            cameraPreviewDirty = true;
          } else {
            // Second click: set look-at direction
            cameraLookAt = { x: hit.x, y: cameraHeight * 0.75, z: hit.z };
            const dx = hit.x - cameraPosition.x;
            const dz = hit.z - cameraPosition.z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            cameraBaseDir = { x: dx / len, z: dz / len };
            cameraYaw = 0;
            cameraPitch = 0;
            updateInteriorCamera();
            createCameraMarker(
              new THREE.Vector3(cameraPosition.x, 0, cameraPosition.z),
              new THREE.Vector3(hit.x, 0, hit.z)
            );
            cameraPlacementMode = false;
            cameraPreviewDirty = true;
          }
        }
        return;
      }

      // Furniture placement mode: place on floor
      if (furniturePlacementMode && selectedCatalogId) {
        raycaster.setFromCamera(mouse, camera);
        const hit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(floorPlane, hit)) {
          // Convert 3D (x, z) to 2D (x, y)
          const pos2D = { x: hit.x, y: hit.z };
          // Mirror the 2D placement flow: snap to a wall if one is close enough
          // (neighbor-snap only kicks in once the item exists and gets dragged).
          const snapSettings = get(projectSettings);
          const catalogDef = getCatalogItemOrFallback(selectedCatalogId);
          const wallSnap = currentFloor && snapSettings.snapToWalls
            ? snapFurnitureToWalls(pos2D, catalogDef, currentFloor.walls, undefined, snapSettings.wallSnapDistance)
            : null;
          const finalPos = wallSnap ? wallSnap.position : pos2D;
          const id = addFurniture(selectedCatalogId, finalPos);
          if (wallSnap) rotateFurniture(id, wallSnap.rotation);
          selectedElementId.set(id);
          if (!e.shiftKey) {
            // Match the 2D flow: exit placement mode after one item so the
            // next click selects/drags it instead of stamping another copy.
            // Hold Shift to keep placing repeats of the same item.
            furniturePlacementMode = false;
            selectedCatalogId = null;
            removeGhostPreview();
          }
          // Scene will rebuild via store subscription
        }
        return;
      }

      const intersects = raycaster.intersectObjects(wallGroup.children, false);
      let hitWallId: string | null = null;
      for (const hit of intersects) {
        if (hit.object.userData.wallId) {
          hitWallId = hit.object.userData.wallId;
          break;
        }
      }
      selectedElementId.set(hitWallId);
      activeFurnitureId3D = null;

      // Show/hide material picker
      if (hitWallId && currentFloor) {
        const hitWall = currentFloor.walls.find(w => w.id === hitWallId) ?? null;
        materialPickerWall = hitWall;
        materialPickerPos = { x: e.clientX, y: e.clientY };
      } else {
        materialPickerWall = null;
        materialPickerPos = null;
      }
    });

    // Hover highlight in edit mode
    let hoveredMesh: THREE.Mesh | null = null;
    renderer.domElement.addEventListener('mousemove', (e) => {
      // Furniture placement ghost preview
      if (editMode && furniturePlacementMode && selectedCatalogId) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(floorPlane, hit)) {
          if (!ghostGroup) {
            createGhostPreview(selectedCatalogId);
          }
          if (ghostGroup) {
            // Preview the same hang height the placed module will actually get,
            // so a wall-tier ghost doesn't misleadingly hover at floor level.
            const previewTier = getCatalogItemOrFallback(selectedCatalogId).tier ?? 'base';
            const previewElevation = previewTier === 'wall' ? get(projectSettings).wallCabinetHangHeight : 0;
            ghostGroup.position.set(hit.x, hit.y + 1.5 + previewElevation, hit.z);
            ghostGroup.visible = true;
          }
        } else if (ghostGroup) {
          ghostGroup.visible = false;
        }
        markSceneDirty();
        renderer.domElement.style.cursor = 'crosshair';
        return;
      } else if (ghostGroup?.visible) {
        ghostGroup.visible = false;
        markSceneDirty();
      }

      if (!editMode) {
        if (hoveredMesh) { hoveredMesh = null; renderer.domElement.style.cursor = ''; }
        return;
      }
      renderer.domElement.style.cursor = 'pointer';
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(wallGroup.children, false);
      const hit = intersects.find(i => i.object.userData.wallId);
      if (hit && hit.object !== hoveredMesh) {
        hoveredMesh = hit.object as THREE.Mesh;
        renderer.domElement.style.cursor = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="%23fff" stroke="%23000" stroke-width="1.5" d="M16.56 8.94L7.62 0 6.21 1.41l2.38 2.38-5.15 5.15a1.49 1.49 0 0 0 0 2.12l5.5 5.5a1.49 1.49 0 0 0 2.12 0l5.5-5.5a1.49 1.49 0 0 0 0-2.12zM5.21 10L10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5a2 2 0 1 0 4 0c0-1.33-2-3.5-2-3.5z"/></svg>') + '") 2 22, pointer';
      } else if (!hit) {
        hoveredMesh = null;
        renderer.domElement.style.cursor = editMode ? 'crosshair' : '';
      }
    });

    document.addEventListener('keydown', onKeyDown, false);

    // Lights — improved multi-source setup
    ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambientLight);
    hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.4);
    scene.add(hemiLight);

    // Key light (sun)
    sunLight = new THREE.DirectionalLight(0xfff8e7, 1.0);
    sunLight.position.set(500, 1200, 800);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.left = -1500;
    sunLight.shadow.camera.right = 1500;
    sunLight.shadow.camera.top = 1500;
    sunLight.shadow.camera.bottom = -1500;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);

    // Fill light — softer, opposite side to reduce harsh shadows
    fillLight = new THREE.DirectionalLight(0xc8d8f0, 0.4);
    fillLight.position.set(-600, 800, -400);
    scene.add(fillLight);

    // Rim/back light for depth
    rimLight = new THREE.DirectionalLight(0xffe4c4, 0.25);
    rimLight.position.set(-200, 600, 1000);
    scene.add(rimLight);

    // Textured floor
    const floorTex = createFloorTexture();
    const floorGeo = new THREE.PlaneGeometry(4000, 4000);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, side: THREE.DoubleSide, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = 0.5;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    wallGroup = new THREE.Group();
    scene.add(wallGroup);
  }

  function createGhostPreview(catalogId: string) {
    removeGhostPreview();
    const cat = getCatalogItem(catalogId);
    if (!cat || cat.symbol) return;
    const model = createFurnitureModelWithGLB(catalogId, cat, markSceneDirty, { ghost: true });
    model.visible = false;
    ghostGroup = model;
    scene.add(ghostGroup);
  }

  function removeGhostPreview() {
    if (ghostGroup) {
      scene.remove(ghostGroup);
      disposeModel(ghostGroup);
      ghostGroup = null;
      markSceneDirty();
    }
  }

  /** Distance from ray origin (ox,oz)+t*(dx,dz) to a segment a-b, or null if
   *  the ray (t>0) doesn't cross it. Plan coordinates: .x/.y map to world x/z. */
  function raySegmentDistance(ox: number, oz: number, dx: number, dz: number, a: Point, b: Point): number | null {
    const ex = b.x - a.x, ez = b.y - a.y;
    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((a.x - ox) * ez - (a.y - oz) * ex) / denom;
    const u = ((a.x - ox) * dz - (a.y - oz) * dx) / denom;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) return t;
    return null;
  }

  /** Distance from (ox,oz) to the nearest edge of roomBoundaryPoly along a
   *  normalized (dx,dz) direction, or null if the boundary isn't crossed. */
  function raycastRoomBoundary(ox: number, oz: number, dx: number, dz: number): number | null {
    if (roomBoundaryPoly.length < 3) return null;
    let best: number | null = null;
    for (let i = 0; i < roomBoundaryPoly.length; i++) {
      const t = raySegmentDistance(ox, oz, dx, dz, roomBoundaryPoly[i], roomBoundaryPoly[(i + 1) % roomBoundaryPoly.length]);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }

  /** Keeps the camera strictly inside the room's own volume — the four walls
   *  horizontally (via a same-direction raycast from the orbit target to the
   *  room's boundary, so it works for L/T/U shapes too, not just rectangles),
   *  and the floor/ceiling vertically. No exterior view is possible in
   *  principle: the camera can never sit on or past a wall, floor or
   *  ceiling, whichever way the user rotates or zooms. */
  function enforceRoomBounds() {
    const dx = camera.position.x - orbitTarget.x;
    const dz = camera.position.z - orbitTarget.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz > 1e-6 && roomBoundaryPoly.length >= 3) {
      const dirX = dx / horiz, dirZ = dz / horiz;
      const boundaryDist = raycastRoomBoundary(orbitTarget.x, orbitTarget.z, dirX, dirZ);
      const maxR = boundaryDist !== null ? Math.max(ORBIT_MIN_RADIUS, boundaryDist - ORBIT_WALL_MARGIN) : horiz;
      const clamped = Math.min(horiz, maxR);
      if (clamped !== horiz) {
        camera.position.x = orbitTarget.x + dirX * clamped;
        camera.position.z = orbitTarget.z + dirZ * clamped;
      }
    }
    camera.position.y = Math.min(Math.max(camera.position.y, roomFloorY + ORBIT_FLOOR_MARGIN), roomCeilingY - ORBIT_CEILING_MARGIN);
  }

  function setWallMeshVisible(wallId: string, visible: boolean) {
    for (const [mesh, id] of wallMeshMap) {
      if (id === wallId && mesh instanceof THREE.Mesh) mesh.visible = visible;
    }
  }

  /** Hides whichever room wall the camera has backed up against, so orbiting
   *  close to a wall (confined just inside it by enforceRoomBounds) doesn't
   *  fill the frame with its own surface. Walls show again once the camera
   *  pulls away from them. */
  function updateWallCulling() {
    let nearestId: string | null = null, nearestDist = Infinity;
    if (currentFloor) {
      for (const id of roomWallIds) {
        const wall = currentFloor.walls.find(w => w.id === id);
        if (!wall) continue;
        const d = pointToSegmentDist({ x: camera.position.x, y: camera.position.z }, wall.start, wall.end);
        if (d < nearestDist) { nearestDist = d; nearestId = id; }
      }
    }
    const target = nearestId !== null && nearestDist < ORBIT_CULL_DISTANCE ? nearestId : null;
    if (target !== culledWallId) {
      if (culledWallId) setWallMeshVisible(culledWallId, true);
      if (target) setWallMeshVisible(target, false);
      culledWallId = target;
    }
  }

  /** Symmetric zoom: the same fixed step in cm either way, so equal scroll
   *  gestures forward and back always cancel out exactly. */
  function onOrbitWheel(e: WheelEvent) {
    e.preventDefault();
    const dir = new THREE.Vector3().subVectors(camera.position, orbitTarget);
    const dist = dir.length();
    if (dist < 1e-6) return;
    const next = dist + Math.sign(e.deltaY) * ORBIT_ZOOM_STEP;
    dir.setLength(Math.max(ORBIT_MIN_RADIUS, next));
    camera.position.copy(orbitTarget).add(dir);
    enforceRoomBounds();
    updateWallCulling();
    markSceneDirty();
  }

  /** Places the orbit's pivot at the active floor's largest room center and
   *  frames the whole room by default. This is the only camera there is —
   *  it never frames the building from outside. */
  function positionCameraInterior() {
    if (!currentFloor) return;
    const rooms = detectRooms(currentFloor.walls);
    let poly: Point[] = [];
    let wallIds: string[] = [];
    let ceilingHeight = 270;
    if (rooms.length > 0) {
      let largestRoom = rooms[0];
      let largestArea = 0;
      for (const room of rooms) {
        if (room.area > largestArea) { largestArea = room.area; largestRoom = room; }
      }
      poly = getRoomPolygon(largestRoom, currentFloor.walls);
      wallIds = largestRoom.walls;
      ceilingHeight = roomCeilingHeight(largestRoom.walls, currentFloor.walls)
        ?? Math.max(...largestRoom.walls.map(id => {
          const w = currentFloor!.walls.find(x => x.id === id);
          return w ? Math.max(getWallStartHeight(w), getWallEndHeight(w)) : 0;
        }), 270);
    } else if (currentFloor.walls.length > 0) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const w of currentFloor.walls) {
        for (const p of [w.start, w.end]) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
        }
      }
      poly = [{ x: minX, y: minZ }, { x: maxX, y: minZ }, { x: maxX, y: maxZ }, { x: minX, y: maxZ }];
      ceilingHeight = Math.max(...currentFloor.walls.map(w => Math.max(getWallStartHeight(w), getWallEndHeight(w))), 270);
    }
    const centroid = poly.length > 0 ? roomCentroid(poly) : { x: 0, y: 0 };

    roomBoundaryPoly = poly;
    roomWallIds = wallIds;
    roomFloorY = activeFloorElevation;
    roomCeilingY = activeFloorElevation + ceilingHeight;
    orbitTarget.set(centroid.x, activeFloorElevation + Math.min(ceilingHeight * 0.55, 160), centroid.y);
    controls.target.copy(orbitTarget);

    // Default framing: an elevated 3/4 view pulled back toward the room's
    // edge — enforceRoomBounds() below finds the exact safe distance in that
    // direction, confined inside the room's own walls/floor/ceiling.
    const azimuth = Math.PI / 4;
    camera.position.set(
      orbitTarget.x + Math.sin(azimuth) * 5000,
      orbitTarget.y + 3000,
      orbitTarget.z + Math.cos(azimuth) * 5000
    );
    enforceRoomBounds();
    culledWallId = null; // walls were just rebuilt — the old hidden mesh no longer applies
    updateWallCulling();
    cameraPositioned = true;
  }

  /** Generate a wall texture. wallWidth/wallHeight in cm to set proper tiling. */
  function generateWallTexture(textureId: string, color: string, wallWidth: number = 300, wallHeight: number = 280): THREE.CanvasTexture {
    const canvas = getWallTextureCanvas(textureId, color);
    if (!canvas) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const cx = c.getContext('2d')!;
      cx.fillStyle = color;
      cx.fillRect(0, 0, 64, 64);
      const tex = ownTexture(new THREE.CanvasTexture(c));
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return tex;
    }
    const tex = ownTexture(new THREE.CanvasTexture(canvas));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // Each texture tile covers ~200cm of real wall
    const tileSizeCm = 200;
    tex.repeat.set(wallWidth / tileSizeCm, wallHeight / tileSizeCm);
    return tex;
  }

  function buildColumns(floor: Floor) {
    if (!floor.columns) return;
    for (const col of floor.columns) {
      const h = col.height || 280;
      const d = col.diameter || 30;
      let geo: THREE.BufferGeometry;
      if (col.shape === 'square') {
        geo = new THREE.BoxGeometry(d, h, d);
      } else {
        geo = new THREE.CylinderGeometry(d / 2, d / 2, h, 24);
      }
      const mat = new THREE.MeshStandardMaterial({ color: col.color || '#cccccc', roughness: 0.7 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(col.position.x, h / 2, col.position.y);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      wallGroup.add(mesh);
    }
  }

  function clearGroup(group: THREE.Object3D) {
    disposeModel(group);
    group.clear();
  }

  function addOpeningFrame(wall: Wall, position: number, width: number, bottom: number, height: number, depth: number, material: THREE.Material) {
    const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    const rect = openingOnWall(length, getWallStartHeight(wall), getWallEndHeight(wall), position, width, bottom, height);
    if (!rect) return;
    const t = (rect.left + rect.right) / 2 / length;
    const geo = new THREE.BoxGeometry(rect.right - rect.left, rect.top - rect.bottom, depth);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(wall.start.x + (wall.end.x - wall.start.x) * t, (rect.bottom + rect.top) / 2, wall.start.y + (wall.end.y - wall.start.y) * t);
    mesh.rotation.y = -Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
    mesh.castShadow = true;
    wallGroup.add(mesh);
  }

  function buildWalls(floor: Floor) {
    wallHighlight.clear();
    furnitureHighlight.clear();
    wallSnapHighlight.clear();
    neighborSnapHighlight.clear();
    clearGroup(wallGroup);
    cameraHelper = null;
    wallMeshMap.clear();
    furnitureMeshMap.clear();
    furnitureObjects = [];

    const defaultInteriorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const defaultExteriorMat = new THREE.MeshStandardMaterial({ color: 0xd4cfc9, roughness: 0.85 });
    const baseboardMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d4, roughness: 0.7 });

    for (const wall of floor.walls) {
      // Resolve per-side materials: interior and exterior can have independent color/texture
      const DEFAULT_2D_COLORS = ['#cccccc', '#888888', '#444444', '#404040'];
      const wLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

      function resolveWallMat(color: string | undefined, texture: string | undefined, fallback: THREE.MeshStandardMaterial, isInterior: boolean = false): THREE.MeshStandardMaterial {
        const polyOff = isInterior ? { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } : {};
        if (texture) {
          const tex = generateWallTexture(texture, color || '#888888', wLen, wall.height);
          return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, ...polyOff });
        }
        if (color && !DEFAULT_2D_COLORS.includes(color.toLowerCase())) {
          return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.9, ...polyOff });
        }
        return fallback;
      }

      // Interior: use interiorColor/interiorTexture if set, else fall back to wall.color/wall.texture
      // 'none' means explicitly no texture (overrides shared wall.texture)
      const intTex = wall.interiorTexture === 'none' ? undefined : (wall.interiorTexture || wall.texture);
      let interiorMat = resolveWallMat(
        wall.interiorColor || wall.color,
        intTex,
        defaultInteriorMat,
        true
      );
      // Exterior: use exteriorColor/exteriorTexture if set, else fall back to wall.color/wall.texture (auto-darkened)
      const extTex = wall.exteriorTexture === 'none' ? undefined : (wall.exteriorTexture || wall.texture);
      let exteriorMat: THREE.MeshStandardMaterial;
      if (extTex || wall.exteriorColor) {
        exteriorMat = resolveWallMat(wall.exteriorColor, extTex, defaultExteriorMat);
      } else if (wall.texture) {
        const extTex = generateWallTexture(wall.texture, wall.color || '#888888', wLen, wall.height);
        exteriorMat = new THREE.MeshStandardMaterial({ map: extTex, roughness: 0.85 });
      } else if (wall.color && !DEFAULT_2D_COLORS.includes(wall.color.toLowerCase())) {
        const c = new THREE.Color(wall.color).offsetHSL(0, -0.05, -0.1);
        exteriorMat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
      } else {
        exteriorMat = defaultExteriorMat;
      }
      const startH = getWallStartHeight(wall);
      const endH = getWallEndHeight(wall);

      // Curved wall handling
      if (wall.curvePoint) {
        const t = Math.max(wall.thickness, WALL_THICKNESS);
        const materials = [
          exteriorMat, exteriorMat,
          interiorMat, interiorMat,
          interiorMat, exteriorMat,
        ];
        for (const span of wallPathSpans(wall)) {
          const p0x = span.start.x, p0y = span.start.y, p1x = span.end.x, p1y = span.end.y;
          const segLen = Math.hypot(p1x - p0x, p1y - p0y);
          if (segLen < 0.5) continue;
          const segAngle = Math.atan2(p1y - p0y, p1x - p0x);
          const segCx = (p0x + p1x) / 2;
          const segCy = (p0y + p1y) / 2;
          const segStartH = span.startHeight;
          const segEndH = span.endHeight;
          const geo = createSlopedBoxGeometry(segLen, t, 0, segStartH, segEndH);
          const mesh = new THREE.Mesh(geo, materials);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.position.set(segCx, 0, segCy);
          mesh.rotation.y = -segAngle;
          mesh.userData.wallId = wall.id;
          wallMeshMap.set(mesh, wall.id);
          wallGroup.add(mesh);
        }
        // Baseboard for curved wall
        if (Math.min(startH, endH) >= BASEBOARD_HEIGHT) {
            for (const span of wallPathSpans(wall)) {
              const p0x = span.start.x, p0y = span.start.y, p1x = span.end.x, p1y = span.end.y;
              const segLen = Math.hypot(p1x - p0x, p1y - p0y);
              if (segLen < 0.5) continue;
              const segAngle = Math.atan2(p1y - p0y, p1x - p0x);
              const bbGeo = new THREE.BoxGeometry(segLen, BASEBOARD_HEIGHT, t + 2);
              const bbMesh = new THREE.Mesh(bbGeo, baseboardMat);
              bbMesh.position.set((p0x + p1x) / 2, BASEBOARD_HEIGHT / 2, (p0y + p1y) / 2);
              bbMesh.rotation.y = -segAngle;
              bbMesh.castShadow = true;
              wallGroup.add(bbMesh);
            }
          }
          continue;
        }

        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;

        const t = Math.max(wall.thickness, WALL_THICKNESS);
        const angle = Math.atan2(dy, dx);
        const cx = (wall.start.x + wall.end.x) / 2;
        const cy = (wall.start.y + wall.end.y) / 2;

        const winOpenings = floor.windows.filter((w) => w.wallId === wall.id);
        const segments = buildWallSegments(len, startH, endH, winOpenings);

        for (const seg of segments) {
          const geo = createSlopedBoxGeometry(seg.width, t, seg.bottomY, seg.topYLeft, seg.topYRight);

          // Create a multi-material wall: interior white, exterior brown
          const materials = [
            exteriorMat, exteriorMat, // left, right
            interiorMat, interiorMat, // top, bottom
            interiorMat, exteriorMat, // front (interior), back (exterior)
          ];
          const mesh = new THREE.Mesh(geo, materials);
          mesh.castShadow = true;
          mesh.receiveShadow = true;

          const localX = seg.offsetX - len / 2;
          mesh.position.set(
            cx + localX * Math.cos(angle),
            0,
            cy + localX * Math.sin(angle)
          );
          mesh.rotation.y = -angle;
          mesh.userData.wallId = wall.id;
          wallMeshMap.set(mesh, wall.id);
          wallGroup.add(mesh);
        }

        // Baseboard
        if (Math.min(startH, endH) >= BASEBOARD_HEIGHT) {
          const bbGeo = new THREE.BoxGeometry(len, BASEBOARD_HEIGHT, t + 2);
          const bbMesh = new THREE.Mesh(bbGeo, baseboardMat);
          bbMesh.position.set(cx, BASEBOARD_HEIGHT / 2, cy);
          bbMesh.rotation.y = -angle;
          bbMesh.castShadow = true;
          wallGroup.add(bbMesh);
        }
      }
    // Windows
    for (const sourceWindow of floor.windows) {
      const wall = floor.walls.find((w) => w.id === sourceWindow.wallId);
      if (!wall) continue;
      const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
      const opening = openingOnWall(length, getWallStartHeight(wall), getWallEndHeight(wall), sourceWindow.position, sourceWindow.width, sourceWindow.sillHeight ?? 90, sourceWindow.height);
      if (!opening || opening.top - opening.bottom <= 4 || opening.right - opening.left <= 4) continue;
      const win = { ...sourceWindow, width: opening.right - opening.left, position: (opening.left + opening.right) / 2 / length, sillHeight: opening.bottom };
      const t = win.position;
      const px = wall.start.x + (wall.end.x - wall.start.x) * t;
      const py = wall.start.y + (wall.end.y - wall.start.y) * t;
      const angle = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
      const wt = Math.max(wall.thickness, WALL_THICKNESS);
      const effectiveWinH = opening.top - opening.bottom;
      const winCY = win.sillHeight + effectiveWinH / 2;

      const frameMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.4, metalness: 0.1 });
      const mullionW = 4; // mullion bar width

      // Outer frame — 4 bars forming rectangle
      const bars: { w: number; h: number; ox: number; oy: number }[] = [
        { w: win.width + mullionW * 2, h: mullionW, ox: 0, oy: -effectiveWinH / 2 - mullionW / 2 }, // bottom
        { w: win.width + mullionW * 2, h: mullionW, ox: 0, oy: effectiveWinH / 2 + mullionW / 2 },  // top
        { w: mullionW, h: effectiveWinH, ox: -win.width / 2 - mullionW / 2, oy: 0 },  // left
        { w: mullionW, h: effectiveWinH, ox: win.width / 2 + mullionW / 2, oy: 0 },   // right
        // Center vertical mullion
        { w: mullionW, h: effectiveWinH, ox: 0, oy: 0 },
        // Center horizontal mullion
        { w: win.width, h: mullionW, ox: 0, oy: 0 },
      ];
      for (const bar of bars) {
        addOpeningFrame(wall, t + bar.ox / length, bar.w, winCY + bar.oy - bar.h / 2, bar.h, mullionW, frameMat);
      }

      // Glass panes (4 quadrants)
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0xa8d8ea, transparent: true, opacity: 0.3,
        roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide
      });
      const halfW = (win.width - mullionW) / 2;
      const halfH = (effectiveWinH - mullionW) / 2;
      for (const qx of [-1, 1]) {
        for (const qy of [-1, 1]) {
          const gGeo = new THREE.BoxGeometry(halfW, halfH, 1);
          const gMesh = new THREE.Mesh(gGeo, glassMat);
          const ox = qx * (halfW / 2 + mullionW / 2);
          gMesh.position.set(
            px + ox * Math.cos(angle),
            winCY + qy * (halfH / 2 + mullionW / 2),
            py + ox * Math.sin(angle)
          );
          gMesh.rotation.y = -angle;
          wallGroup.add(gMesh);
        }
      }

      // Sill — protruding ledge
      addOpeningFrame(wall, t, win.width + 16, win.sillHeight - 4, 4, wt + 10, frameMat);
    }

    // Furniture
    for (const fi of floor.furniture) {
      const cat = getCatalogItemOrFallback(fi.catalogId);
      // Skip 2D-only architectural symbols
      if (cat.symbol) continue;
      // Create modified catalog definition with overrides
      const furnitureDef = {
        ...cat,
        color: fi.color ?? cat.color,
        width: fi.width ?? cat.width,
        depth: fi.depth ?? cat.depth,
        height: fi.height ?? cat.height,
      };
      const model = createFurnitureModelWithGLB(fi.catalogId, furnitureDef, () => {
        // Re-render when GLB model finishes loading
        markSceneDirty();
      }, { color: fi.color, material: fi.material });
      model.position.set(fi.position.x, 1.5 + (fi.elevation ?? 0), fi.position.y);
      model.rotation.y = -(fi.rotation * Math.PI) / 180;
      // Note: fi.scale is 2D editor scale — don't override 3D model scaling from scaleToFit
      if (fi.scale && (fi.scale.x !== 1 || fi.scale.y !== 1)) {
        model.scale.x *= fi.scale.x;
        model.scale.z *= fi.scale.y;
      }
      model.userData.furnitureId = fi.id;
      furnitureObjects.push(model);
      model.traverse((o) => { if (o instanceof THREE.Mesh) furnitureMeshMap.set(o, fi.id); });
      wallGroup.add(model);
    }

    // Room floors with materials + floating labels
    const FALLBACK_ROOM_COLORS = [0xbfdbfe, 0xfde68a, 0xbbf7d0, 0xfecaca, 0xddd6fe, 0xa5f3fc, 0xfed7aa];
    // Resolve labels and materials from this floor, including after a 3D floor switch.
    const rooms = resolveRooms(floor);
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri];
      const poly = getRoomPolygon(room, floor.walls);
      if (poly.length < 3) continue;

      // Triangulate the polygon using ear-clipping via THREE.ShapeGeometry
      const shape = new THREE.Shape();
      // Negate Y so that after -PI/2 X rotation, 2D Y maps to +Z (matching wall coords)
      shape.moveTo(poly[0].x, -poly[0].y);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, -poly[i].y);
      shape.closePath();

      const geo = new THREE.ShapeGeometry(shape);

      // Compute room bounds for UV normalization (using negated Y to match shape coords)
      const bounds = poly.reduce((b, p) => ({
        minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
        minY: Math.min(b.minY, -p.y), maxY: Math.max(b.maxY, -p.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      const roomW = bounds.maxX - bounds.minX;
      const roomH = bounds.maxY - bounds.minY;

      // Normalize ShapeGeometry UVs from world coords to [0,1] range
      const uvAttr = geo.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) {
        const u = (uvAttr.getX(i) - bounds.minX) / (roomW || 1);
        const v = (uvAttr.getY(i) - bounds.minY) / (roomH || 1);
        uvAttr.setXY(i, u, v);
      }
      uvAttr.needsUpdate = true;

      // Floor material/texture removed — rooms render with the fallback color coding.
      const color = FALLBACK_ROOM_COLORS[ri % FALLBACK_ROOM_COLORS.length];
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.9,
        transparent: true,
        opacity: 0.5
      });

      const mesh = new THREE.Mesh(geo, material);
      // Rotate to lie on XZ plane, slightly above base floor
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 1;
      mesh.receiveShadow = true;
      wallGroup.add(mesh);

      // A flat ceiling is valid only when this room's boundary has one height.
      const ceilingHeight = roomCeilingHeight(room.walls, floor.walls);
      if (ceilingHeight !== undefined) {
        const ceilMat = new THREE.MeshStandardMaterial({
          color: 0xf5f5f0,
          roughness: 0.95,
          side: THREE.BackSide // visible from below
        });
        const ceilGeo = new THREE.ShapeGeometry(shape);
        const ceilMesh = new THREE.Mesh(ceilGeo, ceilMat);
        ceilMesh.rotation.x = -Math.PI / 2;
        ceilMesh.position.y = ceilingHeight;
        ceilMesh.receiveShadow = true;
        wallGroup.add(ceilMesh);
      }
    }

    // Columns
    buildColumns(floor);

    applyWallTransparency();
    positionCameraInterior();
  }

  /** Build all floors stacked vertically in 3D */
  function buildAllFloorsStacked() {
    const project = get(currentProject);
    if (!project || project.floors.length === 0) return;

    // Use buildWalls for the active floor first (it clears wallGroup)
    const activeF = project.floors.find(f => f.id === project.activeFloorId) ?? project.floors[0];
    buildWalls(activeF);

    const entries = assembleFloorStack(wallGroup, project.floors, activeF.id,
      (floor, group, offset) => buildFloorIntoGroup(floor, group, offset, 0.35));
    const box = new THREE.Box3().setFromObject(wallGroup);
    const center = box.getCenter(new THREE.Vector3());
    const labelX = box.isEmpty() ? -200 : box.min.x - 200;
    for (const { floor, yOffset } of entries) {
      addFloorLabel(floor.name, yOffset, labelX, center.z);
    }
    activeFloorElevation = entries.find(entry => entry.floor.id === activeF.id)?.yOffset ?? 0;
    floorPlane.constant = -activeFloorElevation;
    // Keep the presentation ground below basements as well as above-ground floors.
    sceneGround.position.y = Math.min(0, ...entries.map(entry => entry.yOffset)) - 1;
    positionCameraInterior();
  }

  function addFloorLabel(name: string, yOffset: number, labelX: number, labelZ: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 48;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.roundRect(0, 0, 256, 48, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name, 128, 32);

    const tex = ownTexture(new THREE.CanvasTexture(canvas));
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);

    sprite.position.set(labelX, yOffset + 130, labelZ);
    sprite.scale.set(200, 40, 1);
    wallGroup.add(sprite);
  }

  /** Build a single floor's walls/windows into a group at a Y offset with optional transparency */
  function buildFloorIntoGroup(floor: Floor, group: THREE.Group, yOffset: number, opacity: number) {
    const transparentMat = (color: number, roughness = 0.9) => new THREE.MeshStandardMaterial({
      color, roughness, transparent: true, opacity,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    });

    const defaultInteriorMat = transparentMat(0xffffff);
    const defaultExteriorMat = transparentMat(0xd4cfc9, 0.85);

    for (const sourceWall of floor.walls) {
      for (const span of wallPathSpans(sourceWall)) {
        const wall = { ...sourceWall, ...span };
        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) continue;

        const startH = getWallStartHeight(wall);
        const endH = getWallEndHeight(wall);
        const t = Math.max(wall.thickness, WALL_THICKNESS);
        const angle = Math.atan2(dy, dx);
        const cx = (wall.start.x + wall.end.x) / 2;
        const cy = (wall.start.y + wall.end.y) / 2;

        const winOpenings = sourceWall.curvePoint ? [] : floor.windows.filter((w) => w.wallId === wall.id);
        const segments = buildWallSegments(len, startH, endH, winOpenings);

        const materials = [
          defaultExteriorMat, defaultExteriorMat,
          defaultInteriorMat, defaultInteriorMat,
          defaultInteriorMat, defaultExteriorMat,
        ];

        for (const seg of segments) {
          const geo = createSlopedBoxGeometry(seg.width, t, seg.bottomY, seg.topYLeft, seg.topYRight);
          const mesh = new THREE.Mesh(geo, materials);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const localX = seg.offsetX - len / 2;
          mesh.position.set(
            cx + localX * Math.cos(angle),
            yOffset,
            cy + localX * Math.sin(angle)
          );
          mesh.rotation.y = -angle;
          group.add(mesh);
        }
    }

    }
    // Simple floor slab
    if (floor.walls.length > 0) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const w of floor.walls) {
        for (const p of [w.start, w.end]) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
        }
      }
      const slabGeo = new THREE.BoxGeometry(maxX - minX + 40, 5, maxZ - minZ + 40);
      const slabMat = transparentMat(0xcccccc, 0.95);
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.set((minX + maxX) / 2, yOffset, (minZ + maxZ) / 2);
      slab.receiveShadow = true;
      group.add(slab);
    }

    // Columns
    if (floor.columns) {
      for (const col of floor.columns) {
        const h = col.height || 280;
        const d = col.diameter || 30;
        let geo: THREE.BufferGeometry;
        if (col.shape === 'square') {
          geo = new THREE.BoxGeometry(d, h, d);
        } else {
          geo = new THREE.CylinderGeometry(d / 2, d / 2, h, 24);
        }
        const mat = new THREE.MeshStandardMaterial({ color: col.color || '#cccccc', roughness: 0.7, transparent: true, opacity });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(col.position.x, h / 2 + yOffset, col.position.y);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
  }

  function rebuildScene(force = false) {
    const project = get(currentProject);
    if (!project || !currentFloor) return;
    const signature = sceneSignature(project, currentFloor, showAllFloors, get(projectSettings).units);
    if (!force && signature === renderedSignature) return;
    // Skip the preserve/restore dance on the very first build: cameraPositioned
    // is still false, so the pose captured here would just be the placeholder
    // set before positionCameraInterior() has ever run. A real floor switch
    // clears cameraPositioned itself (see activeFloor.subscribe below) so it
    // gets a fresh default framing instead of reusing the old floor's pose.
    const preservePose = cameraPositioned;
    const savedPosition = preservePose ? camera.position.clone() : null;
    const savedTarget = preservePose ? orbitTarget.clone() : null;
    if (showAllFloors) {
      buildAllFloorsStacked();
    } else if (currentFloor) {
      activeFloorElevation = 0;
      floorPlane.constant = 0;
      sceneGround.position.y = -1;
      buildWalls(currentFloor);
    }
    wallHighlight.apply(wallMeshMap, selectedWallId3D);
    furnitureHighlight.apply(furnitureMeshMap, selectedWallId3D);
    wallSnapHighlight.apply(wallMeshMap, dragWallSnapId);
    neighborSnapHighlight.apply(furnitureMeshMap, dragNeighborSnapId);
    if (savedPosition && savedTarget) {
      // buildWalls()/buildAllFloorsStacked() already ran positionCameraInterior()
      // with a fresh default framing — put the user's own orbit back, then
      // re-clamp it against whatever the edit just changed about the room.
      camera.position.copy(savedPosition);
      orbitTarget.copy(savedTarget);
      controls.target.copy(orbitTarget);
      enforceRoomBounds();
      updateWallCulling();
    }
    if (cameraPlaced) {
      updateInteriorCamera();
      updateCameraMarkerFromState();
      cameraPreviewDirty = true;
    }
    markSceneDirty();
    renderedSignature = signature;
  }

  function applyWallTransparency() {
    // Only active-floor wall bodies belong to this control; furniture finishes,
    // glass openings and reference-floor opacity keep their own settings.
    for (const child of wallMeshMap.keys()) if (child instanceof THREE.Mesh) {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        material.transparent = wallsTransparent;
        material.opacity = wallsTransparent ? 0.15 : 1;
        material.needsUpdate = true;
      }
    }
  }

  function toggleWallTransparency() {
    wallsTransparent = !wallsTransparent;
    wallHighlight.clear();
    applyWallTransparency();
    wallHighlight.apply(wallMeshMap, selectedWallId3D);
    markSceneDirty();
  }

  function animate() {
    animId = undefined;
    controls.update(); // drag input + damping settle; harmless no-op otherwise
    // Right-button pan moves controls.target directly; keep orbitTarget (what
    // enforceRoomBounds()/onOrbitWheel() actually pivot on) following it so a
    // pan doesn't get immediately fought/undone by the room-bounds clamp.
    orbitTarget.copy(controls.target);
    if (roomBoundaryPoly.length >= 3) {
      // The per-radius wall/floor/ceiling clamp is suspended during a pan (see
      // pointerdown above), so keep panning itself from carrying the pivot
      // straight through a wall — a loose bounding-box clamp on the target,
      // applied every frame (pan, rotate, or idle, including the tail of a
      // pan's damped momentum), is enough to stop it drifting outside the
      // room outright. Unlike enforceRoomBounds() this only ever moves the
      // target, never the camera directly, so it can never introduce the
      // apparent rotation a camera-only clamp would during a pan.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of roomBoundaryPoly) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
      }
      const margin = ORBIT_WALL_MARGIN;
      orbitTarget.x = Math.min(Math.max(orbitTarget.x, minX + margin), maxX - margin);
      orbitTarget.z = Math.min(Math.max(orbitTarget.z, minZ + margin), maxZ - margin);
      controls.target.copy(orbitTarget);
    }
    if (!panningCamera) enforceRoomBounds();
    updateWallCulling();
    if (sceneDirty) {
      sceneDirty = false;
      renderer.render(scene, camera);
    }
  }

  function onResize() {
    if (!container || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    markSceneDirty();
  }

  function takeScreenshot() {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = 'floorplan-3d.png';
    link.href = dataUrl;
    link.click();
  }

  onMount(() => {
    const stopAISettings = openAISettings.subscribe(config => {
      cancelAIRender();
      openaiModel = getEffectiveModel(config);
    });
    init();
    viewerMounted = true;
    markSceneDirty();

    // Rebuild 3D scene when photo textures finish loading
    const stopTextures = setTextureLoadCallback(() => {
      // New image pixels are not represented in the project's value snapshot.
      if (currentFloor) rebuildScene(true);
    });

    const resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(container);

    const unsub = activeFloor.subscribe((f) => {
      // Only an actual floor switch (not the initial null -> floor population
      // on mount) should drop the old orbit pose — a different floor's rooms
      // make the previous position/target meaningless.
      if (currentFloor && currentFloor.id !== f?.id) {
        closeCamera();
        cameraPositioned = false;
      }
      currentFloor = f;
      if (f) rebuildScene();
    });
    // Room area labels are textures and must refresh when display units change.
    const stopSettings = projectSettings.subscribe(() => {
      if (currentFloor) rebuildScene();
    });

    const unsubSel = selectedElementId.subscribe((id) => {
      selectedWallId3D = id;
      wallHighlight.apply(wallMeshMap, id);
      furnitureHighlight.apply(furnitureMeshMap, id);
      markSceneDirty();
    });

    return () => {
      viewerMounted = false;
      cancelAIRender();
      stopAISettings();
      stopTextures();
      resizeObs.disconnect();
      unsub();
      stopSettings();
      unsubSel();
      if (animId !== undefined) cancelAnimationFrame(animId);
      animId = undefined;
      document.removeEventListener('keydown', onKeyDown, false);
      releaseCameraPreview();
      wallHighlight.clear();
      furnitureHighlight.clear();
      wallSnapHighlight.clear();
      neighborSnapHighlight.clear();
      removeGhostPreview();
      skyTexture.dispose();
      sunLight.shadow.dispose();
      clearGroup(scene);
      wallMeshMap.clear();
      furnitureMeshMap.clear();
      controls.dispose();
      releaseRenderer(renderer);
    };
  });
</script>

<div bind:this={container} class="w-full h-full relative" role="region" aria-label={td('viewer3d.title')}>
  {#if showAllFloors && currentFloor}
    <div class="absolute bottom-4 right-4 z-10 rounded bg-black/70 px-3 py-2 text-xs text-white pointer-events-none">
      {currentFloor.name} · {td('viewer3d.floorElevation', { cm: activeFloorElevation })}
    </div>
  {/if}
  <!-- 3D Toolbar Row -->
  <div class="absolute top-4 right-4 z-50 flex gap-1.5">
    <!-- Multi-Floor Stacking Toggle -->
    <button
      onclick={() => { showAllFloors = !showAllFloors; rebuildScene(); }}
      class="p-2 rounded-lg transition-colors {showAllFloors ? 'bg-purple-600 text-white ring-2 ring-purple-300' : 'bg-black/70 text-white hover:bg-black/80'}"
      title={showAllFloors ? td('viewer3d.activeFloorOnly') : td('viewer3d.showAllFloorsStacked')}
      aria-label={showAllFloors ? td('viewer3d.activeFloorOnly') : td('viewer3d.showAllFloorsStacked')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="4" y="14" width="16" height="4" rx="1"/>
        <rect x="4" y="8" width="16" height="4" rx="1" opacity="0.6"/>
        <rect x="4" y="2" width="16" height="4" rx="1" opacity="0.3"/>
      </svg>
    </button>

    <!-- Wall Transparency Toggle -->
    <button
      onclick={toggleWallTransparency}
      class="p-2 rounded-lg transition-colors {wallsTransparent ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'bg-black/70 text-white hover:bg-black/80'}"
      title={wallsTransparent ? td('viewer3d.showSolidWalls') : td('viewer3d.makeWallsTransparent')}
      aria-label={wallsTransparent ? td('viewer3d.showSolidWalls') : td('viewer3d.makeWallsTransparent')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" opacity={wallsTransparent ? 0.3 : 1}/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="12" y1="3" x2="12" y2="21"/>
      </svg>
    </button>

    <!-- Edit Mode Toggle -->
    <button
      onclick={() => { editMode = !editMode; if (!editMode) { selectedElementId.set(null); materialPickerWall = null; materialPickerPos = null; activeFurnitureId3D = null; } }}
      class="p-2 rounded-lg transition-colors {editMode ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'bg-black/70 text-white hover:bg-black/80'}"
      title={editMode ? td('viewer3d.exitEditMode') : td('viewer3d.editModeHint')}
      aria-label={editMode ? td('viewer3d.exitEditMode') : td('viewer3d.editMode')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
    </button>

    <!-- Interior Camera Button -->
    <button
      onclick={() => {
        if (cameraPlacementMode) {
          cameraPlacementMode = false;
        } else {
          cameraPlacementMode = true;
          cameraPlaced = false;
          editMode = true;
          furniturePlacementMode = false;
        }
      }}
      class="p-2 rounded-lg transition-colors {cameraPlacementMode ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'bg-black/70 text-white hover:bg-black/80'}"
      title={cameraPlacementMode ? td('viewer3d.cancelCameraPlacement') : td('viewer3d.placeInteriorCameraHint')}
      aria-label={td('viewer3d.placeInteriorCamera')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 7l-7 5 7 5V7z"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
    </button>

    <!-- 3D Screenshot Button -->
    <button
      onclick={takeScreenshot}
      class="p-2 rounded-lg bg-black/70 text-white hover:bg-black/80 transition-colors"
      title={td('viewer3d.saveScreenshot')}
      aria-label={td('viewer3d.saveScreenshot')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </button>

  </div><!-- end 3D toolbar row -->

  {#if cameraPlacementMode && !cameraPlaced}
    <div class="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-black/80 text-white px-4 py-2 rounded-lg text-sm backdrop-blur-sm">
      {td('viewer3d.clickFloorToPlaceCamera')}
    </div>
  {:else if cameraPlacementMode && cameraPlaced}
    <div class="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-black/80 text-white px-4 py-2 rounded-lg text-sm backdrop-blur-sm">
      {td('viewer3d.clickWhereCameraShouldLook')}
    </div>
  {/if}

  <!-- Camera Preview Panel -->
  {#if cameraPreviewOpen && cameraPlaced}
    <div class="absolute bottom-4 right-4 z-[60] bg-gray-900/95 rounded-xl shadow-2xl backdrop-blur-sm overflow-y-auto max-w-[calc(100vw-2rem)]" style="width: 420px; max-height: calc(100vh - 8rem);">
      <div class="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span class="text-white text-sm font-medium">{td('viewer3d.interiorCamera')}</span>
        <div class="flex gap-2">
          <button class="text-xs text-blue-400 hover:text-blue-300" onclick={() => { cancelAIRender(); aiRenderOpen = !aiRenderOpen; }}>
            {aiRenderOpen ? td('viewer3d.hideAI') : td('viewer3d.aiRenderToggle')}
          </button>
          <button class="text-gray-400 hover:text-white text-lg leading-none" onclick={closeCamera} aria-label={td('viewer3d.closeCamera')}>✕</button>
        </div>
      </div>
      <!-- Preview canvas with drag-to-rotate -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="relative cursor-grab active:cursor-grabbing"
        onpointerdown={(e) => { previewDragStart = { x: e.clientX, y: e.clientY, yaw: cameraYaw, pitch: cameraPitch }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onpointermove={(e) => { if (!previewDragStart) return; const dx = e.clientX - previewDragStart.x; const dy = e.clientY - previewDragStart.y; cameraYaw = previewDragStart.yaw + dx * 0.5; cameraPitch = Math.max(-45, Math.min(45, previewDragStart.pitch - dy * 0.3)); cameraPreviewDirty = true; }}
        onpointerup={() => { previewDragStart = null; }}
      >
        <canvas use:attachCameraPreview aria-label={td('viewer3d.interiorCameraPreview')} width="384" height="216" class="w-full pointer-events-none"></canvas>
        <div class="absolute bottom-1 left-1 text-[10px] text-white/50 pointer-events-none">{td('viewer3d.dragToLookAround')}</div>
      </div>

      <!-- Movement arrows -->
      <div class="flex items-center justify-center gap-1 py-1.5 border-b border-gray-800">
        <span class="text-[10px] text-gray-500 mr-2">{td('viewer3d.moveLabel')}</span>
        <button class="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs flex items-center justify-center" onclick={() => moveCameraRelative(0, -10)} title={td('viewer3d.moveLeft')}>←</button>
        <div class="flex flex-col gap-0.5">
          <button class="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs flex items-center justify-center" onclick={() => moveCameraRelative(10, 0)} title={td('viewer3d.moveForward')}>↑</button>
          <button class="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs flex items-center justify-center" onclick={() => moveCameraRelative(-10, 0)} title={td('viewer3d.moveBackward')}>↓</button>
        </div>
        <button class="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs flex items-center justify-center" onclick={() => moveCameraRelative(0, 10)} title={td('viewer3d.moveRight')}>→</button>
      </div>

      <div class="px-3 py-2 space-y-1.5">
        <label class="flex items-center justify-between text-xs text-gray-300">
          <span>{td('viewer3d.fov')}</span>
          <div class="flex items-center gap-2">
            <input type="range" min="50" max="120" bind:value={cameraFOV} class="w-28 h-1 accent-blue-400"
              oninput={() => { cameraPreviewDirty = true; }} />
            <span class="w-10 text-right">{cameraFOV}°</span>
          </div>
        </label>
        <label class="flex items-center justify-between text-xs text-gray-300">
          <span>{td('properties.height')}</span>
          <div class="flex items-center gap-2">
            <input type="range" min="80" max="220" bind:value={cameraHeight} class="w-28 h-1 accent-blue-400"
              oninput={() => { cameraPreviewDirty = true; }} />
            <span class="w-10 text-right">{cameraHeight}cm</span>
          </div>
        </label>
        <label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
          <input type="checkbox" bind:checked={cameraXrayWalls} class="accent-blue-400" onchange={() => { cameraPreviewDirty = true; }} />
          <span>{td('viewer3d.xrayWalls')}</span>
        </label>
        <div class="flex gap-2 pt-1">
          <button
            class="flex-1 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors"
            onclick={captureInteriorPhoto}
          >
            {td('viewer3d.capture1920')}
          </button>
          <button
            class="px-3 py-1.5 bg-gray-700 text-gray-300 text-sm rounded-lg hover:bg-gray-600 transition-colors"
            onclick={() => { cameraPlacementMode = true; cameraPlaced = false; }}
          >
            {td('viewer3d.reposition')}
          </button>
        </div>
      </div>

      <!-- AI Render Section -->
      {#if aiRenderOpen}
        <div class="border-t border-gray-700 px-3 py-3 space-y-2">
          <div class="text-xs font-medium text-white">{td('viewer3d.aiPhotorealisticRender')}</div>

          <!-- Provider toggle -->
          <div class="flex rounded-lg overflow-hidden border border-gray-700">
            <button
              class="flex-1 text-xs py-1.5 font-medium transition-colors {aiProvider === 'gemini' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}"
              onclick={() => { cancelAIRender(); aiProvider = 'gemini'; }}
            >Gemini</button>
            <button
              class="flex-1 text-xs py-1.5 font-medium transition-colors {aiProvider === 'openai' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}"
              onclick={() => { cancelAIRender(); aiProvider = 'openai'; }}
            >OpenAI</button>
          </div>

          {#if aiProvider === 'gemini'}
            <label class="block">
              <span class="text-[10px] text-gray-400 block mb-1">{td('viewer3d.model')}</span>
              <select bind:value={aiModel} disabled={aiRendering} class="w-full bg-gray-800 text-gray-200 text-xs rounded px-1.5 py-1.5 border border-gray-700">
                {#each AI_MODELS as m}<option value={m.id}>{m.name} — {m.desc}</option>{/each}
              </select>
            </label>
          {:else}
            <div class="text-gray-200 space-y-2">
              <p class="text-xs break-all">{td('viewer3d.providerLabel', { dest: providerDestination() })}</p>
              <OpenAIModelPicker config={$openAISettings} bind:model={openaiModel} id="render-openai-model" disabled={aiRendering} onchange={saveRenderModel} />
              <p class="text-xs text-gray-400">{td('viewer3d.cameraGoesDirect')}</p>
            </div>
          {/if}

          <div class="grid grid-cols-3 gap-2">
            <label class="block">
              <span class="text-[10px] text-gray-400 block mb-1">{td('viewer3d.style')}</span>
              <select bind:value={aiRenderStyle} class="w-full bg-gray-800 text-gray-200 text-xs rounded px-1.5 py-1 border border-gray-700">
                {#each STYLE_OPTIONS as opt}<option value={opt}>{td('viewer3d.style.' + opt)}</option>{/each}
              </select>
            </label>
            <label class="block">
              <span class="text-[10px] text-gray-400 block mb-1">{td('viewer3d.lighting')}</span>
              <select bind:value={aiRenderLighting} class="w-full bg-gray-800 text-gray-200 text-xs rounded px-1.5 py-1 border border-gray-700">
                {#each LIGHTING_OPTIONS as opt}<option value={opt}>{td('viewer3d.lighting.' + opt)}</option>{/each}
              </select>
            </label>
            <label class="block">
              <span class="text-[10px] text-gray-400 block mb-1">{td('viewer3d.mood')}</span>
              <select bind:value={aiRenderMood} class="w-full bg-gray-800 text-gray-200 text-xs rounded px-1.5 py-1 border border-gray-700">
                {#each MOOD_OPTIONS as opt}<option value={opt}>{td('viewer3d.mood.' + opt)}</option>{/each}
              </select>
            </label>
          </div>

          <label class="block">
            <span class="text-[10px] text-gray-400 block mb-1">{td('viewer3d.extraInstructions')}</span>
            <input type="text" bind:value={aiRenderExtra} placeholder={td('viewer3d.extraInstructionsPlaceholder')}
              class="w-full bg-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-700 placeholder:text-gray-600" />
          </label>

          <details class="text-[10px] text-gray-500">
            <summary class="cursor-pointer hover:text-gray-400">{td('viewer3d.viewFullPrompt')}</summary>
            <p class="mt-1 p-2 bg-gray-800 rounded text-gray-400 leading-relaxed">{buildAIPrompt()}</p>
          </details>

          <button
            class="w-full px-3 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            onclick={runAIRender}
            disabled={aiRendering}
          >
            {#if aiRendering}
              <span class="animate-spin">⏳</span> {td('viewer3d.rendering')}
            {:else}
              {td('viewer3d.generateRender')}
            {/if}
          </button>

          {#if aiRendering}
            <button type="button" onclick={cancelAIRender} class="w-full py-2 text-sm text-gray-200 border border-gray-600 rounded-lg">{td('viewer3d.cancelRender')}</button>
          {/if}

          {#if aiRenderError}
            <div class="bg-red-900/30 border border-red-700 rounded-lg p-3 space-y-2">
              <div class="text-xs font-medium text-red-400">{td('viewer3d.aiRenderFailed')}</div>
              <pre class="text-[10px] text-red-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto select-all cursor-text font-mono bg-red-950/40 rounded p-2">{aiRenderError}</pre>
              <button
                class="text-[10px] text-red-400 hover:text-red-300 underline"
                onclick={() => { navigator.clipboard.writeText(aiRenderError ?? ''); }}
              >{td('viewer3d.copyError')}</button>
            </div>
          {/if}

          {#if aiRenderResult}
            <div class="space-y-2">
              <img src={aiRenderResult} alt={td('viewer3d.aiRenderToggle')} class="w-full rounded-lg" />
              <button
                class="w-full px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-500 transition-colors"
                onclick={downloadAIRender}
              >
                {td('viewer3d.downloadRender')}
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if !editMode}
    <!-- Orbit hint -->
    <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10">
      <div class="bg-black/70 text-white text-sm px-4 py-2 rounded-lg backdrop-blur-sm">
        {td('viewer3d.orbitHint')}
      </div>
    </div>
  {/if}

  {#if editMode}
    <div class="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10">
      <div class="bg-blue-600/90 text-white text-sm px-4 py-2 rounded-lg backdrop-blur-sm flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        {#if furniturePlacementMode}
          {td('viewer3d.furniturePlaceHint', { name: selectedCatalogId ? td('catalog.' + selectedCatalogId) : td('viewer3d.furnitureGeneric') })}
        {:else}
          {td('viewer3d.paintWallsHint')}
        {/if}
      </div>
    </div>

  {/if}

  <!-- MaterialPicker removed — wall materials editable via Properties panel -->

  <!-- Furniture sidebar: always available in the 3D view, no mode toggle
       needed first — picking an item arms placement (and turns Edit Mode on,
       same as the interior-camera button does) so the next floor click drops
       it in, matching the hint bar above. -->
  <div class="absolute top-4 left-4 bottom-20 z-40 w-60 bg-black/85 text-white rounded-lg backdrop-blur-sm flex flex-col overflow-hidden select-none">
    <div class="p-2 border-b border-white/10">
      <span class="font-semibold text-sm">{td('viewer3d.addFurniture')}</span>
      <p class="text-[10px] text-white/50 mt-0.5">{td('viewer3d.pickItemHint')}</p>
    </div>
    <!-- Category tabs -->
    <div class="flex flex-wrap gap-1 p-2 border-b border-white/10 shrink-0">
      {#each furnitureCategories.filter(c => c !== 'Electrical' && c !== 'Plumbing') as cat}
        <button
          onclick={() => { furniturePickerCategory = cat; }}
          class="px-2 py-0.5 rounded text-[10px] transition-colors {furniturePickerCategory === cat ? 'bg-green-600 text-white' : 'bg-white/10 hover:bg-white/20 text-white/70'}"
        >{td('category.' + cat)}</button>
      {/each}
    </div>
    <!-- Items -->
    <div class="overflow-y-auto p-1 flex-1">
      {#each furnitureCatalog.filter(f => f.category === furniturePickerCategory && !f.symbol) as item}
        <button
          onclick={() => {
            selectedCatalogId = item.id;
            furniturePlacementMode = true;
            editMode = true;
            materialPickerWall = null; materialPickerPos = null;
            removeGhostPreview();
          }}
          class="w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors {furniturePlacementMode && selectedCatalogId === item.id ? 'bg-green-600/80 text-white' : 'hover:bg-white/10 text-white/80'}"
        >
          <span class="text-base">{item.icon}</span>
          <span>{td('catalog.' + item.id)}</span>
          <span class="ml-auto text-[10px] text-white/40">{item.width}×{item.depth}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Room Size Toggle Button -->
  <button
    onclick={() => { roomSizePanelOpen = !roomSizePanelOpen; }}
    class="absolute bottom-4 left-16 md:left-28 z-50 p-2 rounded-lg transition-colors {roomSizePanelOpen ? 'bg-emerald-500 text-white ring-2 ring-emerald-300' : 'bg-black/70 text-white hover:bg-black/80'}"
    title={td('viewer3d.roomSize')}
    aria-label={td('viewer3d.roomSize')}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="1"/>
      <path d="M3 9h4M3 15h4M17 3v4M17 17v4M9 3v2M15 3v2M9 19v2M15 19v2M21 9h-2M21 15h-2"/>
    </svg>
  </button>

  <!-- Room Size Panel -->
  {#if roomSizePanelOpen}
    <div class="absolute bottom-14 left-16 md:left-28 z-50 bg-black/80 text-white text-xs rounded-lg backdrop-blur-sm p-3 space-y-2 min-w-[200px] select-none">
      <div class="font-semibold text-white/90 text-sm flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>
        {td('viewer3d.roomSizeMm')}
      </div>
      <label class="flex items-center justify-between gap-2">
        <span class="text-white/70">{td('viewer3d.length')}</span>
        <input type="number" min="500" step="10"
          value={roomBoundsCm ? Math.round(roomBoundsCm.width * 10) : ''}
          oninput={(e) => onRoomDimInputMm('width', e.currentTarget.value)}
          class="w-20 bg-white/10 rounded px-1.5 py-0.5 text-right" />
      </label>
      <label class="flex items-center justify-between gap-2">
        <span class="text-white/70">{td('properties.width')}</span>
        <input type="number" min="500" step="10"
          value={roomBoundsCm ? Math.round(roomBoundsCm.depth * 10) : ''}
          oninput={(e) => onRoomDimInputMm('depth', e.currentTarget.value)}
          class="w-20 bg-white/10 rounded px-1.5 py-0.5 text-right" />
      </label>
      <label class="flex items-center justify-between gap-2">
        <span class="text-white/70">{td('properties.height')}</span>
        <input type="number" min="500" step="10"
          value={roomBoundsCm ? Math.round(roomBoundsCm.height * 10) : ''}
          oninput={(e) => onRoomDimInputMm('height', e.currentTarget.value)}
          class="w-20 bg-white/10 rounded px-1.5 py-0.5 text-right" />
      </label>
      {#if !roomBoundsCm}
        <p class="text-amber-200 max-w-48">{td('viewer3d.noRectRoom')}</p>
      {/if}
    </div>
  {/if}

  <!-- Lighting Controls Toggle Button -->
  <button
    onclick={() => { lightingPanelOpen = !lightingPanelOpen; }}
    class="absolute bottom-4 left-4 md:left-14 z-50 p-2 rounded-lg transition-colors {lightingPanelOpen ? 'bg-amber-500 text-white ring-2 ring-amber-300' : 'bg-black/70 text-white hover:bg-black/80'}"
    title={td('viewer3d.lightingControls')}
    aria-label={td('viewer3d.lightingControls')}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  </button>

  <!-- Lighting Controls Panel -->
  {#if lightingPanelOpen}
    <div class="absolute bottom-14 left-4 md:left-14 z-50 bg-black/80 text-white text-xs rounded-lg backdrop-blur-sm p-3 space-y-3 min-w-[220px] select-none">
      <div class="font-semibold text-white/90 text-sm flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>
        {td('viewer3d.lightingControls')}
      </div>

      <!-- Time of Day Presets -->
      <div class="space-y-1">
        <span class="text-white/60 text-[10px] uppercase tracking-wide">{td('viewer3d.timeOfDay')}</span>
        <div class="flex gap-1">
          {#each (['morning', 'noon', 'evening', 'night'] as const) as preset}
            <button
              onclick={() => applyTimePreset(preset)}
              class="flex-1 px-1.5 py-1 rounded text-[11px] transition-colors {timeOfDay === preset ? 'bg-amber-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white/80'}"
            >
              {preset === 'morning' ? '🌅' : preset === 'noon' ? '☀️' : preset === 'evening' ? '🌇' : '🌙'}
              <span class="block capitalize">{td('viewer3d.timepreset.' + preset)}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- Sun Position -->
      <label class="block space-y-0.5">
        <div class="flex justify-between text-white/60">
          <span>{td('viewer3d.sunPosition')}</span><span>{sunAzimuth}°</span>
        </div>
        <input type="range" min="0" max="360" bind:value={sunAzimuth} oninput={() => { timeOfDay = null; updateSunPosition(); }} class="w-full h-1 accent-amber-400" />
      </label>

      <!-- Sun Elevation -->
      <label class="block space-y-0.5">
        <div class="flex justify-between text-white/60">
          <span>{td('viewer3d.sunElevation')}</span><span>{sunElevation}°</span>
        </div>
        <input type="range" min="0" max="90" bind:value={sunElevation} oninput={() => { timeOfDay = null; updateSunPosition(); }} class="w-full h-1 accent-amber-400" />
      </label>

      <!-- Ambient Intensity -->
      <label class="block space-y-0.5">
        <div class="flex justify-between text-white/60">
          <span>{td('viewer3d.ambientLight')}</span><span>{Math.round(ambientIntensity * 100)}%</span>
        </div>
        <input type="range" min="0" max="100" value={Math.round(ambientIntensity * 100)} oninput={(e) => { ambientIntensity = parseInt(e.currentTarget.value) / 100; timeOfDay = null; updateAmbientIntensity(); }} class="w-full h-1 accent-blue-400" />
      </label>
    </div>
  {/if}
</div>
