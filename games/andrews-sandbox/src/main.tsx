// ============================================================================
// Andrew's Sandbox — Renderer Entry Point
// Declarative GameModule + startGame() bootstrap.
// ============================================================================

import { ContentRegistry, DragDropImporter, PluginScanner, scanKenneyPacks } from "@andrews-sandbox/library-content";
import { BUILTIN_PROPS } from "@andrews-sandbox/library-props";
import { PaintSystem } from "@andrews-sandbox/module-paint";
import { PhysicsPropsController } from "@andrews-sandbox/module-physics-props";
import { SandboxVRModule } from "@andrews-sandbox/module-vr";
import { WeaponController } from "@andrews-sandbox/module-weapons";
import { downdraft, startGame, type SimWorkerSeed } from "@downdraft/app/renderer";
import { CameraMode, ENGINE_VERSION, ENT, MaterialRegistry, PluginHost, registerAllExtensionLoaders, SimBufferReader } from "@downdraft/core";
import { PixiUiHost } from "@downdraft/library-pixi-ui";
// Import the pointer lock polyfill BEFORE any code that uses requestPointerLock.
// This overrides the browser's Pointer Lock API with a native-backed
// implementation that bypasses Chrome's ESC-exits-pointer-lock behavior and
// re-lock cooldown. No-op in browser/web mode (falls back to real API).
import "@downdraft/module-raw-input/polyfill";
import { EntityType, FunMode, PhysgunMode, PoseState, ToolgunContext, ToolType } from "@sandbox/shared/types";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { SANDBOX_STATS_LAYOUT, type SandboxAction } from "./pixi/bridge-protocol";
import {
    createContentRegistryAssetBridge,
    createNoopMapRegistry,
    createNoopPhysicsRegistry,
    createShaderBridge,
} from "./plugin-host-bridge";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

(globalThis as any).__ddThreadTag = "R0";

// ── Shared content registry (module-scoped so event handlers can access it) ──
const contentRegistry = new ContentRegistry();
const materialRegistry = new MaterialRegistry();
const pluginScanner = new PluginScanner();
let dragDropImporter: DragDropImporter | null = null;
let physicsController: PhysicsPropsController | null = null;
let paintSystem: PaintSystem | null = null;
let vrModule: SandboxVRModule | null = null;
// Fun mode display names (indexed by FunMode enum value). Module-scoped so both
// the keydown handler (KeyF cycle) and buildDomHud (mode badge) can read it.
const FUN_NAMES = ["Normal", "Moon", "ZeroG", "Bouncy", "Squishy"];
// Per-contentId spawn counts (module-scoped so event handlers can update them)
const spawnCounts = new Map<string, number>();
// Reference to the pixi-ui host (set in onReady, used by event handlers)
let pixiUiHost: PixiUiHost | null = null;

/** Send spawn counts to the pixi-ui worker (if started). */
function sendSpawnCountsToWorker(): void {
  if (!pixiUiHost) return;
  const counts: Record<string, number> = {};
  for (const [id, cnt] of spawnCounts) counts[id] = cnt;
  pixiUiHost.postEvent({ kind: "spawnCounts", counts } as any);
}

// Player state shared between the sim event handler and the renderer move loop.
// The sim worker owns the authoritative position (Rapier character controller);
// the renderer reads it to position the camera.
// Player feet start at y=PLAYER_HEIGHT (matches sim worker's initial playerPos).
const PLAYER_HEIGHT = 1.8;
const playerState = {
  pos: [0, PLAYER_HEIGHT, 0] as [number, number, number],
  grounded: false,
  pose: PoseState.Standing,
};

// Per-pose renderer config: eye height above feet + movement-speed multiplier.
// Mirrors POSE_CONFIG in sim-worker-web.ts so the renderer can position the
// camera and scale WASD without a round-trip. Updated from `pose_changed` /
// `player_moved` events (the sim is authoritative).
const POSE_EYE_HEIGHT: Record<PoseState, number> = {
  [PoseState.Standing]: 1.62,
  [PoseState.Crouching]: 1.0,
  [PoseState.Prone]: 0.4,
};
const POSE_SPEED_MUL: Record<PoseState, number> = {
  [PoseState.Standing]: 1.0,
  [PoseState.Crouching]: 0.6,
  [PoseState.Prone]: 0.25,
};
// Player capsule collider dimensions per pose. Mirrors POSE_CONFIG in
// sim-worker-web.ts so the F1 hitbox overlay can render an accurate capsule
// without a round-trip to the sim. height = total capsule height, radius =
// capsule radius. The sim is authoritative; this is a renderer-side mirror.
const POSE_COLLIDER: Record<PoseState, { height: number; radius: number }> = {
  [PoseState.Standing]: { height: 1.8, radius: 0.4 },
  [PoseState.Crouching]: { height: 1.2, radius: 0.4 },
  [PoseState.Prone]: { height: 0.6, radius: 0.3 },
};
// Eye height is interpolated each frame toward `targetEyeHeight` so pose
// transitions (stand↔crouch↔prone) ease smoothly instead of snapping the
// camera. The sim sets the target via pose_changed/player_moved events; the
// move loop advances `currentEyeHeight` toward it.
let currentEyeHeight = POSE_EYE_HEIGHT[PoseState.Standing];
let targetEyeHeight = POSE_EYE_HEIGHT[PoseState.Standing];

// ── Camera mode state ──
// The sandbox supports three camera modes (cycled with KeyC):
//   FirstPerson — camera at the player's eye, looks where the player aims.
//   ThirdPerson — camera orbits behind the player at `thirdPersonDistance`,
//                 looking at the player's head. Scroll wheel adjusts distance.
//   FreeCam     — camera detaches from the player and flies freely through
//                 the world (WASD + Space/Shift); the sim player freezes until
//                 you cycle back to a player-attached mode.
// `freecamPos` is initialized from the current camera position the first time
// FreeCam is entered (and re-seeded whenever we switch into it from a
// player-attached mode so the handoff is seamless).
const THIRD_PERSON_MIN_DIST = 3;
const THIRD_PERSON_MAX_DIST = 25;
const THIRD_PERSON_DEFAULT_DIST = 8;
const FREECAM_SPEED = 20; // units / second
const CAMERA_MODE_NAMES: Record<CameraMode, string> = {
  [CameraMode.FirstPerson]: "First Person",
  [CameraMode.ThirdPerson]: "Third Person",
  [CameraMode.FreeCam]: "Freecam",
};
let cameraMode: CameraMode = CameraMode.FirstPerson;
let thirdPersonDistance = THIRD_PERSON_DEFAULT_DIST;
let freecamPos: [number, number, number] = [0, PLAYER_HEIGHT + currentEyeHeight, 0];

// Register builtin props
for (const prop of BUILTIN_PROPS) {
  contentRegistry.register({
    id: prop.id,
    name: prop.name,
    category: prop.category,
    modelUri: prop.modelUri || undefined,
    physics: prop.defaultPhysics,
    scale: prop.defaultScale,
    paintable: prop.paintable,
    pluginSource: "builtin",
    pack: "builtin",
    packLabel: "Builtin",
  });
}

// Register Kenney model packs (public domain, https://kenney.nl)
try {
  const kenneyGlobs = import.meta.glob("./assets/kenney_*/Models/**/*.glb", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  const kenneyEntries = scanKenneyPacks(kenneyGlobs);
  for (const entry of kenneyEntries) {
    contentRegistry.register(entry);
  }
  console.log(`[Renderer] Registered ${kenneyEntries.length} Kenney model entries`);
} catch (err) {
  console.warn("[Renderer] Kenney pack discovery failed:", err);
}

startGame({
  libraries: [],

  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (_seed?: SimWorkerSeed) => new SimWebWorker(),
  simConfig: { seed: 12345, gamemode: 0, rules: {}, isDev: !!(downdraft?.isDev) || import.meta.env.DEV },

  mountUI: () => { /* pixi-ui handles UI */ },

  events: {
    ready: (_data, _ctx) => {
      console.log("[Renderer] Sim Web Worker ready");
      useGameStore.getState().setSimReady(true);
    },
    error: (data) => {
      console.error(`[Renderer] Sim error: ${data?.message ?? JSON.stringify(data)}`);
    },
    prop_spawned: async (data, ctx) => {
      const renderer = ctx.renderer as WebGPURenderer;
      const entry = contentRegistry.get(data.contentId);
      if (!entry) return;

      if (entry.modelUri) {
        const nodeId = await renderer.loadPropModel(data.contentId, entry.modelUri);
        if (nodeId) {
          const nodeIdNum = parseInt(nodeId.split("-")[1] ?? "0", 10);
          // entityId = slotIdx + 1, so slotIdx = entityId - 1
          const slotIdx = data.entityId - 1;
          const reader = new SimBufferReader(ctx.simSAB!);
          const slot = reader.getEntitySlot(slotIdx);
          slot.u32[ENT.ID] = nodeIdNum;
        }
      }

      // Derive a lower-resolution convex hull from the loaded mesh and swap
      // the placeholder box collider for a mesh-fitted convex collider. The
      // hull is in mesh-local space; scale it by the prop's spawn scale so it
      // matches the rendered mesh in the body's local frame.
      const hull = renderer.getColliderHull(data.contentId);
      console.log(`[prop_spawned] contentId=${data.contentId} hull=${hull ? `${hull.length / 3}pts` : "null"} scale=${data.scale ?? 1.0}`);
      if (hull && hull.length >= 9) {
        const scale = data.scale ?? 1.0;
        // Always clone — the cached hull Float32Array is shared across all
        // spawns of this contentId. Sending it directly risks the worker
        // proxy detaching the underlying ArrayBuffer, breaking subsequent
        // spawns of the same model.
        const scaled = new Float32Array(hull.length);
        for (let i = 0; i < scaled.length; i++) scaled[i] = hull[i] * scale;
        (ctx.sim as SimWebWorker).sendCommand({
          type: "setPropColliderHull",
          entityId: data.entityId,
          vertices: scaled,
        });
      }

      // Reseed the interpolation buffer so the prop doesn't interpolate from
      // a stale prev position (avoids a visual snap on spawn).
      renderer.onPropSpawned(data.entityId);

      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);

      // Track per-contentId spawn count
      spawnCounts.set(data.contentId, (spawnCounts.get(data.contentId) ?? 0) + 1);
      sendSpawnCountsToWorker();
    },
    prop_removed: (data, ctx) => {
      const renderer = ctx.renderer as WebGPURenderer;
      renderer.onPropRemoved(data.entityId);
      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);

      // Decrement per-contentId spawn count (find the contentId from the SAB)
      // The prop_removed event only has entityId; we need to find the contentId.
      // Since the slot is already cleared, we can't read it from the SAB.
      // We'll just leave the count as-is (it will be corrected on clear).
      // A better approach would be to track entityId→contentId, but for now
      // we only decrement on "clear" (which resets all counts).
    },
    fun_mode_changed: (data) => {
      useGameStore.getState().setActiveFunMode(data.mode);
    },
    pose_changed: (data) => {
      playerState.pose = data.pose;
      targetEyeHeight = data.eyeHeight;
    },
    paint_updated: (_data) => { /* Phase 5 */ },
    player_moved: (data) => {
      playerState.pos[0] = data.position[0];
      playerState.pos[1] = data.position[1];
      playerState.pos[2] = data.position[2];
      playerState.grounded = data.grounded;
      // Keep pose + eye-height target in sync (player_moved always carries
      // the current pose; pose_changed fires only on transitions). The move
      // loop eases currentEyeHeight toward targetEyeHeight.
      if (data.pose !== playerState.pose) {
        playerState.pose = data.pose;
        targetEyeHeight = POSE_EYE_HEIGHT[playerState.pose];
      }
    },
  },

  onFpsUpdate: (fps, _ctx) => {
    useGameStore.getState().setFps(fps);
  },

  save: {
    // Pin to IPC (disk via Electron main process) so the autosave is stable
    // across sessions and not split across OPFS (origin-scoped) vs disk.
    mode: "ipc",
    engineVersion: ENGINE_VERSION,
    maxGenerations: 3,
  },

  onInit: async (ctx) => {
    const config: SimWebWorkerConfig = { seed: 12345, isDev: ctx.isDev };
    const [rendererSuccess] = await Promise.all([
      ctx.renderer.init(),
      ctx.sim!.start(config),
    ]);
    if (!rendererSuccess) {
      console.error("WebGPU initialization failed");
      return false;
    }
    if (ctx.isDev) useGameStore.getState().setIsDev(true);
    return true;
  },

  onReady: async (ctx) => {
    console.log("[onReady] Starting, PluginHost available:", typeof PluginHost);
    const { renderer, simSAB, inputSAB } = ctx;
    const sim = ctx.sim! as SimWebWorker;

    useGameStore.getState().setRendererReady(true);

    (renderer as WebGPURenderer).setSimReader(simSAB!);
    (renderer as WebGPURenderer).setInputWriter(inputSAB!);

    // ── Physics props controller ──
    physicsController = new PhysicsPropsController(sim);

    // ── Weapon controller ──
    const weaponController = new WeaponController({
      sim, renderer: renderer as WebGPURenderer, simSAB: simSAB!,
      getShapeForContent: (id) => contentRegistry.get(id)?.shape,
    });

    // ── Paint system ──
    paintSystem = new PaintSystem({ sim, renderer: renderer as WebGPURenderer, simSAB: simSAB! });

    // ── VR module ──
    vrModule = new SandboxVRModule({ renderer: renderer as WebGPURenderer, sim });
    vrModule.checkSupport().then((supported) => {
      if (supported) console.log("[VR] VR supported — press KeyV to enter VR mode");
      else console.log("[VR] VR not supported on this device");
    });

    // ── Discover plugins via PluginHost ──
    // The PluginHost is the canonical mod loader. It discovers both mod.json
    // (new format) and plugin.json (legacy format, auto-normalized). Extension
    // loaders bridge into the sandbox's ContentRegistry, PostProcessStack, and
    // MaterialRegistry. Legacy plugins with custom `props` sections also get
    // scanned by PluginScanner for backward compat.
    let pluginHost: PluginHost | null = null;
    try {
      console.log("[PluginHost] Starting plugin discovery...");
      // Discover both mod.json and plugin.json manifests.
      const modModules = import.meta.glob("../plugins/*/mod.json", { eager: true, query: "?json", import: "default" });
      const pluginModules = import.meta.glob("../plugins/*/plugin.json", { eager: true, query: "?json", import: "default" });
      console.log("[PluginHost] glob results:", { mods: Object.keys(modModules), plugins: Object.keys(pluginModules) });
      const baseUrlByManifestId = new Map<string, string>();
      const allManifests: Array<{ manifest: any; baseUrl: string }> = [];
      for (const [path, manifest] of Object.entries(modModules)) {
        // Convert glob path (e.g. "../plugins/acid-postfx/mod.json") to a URL
        // relative to the Vite dev server root (the game directory).
        const pluginDir = path.replace("/mod.json", "");
        const absDir = pluginDir.replace(/^\.\.\//, "/");
        allManifests.push({ manifest: manifest as any, baseUrl: absDir });
      }
      for (const [path, manifest] of Object.entries(pluginModules)) {
        const pluginDir = path.replace("/plugin.json", "");
        const absDir = pluginDir.replace(/^\.\.\//, "/");
        allManifests.push({ manifest: manifest as any, baseUrl: absDir });
      }
      console.log(`[PluginHost] Discovered ${allManifests.length} manifest(s):`, allManifests.map((m) => m.manifest.id));
      // Track base URLs for the asset bridge to resolve relative paths.
      for (const { manifest, baseUrl } of allManifests) {
        baseUrlByManifestId.set(manifest.id, baseUrl);
      }
      // Create the PluginHost with extension loaders bridged into sandbox registries.
      pluginHost = new PluginHost({
        gameId: "andrews-sandbox",
        engineVersion: ENGINE_VERSION,
      });
      registerAllExtensionLoaders(
        (loader) => pluginHost!.registerExtensionLoader(loader),
        {
          assets: createContentRegistryAssetBridge(
            contentRegistry,
            (manifestId) => baseUrlByManifestId.get(manifestId) ?? "",
          ),
          maps: createNoopMapRegistry(),
          physics: createNoopPhysicsRegistry(),
          shaders: createShaderBridge(
            (renderer as any)?.getPostProcessStack?.() ?? null,
            materialRegistry,
            (manifestId: string) => baseUrlByManifestId.get(manifestId) ?? "",
          ),
        },
      );
      // Discover all manifests.
      for (const { manifest, baseUrl } of allManifests) {
        const r = pluginHost.discover(manifest, baseUrl);
        if (!r.ok) {
          console.warn(`[PluginHost] Rejected manifest "${manifest.id}":`, r.errors);
        } else {
          console.log(`[PluginHost] Discovered mod "${manifest.id}"`);
        }
      }
      // Load all discovered mods.
      await pluginHost.loadAll();
      // Legacy backward compat: also run PluginScanner for plugins with custom
      // `props` sections (e.g. bouncy-ball) that the normalizer doesn't handle.
      const legacyWithProps = allManifests.filter(({ manifest }) => (manifest as any).props);
      if (legacyWithProps.length > 0) {
        const scanned = pluginScanner.scan(legacyWithProps);
        for (const plugin of scanned) {
          for (const entry of plugin.entries) {
            if (!contentRegistry.get(entry.id)) contentRegistry.register(entry);
          }
          console.log(`[Renderer] Legacy plugin (props section): ${plugin.manifest.id} (${plugin.entries.length} entries)`);
        }
      }
      const activeCount = pluginHost.snapshot().filter((p) => p.status === "active").length;
      console.log(`[PluginHost] Loaded ${activeCount} mods`);
    } catch (err) {
      console.error("[Renderer] Plugin discovery failed:", err);
    }

    // ── Expose console API for debugging ──
    (globalThis as any).dd = {
      mods: pluginHost?.snapshot() ?? [],
      materialRegistry,
      pluginHost,
    };

    // ── Drag-drop importer ──
    dragDropImporter = new DragDropImporter(contentRegistry);
    dragDropImporter.attach(document);

    // ── Crosshair reticle ──
    const crosshair = document.createElement("div");
    crosshair.className = "sandbox-crosshair";
    document.body.appendChild(crosshair);

    // ── Start PixiUI overlay ──
    const pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: SANDBOX_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi/pixi-scene.tsx", import.meta.url).href,
      passThrough: false,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
    });
    let pixiStarted = false;
    try {
      await pixiHost.start();
      pixiStarted = true;
      console.log("[Renderer] PixiUI host started successfully, pixiStarted=true");
    } catch (err) {
      console.warn("[Renderer] PixiUI worker failed to start (UI will be unavailable):", err);
    }
    // Build DOM HUD (toolbar, funbar, badges, ESC menu, paint palette).
    // The asset browser runs in the pixi-ui overlay (not the DOM HUD).
    buildDomHud(ctx, contentRegistry, weaponController, physicsController, paintSystem, sim);

    // ── Send content list + spawn counts to the pixi-ui worker ──
    pixiUiHost = pixiHost;
    if (pixiStarted) {
      pixiHost.postEvent({ kind: "contentList", items: contentRegistry.listItems() } as any);
      // Re-send whenever the registry changes (drag-drop, plugin scan)
      contentRegistry.onChange(() => {
        pixiHost.postEvent({ kind: "contentList", items: contentRegistry.listItems() } as any);
      });
    }

    // ── Per-frame stats to the pixi-ui worker (showBrowser, fps, etc.) ──
    const pixiStatsInterval = setInterval(() => {
      if (!pixiStarted) return;
      const s = useGameStore.getState();
      pixiHost.writeStats({
        fps: s.fps,
        propCount: s.propCount,
        showBrowser: s.showContentBrowser ? 1 : 0,
        activeTool: s.activeTool,
        funMode: s.activeFunMode,
      });
    }, 100);
    (ctx as any)._pixiStatsInterval = pixiStatsInterval;

    // ── Interactive mode: unlock cursor when the browser opens ──
    pixiHost.onInteractiveChange = (interactive: boolean) => {
      const domHud = (ctx as any)._domHud as any;
      if (interactive) {
        // Browser opened — release pointer lock so the cursor is free.
        // The sim keeps running (props keep falling).
        if (document.pointerLockElement) {
          document.exitPointerLock();
        }
        useGameStore.getState().setShowEscMenu(false);
        // Hide the DOM HUD so it doesn't render in front of the pixi overlay.
        if (domHud?.hud) domHud.hud.style.display = "none";
        if (domHud?.toolbar) domHud.toolbar.style.display = "none";
        if (domHud?.funbar) domHud.funbar.style.display = "none";
        if (domHud?.palette) domHud.palette.style.display = "none";
      } else {
        // Browser closed — re-acquire pointer lock + restore DOM HUD.
        if (domHud?.hud) domHud.hud.style.display = "";
        if (domHud?.toolbar) domHud.toolbar.style.display = "";
        if (domHud?.funbar) domHud.funbar.style.display = "";
        if (domHud?.palette) domHud.palette.style.display = "";
        if (!useGameStore.getState().showEscMenu) {
          (ctx as any)._requestPointerLockSafe?.();
        }
      }
    };

    pixiHost.onAction = ((action: any) => {
      const a = action as SandboxAction;
      const s = useGameStore.getState();
      switch (a.kind) {
        case "toggleContentBrowser":
          s.toggleContentBrowser();
          break;
        case "closeBrowser":
          useGameStore.getState().setShowEscMenu(false);
          useGameStore.setState({ showContentBrowser: false });
          break;
        case "selectContent":
          weaponController.getToolgun().setSelectedContent(a.contentId);
          break;
        case "toggleToolWheel":
          s.toggleToolWheel();
          break;
        case "setTool":
          s.setActiveTool(a.tool);
          sim.sendCommand({ type: "setTool", tool: a.tool });
          weaponController.setTool(a.tool);
          break;
        case "setFunMode":
          s.setActiveFunMode(a.mode);
          physicsController?.setFunMode(a.mode);
          break;
        case "spawn": {
          const cam = (renderer as WebGPURenderer).getCameraPosition();
          const target = (renderer as WebGPURenderer).getCameraTarget();
          const dx = target[0] - cam[0];
          const dy = target[1] - cam[1];
          const dz = target[2] - cam[2];
          const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const fx = dx / dl, fy = dy / dl, fz = dz / dl;
          const count = a.count ?? 1;
          const st = a.settings;
          const physics = {
            mass: st?.mass ?? 1.0,
            restitution: st?.restitution ?? 0.3,
            friction: st?.friction ?? 0.5,
            gravityScale: st?.gravityScale ?? 1.0,
          };
          const shape = st?.shape ?? (a.contentId.includes("sphere") || a.contentId.includes("ball") ? "sphere" : "box");
          const scale = st?.scale ?? 1.0;
          for (let i = 0; i < count; i++) {
            // Scatter for multi-spawn
            const spread = count > 1 ? 2.5 : 0;
            const offX = count > 1 ? (i % 5 - 2) * spread : 0;
            const offY = count > 1 ? Math.floor(i / 5) * spread : 0;
            const rx = fz, rz = -fx;
            sim.sendCommand({
              type: "spawn",
              contentId: a.contentId,
              position: [
                cam[0] + fx * 5 + rx * offX,
                cam[1] + fy * 5 + 2 + offY,
                cam[2] + fz * 5 + rz * offX,
              ],
              physics,
              shape,
              scale,
              strength: st?.strength,
              texture: st?.texture,
              shader: st?.shader,
              squishy: st?.squishy,
            });
          }
          // Also set the toolgun's selected content so toolgun-spawn can use it
          weaponController.getToolgun().setSelectedContent(a.contentId);
          break;
        }
        case "clearProps":
          sim.sendCommand({ type: "clear" });
          spawnCounts.clear();
          sendSpawnCountsToWorker();
          break;
        case "saveGame":
          ctx.save!("autosave");
          break;
        case "loadGame":
          ctx.load!("autosave");
          break;
        case "setPaintColor":
          s.setPaintColor(a.color);
          paintSystem?.setBrushColorHex(a.color);
          break;
        case "setPaintSize":
          s.setPaintSize(a.size);
          paintSystem?.setBrushSize(a.size);
          break;
        case "setPaintHardness":
          s.setPaintHardness(a.hardness);
          paintSystem?.setBrushHardness(a.hardness);
          break;
      }
    });

    const statsInterval = setInterval(() => {
      // Stats now handled by DOM HUD — no PixiUI stats needed
    }, 100);

    // ── Pointer lock + keyboard + mouse input ──
    // ESC flow:
    // 1. First ESC (pointer lock active): Chromium exits pointer lock at the
    //    OS level before before-input-event can prevent it. The
    //    pointerlockchange handler auto-opens the menu.
    // 2. Subsequent ESC (pointer lock not active): before-input-event fires,
    //    prevents the keydown from reaching the renderer, and sends an IPC.
    //    The IPC handler toggles the menu.
    // 3. Closing the menu: re-acquire pointer lock (instant with the polyfill).
    const canvas = ctx.canvas;
    let yaw = 0;
    let pitch = 0;
    let pointerLocked = false;
    // Timestamp of the last wheel event while the physgun was active. Some
    // mice / raw-input setups emit a spurious horizontal mousemove when the
    // scroll wheel is used; we suppress camera rotation for a short window
    // after each wheel event so the wheel stays dedicated to the physgun.
    let lastWheelAt = 0;
    const keys = new Set<string>();

    // Click canvas to acquire pointer lock (initial entry or recovery).
    // With the raw-input polyfill, requestPointerLock() is instant — no
    // Chrome ESC cooldown, no retry needed.
    canvas.addEventListener("click", () => {
      if (!pointerLocked && !useGameStore.getState().showEscMenu) {
        canvas.requestPointerLock();
      }
    });

    // Pointer lock state tracking.
    document.addEventListener("pointerlockchange", () => {
      pointerLocked = document.pointerLockElement === canvas;
      console.log(`[Input] Pointer lock: ${pointerLocked ? "active" : "released"}`);
      if (!pointerLocked) {
        // Clear input state when lock is released
        keys.clear();
      }
    });
    document.addEventListener("pointerlockerror", (e) => {
      e.preventDefault();
    });

    // Expose lock function for menu close to re-acquire pointer lock.
    function requestPointerLockSafe(): void {
      if (!useGameStore.getState().showEscMenu) {
        canvas.requestPointerLock();
      }
    }
    (ctx as any)._requestPointerLockSafe = requestPointerLockSafe;
    (ctx as any)._markMenuClosed = () => {};

    // Mouse look — gated on !showEscMenu. While the physgun is right-click
    // rotating a held prop, mouse movement drives prop rotation instead of
    // the camera (Garry's Mod-style).
    document.addEventListener("mousemove", (e) => {
      if (!pointerLocked) return;
      if (useGameStore.getState().showEscMenu) return;
      if (weaponController.getTool() === ToolType.Physgun && weaponController.getPhysgun().isRotating()) {
        weaponController.getPhysgun().onRotateDrag(e.movementX, e.movementY);
        return;
      }
      // Suppress camera rotation for a brief window after a wheel scroll —
      // some mice / raw-input setups emit a spurious (often horizontal-only)
      // mousemove when the scroll wheel is used, which would otherwise yaw the
      // camera and stutter when scrolling + moving the mouse at the same time.
      // Applies to all tools/modes (not just the physgun) since the spurious
      // deltas come from the raw mouse hardware, not the active tool.
      if ((performance.now() - lastWheelAt) < 80) return;
      yaw += e.movementX * 0.0025;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch - e.movementY * 0.0025));
      applyCamera(renderer as WebGPURenderer, yaw, pitch);
    });

    // Left-click fires weapon (only during pointer lock + menu closed)
    canvas.addEventListener("mousedown", (e) => {
      if (!pointerLocked) return;
      if (useGameStore.getState().showEscMenu) return;
      if (e.button === 0) {
        weaponController.onPrimaryDown();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.startFiring();
      } else if (e.button === 2) {
        // Right-click: rotate a held prop (GMod-style). If not currently
        // grabbing, fall back to toggling the grab mode (Ghost ↔ Solid).
        if (weaponController.getTool() === ToolType.Physgun) {
          const gun = weaponController.getPhysgun();
          if (gun.isGrabbing()) gun.onSecondaryDown();
          else { gun.toggleMode(); (ctx as any)._domHud?.updateToolBtns?.(); }
        }
      }
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        weaponController.onPrimaryUp();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.stopFiring();
      } else if (e.button === 2) {
        if (weaponController.getTool() === ToolType.Physgun) {
          weaponController.getPhysgun().onSecondaryUp();
        }
      }
    });

    // Prevent context menu (so right-click doesn't break flow)
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Scroll wheel:
    //  - Physgun active + rotating a held prop → cycle rotation axis.
    //  - Physgun active + grabbing            → adjust grab distance.
    //  - Physgun active + not grabbing        → consumed (no effect); the wheel
    //    is reserved for the physgun so it never moves the camera while held.
    //  - Otherwise (no physgun) in ThirdPerson → adjust camera distance.
    canvas.addEventListener("wheel", (e) => {
      if (useGameStore.getState().showEscMenu) return;
      // Record the timestamp of every wheel event so the mousemove handler
      // can suppress the spurious (often horizontal-only) mousemove events
      // that some mice / raw-input setups emit when the scroll wheel is
      // used. Without this, scrolling + moving the mouse simultaneously
      // stutters the camera because the spurious deltas fight the real ones.
      lastWheelAt = performance.now();
      if (weaponController.getTool() === ToolType.Physgun) {
        e.preventDefault();
        const gun = weaponController.getPhysgun();
        if (gun.isRotating()) gun.cycleRotationAxis();
        else if (gun.isGrabbing()) gun.adjustDistance(-e.deltaY * 0.01);
        return;
      }
      if (cameraMode === CameraMode.ThirdPerson) {
        e.preventDefault();
        thirdPersonDistance = Math.max(
          THIRD_PERSON_MIN_DIST,
          Math.min(THIRD_PERSON_MAX_DIST, thirdPersonDistance - e.deltaY * 0.01),
        );
        applyCamera(renderer as WebGPURenderer, yaw, pitch);
      }
    }, { passive: false });

    // ESC menu toggle. With the raw-input polyfill, ESC is a normal keydown
    // event — Chrome's ESC-exits-pointer-lock behavior doesn't apply because
    // we never engage the real Pointer Lock API. The game's keydown handler
    // processes ESC and calls exitPointerLock() (the polyfill version, which
    // is instant with no cooldown).
    function toggleEscMenu(): void {
      const cur = useGameStore.getState();
      if (cur.showEscMenu) {
        // Let the nav system try to consume ESC (content→sidebar).
        // If it returns false, we're already in the sidebar → close the menu.
        if (!(ctx as any)._escHandleEscape?.()) {
          useGameStore.getState().setShowEscMenu(false);
          sim.resume();
          // Re-acquire pointer lock — instant with the polyfill, no cooldown.
          requestPointerLockSafe();
        }
      } else {
        // Opening the menu. Exit pointer lock programmatically.
        if (document.pointerLockElement) {
          document.exitPointerLock();
        }
        useGameStore.getState().setShowEscMenu(true);
        sim.pause();
      }
    }

    // Unified keyboard handler — shortcuts + movement keys
    window.addEventListener("keydown", (e) => {
      // If the asset browser is open, let the pixi worker handle all keys
      // (including ESC for clearing search / closing the browser). KeyB also
      // toggles the browser closed from the main thread. Don't toggle the ESC
      // menu while the browser is open — ESC is used by the browser.
      if (useGameStore.getState().showContentBrowser) {
        if (e.code === "KeyB") {
          e.preventDefault();
          useGameStore.getState().toggleContentBrowser();
        }
        return;
      }
      // ESC menu — takes priority over everything else.
      if (e.code === "Escape") {
        e.preventDefault();
        toggleEscMenu();
        return;
      }
      // Block game input while ESC menu is open
      if (useGameStore.getState().showEscMenu) return;

      keys.add(e.code);
      const s = useGameStore.getState();
      switch (e.code) {
        case "KeyB":
          useGameStore.getState().toggleContentBrowser();
          break;
        case "KeyP": toggleDomPanel(ctx, "palette"); break;
        case "F1": {
          // Toggle hitbox/collider debug overlay for all props + the player.
          e.preventDefault();
          const r1 = renderer as WebGPURenderer;
          const next = !r1.isShowHitboxes();
          r1.setShowHitboxes(next);
          console.log(`[Debug] Hitboxes: ${next ? "ON" : "OFF"}`);
          break;
        }
        case "F5": e.preventDefault(); ctx.save!("autosave"); break;
        case "F9": e.preventDefault(); ctx.load!("autosave"); break;
        case "Digit1": weaponController.setTool(ToolType.Physgun); s.setActiveTool(ToolType.Physgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit2": weaponController.setTool(ToolType.Toolgun); s.setActiveTool(ToolType.Toolgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit3": weaponController.setTool(ToolType.Pistol); s.setActiveTool(ToolType.Pistol); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit4": weaponController.setTool(ToolType.Paintgun); s.setActiveTool(ToolType.Paintgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "KeyV": vrModule?.toggleVR().catch((e) => console.warn("[VR] Failed to toggle VR:", e)); break;
        case "KeyC": {
          // Cycle FirstPerson → ThirdPerson → FreeCam → FirstPerson.
          const r2 = renderer as WebGPURenderer;
          const next = ((cameraMode + 1) % 3) as CameraMode;
          if (next === CameraMode.FreeCam) {
            // Seed freecam from the current camera position for a seamless handoff.
            const cp = r2.getCameraPosition();
            freecamPos = [cp[0], cp[1], cp[2]];
          } else if (cameraMode === CameraMode.FreeCam) {
            // Leaving FreeCam — zero vertical velocity so the player doesn't
            // resume with a stale downward velocity from before the freeze.
            vy = 0;
          }
          cameraMode = next;
          useGameStore.getState().setCameraMode(next);
          applyCamera(r2, yaw, pitch);
          console.log(`[Camera] Mode: ${CAMERA_MODE_NAMES[next]}`);
          break;
        }
        case "KeyR": weaponController.getToolgun().setContext(ToolgunContext.Remove); console.log("[Toolgun] Context: Remove"); break;
        case "KeyT": weaponController.getToolgun().setContext(ToolgunContext.Spawn); console.log("[Toolgun] Context: Spawn"); break;
        case "KeyG": weaponController.getToolgun().setContext(ToolgunContext.SetFunMode); console.log("[Toolgun] Context: SetFunMode"); break;
        case "KeyF": {
          // Cycle fun mode: Normal → Moon → ZeroG → Bouncy → Squishy → Normal.
          // The DOM fun-mode bar isn't clickable while the pointer is locked,
          // so this keybind is the primary way to switch modes in-game.
          const FUN_CYCLE = [FunMode.Normal, FunMode.Moon, FunMode.ZeroG, FunMode.Bouncy, FunMode.Squishy];
          const cur = s.activeFunMode;
          const idx = FUN_CYCLE.indexOf(cur);
          const next = FUN_CYCLE[(idx + 1) % FUN_CYCLE.length];
          s.setActiveFunMode(next);
          physicsController?.setFunMode(next);
          // Keep the toolgun's selectedFunMode in sync so the SetFunMode context
          // (KeyG → left-click) fires the same mode the badge shows.
          weaponController.getToolgun().setFunMode(next);
          console.log(`[FunMode] ${FUN_NAMES[next]}`);
          break;
        }
      }
    });
    window.addEventListener("keyup", (e) => { keys.delete(e.code); });

    // Game loop — weapon tick + WASD movement via Rapier character controller
    const GRAVITY = 20.0;
    const JUMP_VELOCITY = 8.0;
    const MOVE_SPEED = 8.0;
    let vy = 0;
    let lastWeaponTick = performance.now();
    // Last pose sent to the sim — only dispatch setPose on transitions to
    // avoid flooding the sim worker with redundant commands every frame.
    let lastSentPose: PoseState = PoseState.Standing;
    const moveLoop = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - lastWeaponTick) / 1000, 0.05);
      lastWeaponTick = now;
      // Skip game logic while ESC menu is open
      if (useGameStore.getState().showEscMenu) return;
      // While the asset browser is open, keep ticking weapons/paint/VR but
      // skip player movement (WASD is used for keyboard navigation instead).
      const browserOpen = useGameStore.getState().showContentBrowser;
      weaponController.tick(dt);
      paintSystem?.tick();
      vrModule?.tick(dt);
      const r = renderer as WebGPURenderer;
      // Feed the player's current capsule dimensions to the renderer so the
      // F1 hitbox overlay can draw an accurate player collider.
      const pc = POSE_COLLIDER[playerState.pose];
      r.setPlayerHitbox(playerState.pos[0], playerState.pos[1], playerState.pos[2], pc.height, pc.radius);
      // Forward the physgun's hover target to the renderer so the looked-at
      // prop gets the outline shader. Only relevant when the physgun is active.
      r.setHoverEntity(
        weaponController.getTool() === ToolType.Physgun
          ? weaponController.getPhysgun().getHoverTarget()
          : null,
      );

      // ── FreeCam: fly the camera through the world; the sim player freezes ──
      if (cameraMode === CameraMode.FreeCam) {
        if (browserOpen) { applyCamera(r, yaw, pitch); return; }
        const fwd = getMoveForward(yaw);
        const right = getRightVector(yaw);
        const speed = FREECAM_SPEED;
        let dx = 0, dy = 0, dz = 0;
        if (keys.has("KeyW")) { dx += fwd[0] * speed * dt; dz += fwd[2] * speed * dt; }
        if (keys.has("KeyS")) { dx -= fwd[0] * speed * dt; dz -= fwd[2] * speed * dt; }
        if (keys.has("KeyA")) { dx -= right[0] * speed * dt; dz -= right[2] * speed * dt; }
        if (keys.has("KeyD")) { dx += right[0] * speed * dt; dz += right[2] * speed * dt; }
        // Space = up, Shift = down (no crouch/prone in freecam)
        if (keys.has("Space")) dy += speed * dt;
        if (keys.has("ShiftLeft")) dy -= speed * dt;
        freecamPos[0] += dx;
        freecamPos[1] += dy;
        freecamPos[2] += dz;
        applyCamera(r, yaw, pitch);
        return;
      }

      // ── Player-attached modes (FirstPerson / ThirdPerson) ──
      if (browserOpen) { applyCamera(r, yaw, pitch); return; }
      // Determine desired pose from held keys: CtrlLeft (prone) takes
      // priority over ShiftLeft (crouch); release either to stand.
      const desiredPose = keys.has("ControlLeft")
        ? PoseState.Prone
        : keys.has("ShiftLeft")
          ? PoseState.Crouching
          : PoseState.Standing;
      if (desiredPose !== lastSentPose) {
        sim.sendCommand({ type: "setPose", pose: desiredPose });
        lastSentPose = desiredPose;
      }
      const fwd = getMoveForward(yaw);
      const right = getRightVector(yaw);
      // Compute desired horizontal movement (WASD) — uses yaw-only forward
      // so looking up/down doesn't reduce horizontal speed. Scaled by the
      // current pose's speed multiplier (crouch/prone move slower).
      const speed = MOVE_SPEED * POSE_SPEED_MUL[playerState.pose];
      let dx = 0, dz = 0;
      if (keys.has("KeyW")) { dx += fwd[0] * speed * dt; dz += fwd[2] * speed * dt; }
      if (keys.has("KeyS")) { dx -= fwd[0] * speed * dt; dz -= fwd[2] * speed * dt; }
      if (keys.has("KeyA")) { dx -= right[0] * speed * dt; dz -= right[2] * speed * dt; }
      if (keys.has("KeyD")) { dx += right[0] * speed * dt; dz += right[2] * speed * dt; }
      // Reset vertical velocity when grounded (prevents unbounded gravity
      // accumulation that causes the character controller to receive huge
      // downward deltas, leading to ground clipping and sideways jitter).
      if (playerState.grounded) {
        vy = 0;
      }
      // Jump — only allowed while standing (crouch/prone can't launch).
      if (keys.has("Space") && playerState.grounded && playerState.pose === PoseState.Standing) {
        vy = JUMP_VELOCITY;
      }
      // Apply gravity
      vy -= GRAVITY * dt;
      // Send desired movement delta to the sim worker (Rapier character controller)
      sim.sendCommand({ type: "movePlayer", desiredDelta: [dx, vy * dt, dz] });
      // Ease the camera eye height toward the pose's target so stand↔crouch↔prone
      // transitions glide instead of snapping. Frame-rate-independent exponential
      // smoothing: ~12/s converges in ~250ms, hiding the capsule-resize pop.
      currentEyeHeight += (targetEyeHeight - currentEyeHeight) * Math.min(1, dt * 12);
      // Update camera (position + target) for the active player-attached mode.
      applyCamera(r, yaw, pitch);
    }, 16);

    (ctx as any)._statsInterval = statsInterval;
    (ctx as any)._moveLoop = moveLoop;
    (ctx as any)._pixiHost = pixiHost;

    console.log("[Renderer] Andrew's Sandbox ready");
  },

  onDispose: async (ctx) => {
    const statsInterval = (ctx as any)._statsInterval as ReturnType<typeof setInterval>;
    if (statsInterval) clearInterval(statsInterval);
    const pixiStatsInterval = (ctx as any)._pixiStatsInterval as ReturnType<typeof setInterval>;
    if (pixiStatsInterval) clearInterval(pixiStatsInterval);
    const moveLoop = (ctx as any)._moveLoop as ReturnType<typeof setInterval>;
    if (moveLoop) clearInterval(moveLoop);
    const pixiHost = (ctx as any)._pixiHost as PixiUiHost;
    pixiHost?.dispose();
    dragDropImporter?.detach();
    const hudInterval = (ctx as any)._hudInterval as ReturnType<typeof setInterval>;
    if (hudInterval) clearInterval(hudInterval);
    const domHud = (ctx as any)._domHud as any;
    if (domHud) {
      domHud.hud?.remove();
      domHud.toolbar?.remove();
      domHud.funbar?.remove();
      domHud.palette?.remove();
      domHud.escMenu?.remove();
    }
    document.querySelector(".sandbox-crosshair")?.remove();
    (ctx.renderer as WebGPURenderer).stop();
  },
});

// ── Helpers ──

function countProps(simSAB: SharedArrayBuffer): number {
  const reader = new SimBufferReader(simSAB);
  const count = reader.getEntityCount();
  let props = 0;
  for (let i = 0; i < count; i++) {
    const slot = reader.getEntitySlot(i);
    const type = slot.u32[ENT.TYPE];
    // EntityType.Prop = 0, EntityType.Projectile = 1, EntityType.Mannequin = 3
    // 255 = empty/recycled slot
    if (type === EntityType.Prop || type === EntityType.Mannequin) props++;
  }
  return props;
}

// Toggle a DOM HUD panel by name. Opening a panel releases pointer lock so
// the cursor can interact with it (the panels are pointer-events: auto with
// clickable items / sliders); closing a panel re-acquires pointer lock,
// but only when no other panel or the ESC menu is still open.
function toggleDomPanel(ctx: any, name: "palette"): void {
  const domHud = (ctx as any)._domHud as any;
  if (!domHud) return;
  const el = domHud[name] as HTMLElement;
  if (!el) return;
  const visible = el.style.display !== "none";
  if (visible) {
    // Closing the panel.
    el.style.display = "none";
    const otherPanelOpen = (domHud.palette && domHud.palette.style.display !== "none");
    if (!useGameStore.getState().showEscMenu && !otherPanelOpen && !useGameStore.getState().showContentBrowser) {
      (ctx as any)._requestPointerLockSafe?.();
    }
  } else {
    // Opening the panel — release pointer lock so the cursor is usable.
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    el.style.display = "block";
  }
}

// ── DOM HUD (replaces PixiUI which has a broken worker) ──
function buildDomHud(
  ctx: any,
  registry: ContentRegistry,
  weapons: WeaponController,
  physics: PhysicsPropsController | null,
  paint: PaintSystem | null,
  sim: SimWebWorker,
): void {
  const TOOL_NAMES: Record<number, string> = {
    [ToolType.None]: "None",
    [ToolType.Physgun]: "Physgun",
    [ToolType.Toolgun]: "Toolgun",
    [ToolType.Pistol]: "Pistol",
    [ToolType.Paintgun]: "Paintgun",
  };
  const POSE_NAMES: Record<number, string> = {
    [PoseState.Standing]: "Standing",
    [PoseState.Crouching]: "Crouching",
    [PoseState.Prone]: "Prone",
  };
  const PAINT_COLORS = ["#ff0000", "#00ff00", "#0099ff", "#ffff00", "#ff00ff", "#00ffff", "#ffffff", "#000000"];

  // Top HUD bar
  const hud = document.createElement("div");
  hud.className = "sandbox-hud";
  const hudLeft = document.createElement("div");
  hudLeft.className = "sandbox-hud-left";
  const fpsBadge = document.createElement("span");
  fpsBadge.className = "badge";
  fpsBadge.textContent = "FPS: 0";
  hudLeft.appendChild(fpsBadge);
  const propBadge = document.createElement("span");
  propBadge.className = "badge";
  propBadge.textContent = "Props: 0";
  hudLeft.appendChild(propBadge);
  hud.appendChild(hudLeft);
  const hudRight = document.createElement("div");
  hudRight.className = "sandbox-hud-right";
  const toolBadge = document.createElement("span");
  toolBadge.className = "badge";
  toolBadge.textContent = "Tool: None";
  hudRight.appendChild(toolBadge);
  const modeBadge = document.createElement("span");
  modeBadge.className = "badge";
  modeBadge.textContent = "Mode: Normal";
  hudRight.appendChild(modeBadge);
  const poseBadge = document.createElement("span");
  poseBadge.className = "badge";
  poseBadge.textContent = "Pose: Standing";
  hudRight.appendChild(poseBadge);
  const camBadge = document.createElement("span");
  camBadge.className = "badge";
  camBadge.textContent = "Cam: First Person";
  hudRight.appendChild(camBadge);
  hud.appendChild(hudRight);
  document.body.appendChild(hud);

  // Update HUD from store
  const hudInterval = setInterval(() => {
    const s = useGameStore.getState();
    fpsBadge.textContent = `FPS: ${s.fps}`;
    propBadge.textContent = `Props: ${s.propCount}`;
    toolBadge.textContent = `Tool: ${TOOL_NAMES[s.activeTool] ?? s.activeTool}`;
    modeBadge.textContent = `Mode: ${FUN_NAMES[s.activeFunMode] ?? s.activeFunMode}`;
    poseBadge.textContent = `Pose: ${POSE_NAMES[playerState.pose] ?? playerState.pose}`;
    camBadge.textContent = `Cam: ${CAMERA_MODE_NAMES[s.cameraMode] ?? s.cameraMode}`;
  }, 200);
  (ctx as any)._hudInterval = hudInterval;

  // Content browser is now in the pixi-ui overlay (not the DOM HUD).
  // Tool bar
  const toolbar = document.createElement("div");
  toolbar.className = "sandbox-toolbar";
  const tools: Array<{type: ToolType, label: string}> = [
    { type: ToolType.Physgun, label: "Physgun [1]" },
    { type: ToolType.Toolgun, label: "Toolgun [2]" },
    { type: ToolType.Pistol, label: "Pistol [3]" },
    { type: ToolType.Paintgun, label: "Paintgun [4]" },
  ];
  const toolBtns: HTMLButtonElement[] = [];
  let physgunBtn: HTMLButtonElement | null = null;
  for (const t of tools) {
    const btn = document.createElement("button");
    btn.className = "tool-btn";
    btn.textContent = t.label;
    if (t.type === ToolType.Physgun) {
      physgunBtn = btn;
      btn.classList.add("physgun-btn");
    }
    btn.onclick = () => {
      weapons.setTool(t.type);
      useGameStore.getState().setActiveTool(t.type);
      toolBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      updatePhysgunModeBadge();
    };
    toolbar.appendChild(btn);
    toolBtns.push(btn);
  }
  document.body.appendChild(toolbar);

  // Physgun mode badge — appended to the Physgun tool button. Reflects the
  // current grab mode (Solid = collision-aware, Ghost = no collision) so the
  // player can tell which mode a grab will use without firing.
  const physgunModeBadge = document.createElement("span");
  physgunModeBadge.className = "physgun-mode-badge";
  physgunBtn?.appendChild(physgunModeBadge);
  function updatePhysgunModeBadge(): void {
    const gun = weapons.getPhysgun();
    const isGhost = gun.getMode() === PhysgunMode.Ghost;
    physgunModeBadge.textContent = isGhost ? "Ghost" : "Solid";
    physgunModeBadge.classList.toggle("ghost", isGhost);
    physgunModeBadge.classList.toggle("solid", !isGhost);
  }
  updatePhysgunModeBadge();

  // Fun mode bar
  const funbar = document.createElement("div");
  funbar.className = "sandbox-funmode";
  const modes: Array<{mode: FunMode, label: string}> = [
    { mode: FunMode.Normal, label: "Normal" },
    { mode: FunMode.Moon, label: "Moon" },
    { mode: FunMode.ZeroG, label: "ZeroG" },
    { mode: FunMode.Bouncy, label: "Bouncy" },
    { mode: FunMode.Squishy, label: "Squishy" },
  ];
  const modeBtns: HTMLButtonElement[] = [];
  for (const m of modes) {
    const btn = document.createElement("button");
    btn.className = "mode-btn";
    btn.textContent = m.label;
    btn.onclick = () => {
      physics?.setFunMode(m.mode);
      modeBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    };
    funbar.appendChild(btn);
    modeBtns.push(btn);
  }
  document.body.appendChild(funbar);

  // Paint palette
  const palette = document.createElement("div");
  palette.className = "sandbox-palette";
  palette.style.display = "none";
  const pTitle = document.createElement("h3");
  pTitle.textContent = "Paint Palette (P)";
  palette.appendChild(pTitle);
  const colors = document.createElement("div");
  colors.className = "colors";
  for (const c of PAINT_COLORS) {
    const sw = document.createElement("div");
    sw.className = "color-swatch";
    sw.style.background = c;
    sw.onclick = () => {
      paint?.setBrushColorHex(c);
      colors.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
    };
    colors.appendChild(sw);
  }
  palette.appendChild(colors);
  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Brush Size";
  palette.appendChild(sizeLabel);
  const sizeSlider = document.createElement("input");
  sizeSlider.type = "range";
  sizeSlider.min = "2";
  sizeSlider.max = "80";
  sizeSlider.value = "20";
  sizeSlider.oninput = () => paint?.setBrushSize(parseInt(sizeSlider.value));
  palette.appendChild(sizeSlider);
  document.body.appendChild(palette);

  function updateToolBtns() {
    const s = useGameStore.getState();
    toolBtns.forEach((b, i) => {
      b.classList.toggle("active", tools[i].type === s.activeTool);
    });
    updatePhysgunModeBadge();
  }

  // ── ESC Menu ──
  const escMenu = document.createElement("div");
  escMenu.className = "sandbox-esc-menu";
  escMenu.style.display = "none";

  // Sidebar tabs
  const escSidebar = document.createElement("div");
  escSidebar.className = "sandbox-esc-sidebar";
  const escTitle = document.createElement("div");
  escTitle.className = "sandbox-esc-title";
  escTitle.textContent = "Andrew's Sandbox";
  escSidebar.appendChild(escTitle);

  type EscTab = "main" | "graphics" | "content" | "controls" | "mods";
  const escTabs: Array<{ id: EscTab; label: string }> = [
    { id: "main", label: "Menu" },
    { id: "graphics", label: "Graphics" },
    { id: "mods", label: "Mods" },
    { id: "content", label: "Content" },
    { id: "controls", label: "Controls" },
  ];
  const escTabBtns: HTMLButtonElement[] = [];
  for (const tab of escTabs) {
    const btn = document.createElement("button");
    btn.className = "sandbox-esc-tab";
    btn.textContent = tab.label;
    btn.onclick = () => {
      useGameStore.getState().setEscMenuTab(tab.id);
    };
    escSidebar.appendChild(btn);
    escTabBtns.push(btn);
  }
  escMenu.appendChild(escSidebar);

  // Content area (panels swap based on active tab)
  const escContent = document.createElement("div");
  escContent.className = "sandbox-esc-content";
  escMenu.appendChild(escContent);

  // ── ESC Menu keyboard navigation state ──
  // WASD navigates: W/S moves up/down within the current column;
  // Space/Enter activates. Selection is hidden until the user presses W/S.
  let escNavColumn: "sidebar" | "content" = "sidebar";
  let escNavIndex = 0;
  let escNavActive = false; // false = no visible selection (keyboard not used yet)

  function updateEscTab() {
    const s = useGameStore.getState();
    escTabBtns.forEach((b, i) => {
      b.classList.toggle("active", escTabs[i].id === s.escMenuTab);
    });
    renderEscPanel(s.escMenuTab);
  }

  function renderEscPanel(tab: EscTab) {
    escContent.innerHTML = "";

    if (tab === "main") {
      const items: Array<{ label: string; desc?: string; action: () => void; danger?: boolean }> = [
        {
          label: "Resume",
          desc: "Return to the game",
          action: () => closeEscMenu(),
        },
        {
          label: "Save Game",
          desc: "Save current state to autosave slot",
          action: () => { ctx.save!("autosave").then((ok: boolean) => flashStatus(ok ? "Game saved" : "Save failed")); },
        },
        {
          label: "Load Game",
          desc: "Load from autosave slot",
          action: () => { ctx.load!("autosave").then((st: unknown) => flashStatus(st ? "Game loaded" : "No save found")); },
        },
        {
          label: "Clear All Props",
          desc: "Remove every spawned object",
          action: () => { sim.sendCommand({ type: "clear" }); flashStatus("Props cleared"); },
          danger: true,
        },
        {
          label: "Restart",
          desc: "Reload the page from scratch",
          action: () => { location.reload(); },
          danger: true,
        },
        {
          label: "Quit to Desktop",
          desc: "Close the application window",
          action: () => { window.close(); },
          danger: true,
        },
      ];
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "sandbox-esc-item" + (item.danger ? " danger" : "");
        const lbl = document.createElement("div");
        lbl.className = "sandbox-esc-item-label";
        lbl.textContent = item.label;
        row.appendChild(lbl);
        if (item.desc) {
          const desc = document.createElement("div");
          desc.className = "sandbox-esc-item-desc";
          desc.textContent = item.desc;
          row.appendChild(desc);
        }
        row.onclick = () => item.action();
        escContent.appendChild(row);
      }
    }

    else if (tab === "graphics") {
      buildGraphicsPanel(escContent);
    }

    else if (tab === "mods") {
      buildModsPanel(escContent);
    }

    else if (tab === "content") {
      const list = document.createElement("div");
      list.className = "sandbox-esc-content-list";
      const items2 = registry.listItems();
      if (items2.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sandbox-esc-empty";
        empty.textContent = "No content loaded. Drop GLB/PNG files or add plugins.";
        list.appendChild(empty);
      } else {
        for (const item of items2) {
          const row = document.createElement("div");
          row.className = "sandbox-esc-content-item";
          const icon = document.createElement("div");
          icon.className = "icon";
          icon.textContent = item.id.includes("sphere") || item.id.includes("ball") ? "●" : "■";
          row.appendChild(icon);
          const name = document.createElement("div");
          name.className = "name";
          name.textContent = item.name;
          row.appendChild(name);
          const cat = document.createElement("div");
          cat.className = "cat";
          cat.textContent = item.pluginSource ?? "builtin";
          row.appendChild(cat);
          row.onclick = () => {
            const cam = (ctx.renderer as WebGPURenderer).getCameraPosition();
            const target = (ctx.renderer as WebGPURenderer).getCameraTarget();
            const dx = target[0] - cam[0], dy = target[1] - cam[1], dz = target[2] - cam[2];
            const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
            const entry = registry.get(item.id);
            const shape = entry?.shape ?? (item.id.includes("sphere") || item.id.includes("ball") ? "sphere" : "box");
            sim.sendCommand({
              type: "spawn",
              contentId: item.id,
              position: [cam[0] + (dx/dl)*5, cam[1] + (dy/dl)*5 + 2, cam[2] + (dz/dl)*5],
              physics: entry?.physics,
              shape,
              scale: entry?.scale ?? 1.0,
            });
            weapons.getToolgun().setSelectedContent(item.id);
            flashStatus(`Spawned: ${item.name}`);
          };
          list.appendChild(row);
        }
      }
      escContent.appendChild(list);
    }

    else if (tab === "controls") {
      const controls: Array<[string, string]> = [
        ["WASD", "Move"],
        ["Mouse", "Look around"],
        ["Click", "Use tool / weapon"],
        ["Right-click", "Physgun: rotate held prop (hold + move mouse)"],
        ["Space", "Jump (standing only) / Fly up (Freecam)"],
        ["Shift", "Hold to crouch / Fly down (Freecam)"],
        ["Ctrl", "Hold to prone"],
        ["C", "Cycle camera (First Person → Third Person → Freecam)"],
        ["Scroll", "Physgun: grab distance / rotation axis (while rotating) · Third Person: camera distance"],
        ["1-4", "Switch tools (Physgun, Toolgun, Pistol, Paintgun)"],
        ["B", "Toggle content browser"],
        ["P", "Toggle paint palette"],
        ["Q", "Tool wheel"],
        ["R", "Toolgun: Remove context"],
        ["T", "Toolgun: Spawn context"],
        ["G", "Toolgun: Set Fun Mode"],
        ["F5", "Save game"],
        ["F9", "Load game"],
        ["V", "Toggle VR"],
        ["F1", "Toggle hitbox/collider overlay (props + player)"],
        ["ESC", "Open / close this menu"],
        ["W/S", "Menu: navigate up/down"],
        ["Space", "Menu: activate entry / enter sub-menu"],
        ["ESC", "Menu: back to tabs / close menu"],
      ];
      for (const [key, desc] of controls) {
        const row = document.createElement("div");
        row.className = "sandbox-esc-control-row";
        const k = document.createElement("div");
        k.className = "sandbox-esc-control-key";
        k.textContent = key;
        row.appendChild(k);
        const d = document.createElement("div");
        d.className = "sandbox-esc-control-desc";
        d.textContent = desc;
        row.appendChild(d);
        escContent.appendChild(row);
      }
    }
    // Refresh keyboard-selection highlight after the panel re-renders.
    updateEscSelection();
  }
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  function flashStatus(msg: string) {
    let status = escContent.querySelector(".sandbox-esc-status") as HTMLElement | null;
    if (!status) {
      status = document.createElement("div");
      status.className = "sandbox-esc-status";
      escContent.appendChild(status);
    }
    status.textContent = msg;
    status.style.opacity = "1";
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (status) status.style.opacity = "0";
    }, 2000);
  }

  function buildGraphicsPanel(parent: HTMLElement) {
    const s = useGameStore.getState();
    const addToggle = (label: string, current: boolean, onToggle: () => void) => {
      const row = document.createElement("div");
      row.className = "sandbox-esc-gfx-row";
      const lbl = document.createElement("div");
      lbl.className = "sandbox-esc-gfx-label";
      lbl.textContent = label;
      row.appendChild(lbl);
      const toggle = document.createElement("div");
      let isOn = current;
      toggle.className = "sandbox-esc-toggle" + (isOn ? " on" : "");
      toggle.textContent = isOn ? "ON" : "OFF";
      toggle.onclick = () => {
        isOn = !isOn;
        onToggle();
        toggle.className = "sandbox-esc-toggle" + (isOn ? " on" : "");
        toggle.textContent = isOn ? "ON" : "OFF";
      };
      row.appendChild(toggle);
      parent.appendChild(row);
    };

    const addSlider = (label: string, current: number, min: number, max: number, step: number, onChange: (v: number) => void) => {
      const row = document.createElement("div");
      row.className = "sandbox-esc-gfx-row";
      const lbl = document.createElement("div");
      lbl.className = "sandbox-esc-gfx-label";
      lbl.textContent = `${label}: ${current.toFixed(2)}`;
      row.appendChild(lbl);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(current);
      slider.oninput = () => {
        const v = parseFloat(slider.value);
        lbl.textContent = `${label}: ${v.toFixed(2)}`;
        onChange(v);
      };
      row.appendChild(slider);
      parent.appendChild(row);
    };

    // Post-processing
    addToggle("Bloom", s.bloomEnabled, () => applyGraphicsToggle("bloom"));
    if (s.bloomEnabled) {
      addSlider("  Strength", s.bloomStrength, 0, 3, 0.05, (v) => applyGraphicsValue("bloomStrength", v));
      addSlider("  Threshold", s.bloomThreshold, 0, 2, 0.05, (v) => applyGraphicsValue("bloomThreshold", v));
    }
    addToggle("FXAA", s.fxaaEnabled, () => applyGraphicsToggle("fxaa"));
    addToggle("Tonemap", s.tonemapEnabled, () => applyGraphicsToggle("tonemap"));
    if (s.tonemapEnabled) {
      addSlider("  Exposure", s.exposure, 0.1, 4, 0.05, (v) => applyGraphicsValue("exposure", v));
    }
    addToggle("Vignette", s.vignetteEnabled, () => applyGraphicsToggle("vignette"));
    if (s.vignetteEnabled) {
      addSlider("  Strength", s.vignetteStrength, 0, 1, 0.05, (v) => applyGraphicsValue("vignetteStrength", v));
    }

    // Rendering
    addToggle("Shadows", s.shadowsEnabled, () => applyGraphicsToggle("shadows"));
    addToggle("Mipmaps", s.mipmapsEnabled, () => applyGraphicsToggle("mipmaps"));
    addToggle("Point Lights", s.pointLightsEnabled, () => applyGraphicsToggle("pointLights"));

    // Lighting
    addSlider("Sun R", s.sunColorR, 0, 2, 0.05, (v) => applyGraphicsValue("sunR", v));
    addSlider("Sun G", s.sunColorG, 0, 2, 0.05, (v) => applyGraphicsValue("sunG", v));
    addSlider("Sun B", s.sunColorB, 0, 2, 0.05, (v) => applyGraphicsValue("sunB", v));
    addSlider("Ambient", s.ambientIntensity, 0, 2, 0.05, (v) => applyGraphicsValue("ambient", v));
  }

  // ── Mods panel ──
  // Lists each loaded mod as a collapsible section with an enable/disable
  // switch and a settings UI for mod-defined postfx effects (sliders,
  // toggles, selects). Settings are hidden when the effect is disabled.
  function buildModsPanel(parent: HTMLElement) {
    const r = ctx.renderer as WebGPURenderer;
    const stack = r.getPostProcessStack();
    const dd = (globalThis as any).dd;
    const mods = dd?.mods as Array<{ id: string; name?: string; status: string }> | undefined;
    const pluginHost = dd?.pluginHost as any;
    console.log("[ModsPanel] dd:", !!dd, "mods:", mods?.length ?? 0, mods?.map((m) => ({ id: m.id, status: m.status })));

    if (!mods || mods.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sandbox-esc-empty";
      empty.textContent = "No mods loaded. Add mods to games/andrews-sandbox/plugins/*/mod.json";
      parent.appendChild(empty);
      return;
    }

    for (const mod of mods) {
      // Find custom postfx effects for this mod (if any).
      const customEffects = stack
        ? stack.getCustomEffects().filter((e: any) => e.id.startsWith(`${mod.id}:`))
        : [];
      const hasEffects = customEffects.length > 0;
      const isLoaded = mod.status === "active";

      // Mod container (collapsible).
      const modDiv = document.createElement("div");
      modDiv.className = "sandbox-esc-mod";

      // Mod header: [arrow] [name] ........ [status] [toggle]
      const modHeader = document.createElement("div");
      modHeader.className = "sandbox-esc-mod-header" + (hasEffects ? " sandbox-esc-mod-collapsible" : "");

      // Left side: arrow + name.
      const modLeft = document.createElement("div");
      modLeft.className = "sandbox-esc-mod-left";
      let arrow: HTMLElement | null = null;
      if (hasEffects) {
        arrow = document.createElement("div");
        arrow.className = "sandbox-esc-mod-arrow";
        arrow.textContent = "\u25B6";
        modLeft.appendChild(arrow);
      }
      const modName = document.createElement("div");
      modName.className = "sandbox-esc-mod-name";
      modName.textContent = mod.name ?? mod.id;
      modLeft.appendChild(modName);
      modHeader.appendChild(modLeft);

      // Right side: status + toggle.
      const modRight = document.createElement("div");
      modRight.className = "sandbox-esc-mod-right";
      const modStatus = document.createElement("div");
      modStatus.className = "sandbox-esc-mod-status";
      modStatus.textContent = mod.status;
      modRight.appendChild(modStatus);
      const modToggle = document.createElement("div");
      // For shader mods: ON means at least one effect is enabled.
      // For asset mods: ON means the mod is loaded.
      let modIsOn = hasEffects
        ? customEffects.some((e: any) => e.enabled)
        : isLoaded;
      modToggle.className = "sandbox-esc-toggle" + (modIsOn ? " on" : "");
      modToggle.textContent = modIsOn ? "ON" : "OFF";
      modToggle.onclick = async (e) => {
        e.stopPropagation();
        if (!pluginHost) return;
        modIsOn = !modIsOn;
        if (hasEffects && stack) {
          // Shader mod: enable/disable all its effects.
          for (const eff of customEffects) {
            stack.setCustomEffectEnabled(eff.id, modIsOn);
          }
        } else {
          // Asset mod: load/unload the mod.
          if (modIsOn) {
            await pluginHost.reload(mod.id);
          } else {
            pluginHost.unload(mod.id);
          }
        }
        // Refresh snapshot + rebuild entire panel.
        dd.mods = pluginHost.snapshot();
        parent.innerHTML = "";
        buildModsPanel(parent);
      };
      modRight.appendChild(modToggle);
      modHeader.appendChild(modRight);

      // Expand/collapse (only if the mod has effects and is loaded).
      let collapsed = true;
      let body: HTMLElement | null = null;
      if (hasEffects) {
        body = document.createElement("div");
        body.className = "sandbox-esc-mod-body";
        body.style.display = "none";
        modHeader.onclick = () => {
          collapsed = !collapsed;
          if (body) body.style.display = collapsed ? "none" : "block";
          if (arrow) arrow.textContent = collapsed ? "\u25B6" : "\u25BC";
        };
      }
      modDiv.appendChild(modHeader);

      // Effect list (inside collapsible body).
      if (body && stack) {
        for (const effect of customEffects) {
          const effectDiv = document.createElement("div");
          effectDiv.className = "sandbox-esc-mod-effect";

          // Effect enable/disable toggle row.
          const effectRow = document.createElement("div");
          effectRow.className = "sandbox-esc-gfx-row";
          const effectLabel = document.createElement("div");
          effectLabel.className = "sandbox-esc-gfx-label";
          effectLabel.textContent = effect.name;
          effectRow.appendChild(effectLabel);
          const toggle = document.createElement("div");
          let isOn = effect.enabled;
          toggle.className = "sandbox-esc-toggle" + (isOn ? " on" : "");
          toggle.textContent = isOn ? "ON" : "OFF";

          // Settings container — hidden when effect is off.
          const settingsDiv = document.createElement("div");
          settingsDiv.className = "sandbox-esc-mod-settings";
          settingsDiv.style.display = isOn ? "block" : "none";

          toggle.onclick = () => {
            isOn = !isOn;
            stack.setCustomEffectEnabled(effect.id, isOn);
            toggle.className = "sandbox-esc-toggle" + (isOn ? " on" : "");
            toggle.textContent = isOn ? "ON" : "OFF";
            settingsDiv.style.display = isOn ? "block" : "none";
            // Update mod-level toggle to reflect whether any effect is on.
            const anyOn = customEffects.some((e: any) => {
              if (e.id === effect.id) return isOn;
              return stack.isCustomEffectEnabled(e.id);
            });
            modToggle.className = "sandbox-esc-toggle" + (anyOn ? " on" : "");
            modToggle.textContent = anyOn ? "ON" : "OFF";
          };
          effectRow.appendChild(toggle);
          effectDiv.appendChild(effectRow);

          // Settings UI.
          if (effect.settings) {
            for (const setting of effect.settings) {
              if (setting.type === "slider") {
                const row = document.createElement("div");
                row.className = "sandbox-esc-gfx-row";
                const lbl = document.createElement("div");
                lbl.className = "sandbox-esc-gfx-label";
                const defaultVal = typeof setting.default === "number" ? setting.default : 0;
                lbl.textContent = `${setting.label}: ${defaultVal.toFixed(2)}`;
                row.appendChild(lbl);
                const slider = document.createElement("input");
                slider.type = "range";
                slider.className = "sandbox-esc-slider";
                slider.min = String(setting.min ?? 0);
                slider.max = String(setting.max ?? 1);
                slider.step = String(setting.step ?? 0.01);
                slider.value = String(defaultVal);
                slider.oninput = () => {
                  const v = parseFloat(slider.value);
                  lbl.textContent = `${setting.label}: ${v.toFixed(2)}`;
                  updateEffectUniform(stack, effect.id, effect.settings!, setting.key, v);
                };
                row.appendChild(slider);
                settingsDiv.appendChild(row);
              } else if (setting.type === "toggle") {
                const row = document.createElement("div");
                row.className = "sandbox-esc-gfx-row";
                const lbl = document.createElement("div");
                lbl.className = "sandbox-esc-gfx-label";
                lbl.textContent = setting.label;
                row.appendChild(lbl);
                const toggle2 = document.createElement("div");
                let toggleOn = setting.default === true;
                toggle2.className = "sandbox-esc-toggle" + (toggleOn ? " on" : "");
                toggle2.textContent = toggleOn ? "ON" : "OFF";
                toggle2.onclick = () => {
                  toggleOn = !toggleOn;
                  toggle2.className = "sandbox-esc-toggle" + (toggleOn ? " on" : "");
                  toggle2.textContent = toggleOn ? "ON" : "OFF";
                  updateEffectUniform(stack, effect.id, effect.settings!, setting.key, toggleOn ? 1 : 0);
                };
                row.appendChild(toggle2);
                settingsDiv.appendChild(row);
              } else if (setting.type === "select") {
                const row = document.createElement("div");
                row.className = "sandbox-esc-gfx-row";
                const lbl = document.createElement("div");
                lbl.className = "sandbox-esc-gfx-label";
                lbl.textContent = setting.label;
                row.appendChild(lbl);
                const select = document.createElement("select");
                select.className = "sandbox-esc-select";
                for (const opt of setting.options ?? []) {
                  const option = document.createElement("option");
                  option.value = opt.value;
                  option.textContent = opt.label;
                  if (opt.value === setting.default) option.selected = true;
                  select.appendChild(option);
                }
                select.onchange = () => {
                  const idx = (setting.options ?? []).findIndex((o) => o.value === select.value);
                  updateEffectUniform(stack, effect.id, effect.settings!, setting.key, idx);
                };
                row.appendChild(select);
                settingsDiv.appendChild(row);
              }
            }
          }
          effectDiv.appendChild(settingsDiv);
          body.appendChild(effectDiv);
        }
      }

      if (body) modDiv.appendChild(body);
      parent.appendChild(modDiv);
    }
  }

  /** Write a setting value into a custom effect's uniform buffer. */
  function updateEffectUniform(
    stack: any,
    effectId: string,
    settings: Array<{ key: string; type: string; default: number | boolean | string }>,
    changedKey: string,
    value: number,
  ): void {
    // Build a Float32Array from current setting values.
    // Layout: [inv_w, inv_h, time, setting0, setting1, ...]
    // Per-frame values (0-2) are written by the renderer; user settings start at offset 3.
    const info = stack.getCustomEffectInfo(effectId);
    if (!info) return;
    const uniformSize = (info as any).uniforms ?? 64;
    const data = new Float32Array(uniformSize / 4);
    let offset = 3;
    for (const s of settings) {
      if (s.key === changedKey) {
        data[offset++] = value;
      } else if (s.type === "slider" && typeof s.default === "number") {
        data[offset++] = s.default;
      } else if (s.type === "toggle") {
        data[offset++] = s.default ? 1 : 0;
      } else if (s.type === "select" && typeof s.default === "string") {
        const opts = (s as any).options as Array<{ value: string }> | undefined;
        const idx = opts?.findIndex((o) => o.value === s.default) ?? 0;
        data[offset++] = idx;
      }
    }
    stack.setCustomEffectUniform(effectId, data);
  }

  // Graphics apply helpers — delegate to the existing action handler
  function applyGraphicsToggle(key: string) {
    const r = ctx.renderer as WebGPURenderer;
    const s = useGameStore.getState();
    switch (key) {
      case "bloom": s.setBloomEnabled(!s.bloomEnabled); (r as any).setBloomEnabled?.(!s.bloomEnabled); break;
      case "fxaa": s.setFXAAEnabled(!s.fxaaEnabled); (r as any).setFXAAEnabled?.(!s.fxaaEnabled); break;
      case "tonemap": s.setTonemapEnabled(!s.tonemapEnabled); (r as any).setTonemapEnabled?.(!s.tonemapEnabled); break;
      case "vignette": s.setVignetteEnabled(!s.vignetteEnabled); (r as any).setVignetteEnabled?.(!s.vignetteEnabled); break;
      case "shadows": s.setShadowsEnabled(!s.shadowsEnabled); (r as any).setShadowsEnabled?.(!s.shadowsEnabled); break;
      case "mipmaps": s.setMipmapsEnabled(!s.mipmapsEnabled); (r as any).setMipmapsEnabled?.(!s.mipmapsEnabled); break;
      case "pointLights": s.setPointLightsEnabled(!s.pointLightsEnabled); (r as any).setPointLightsEnabled?.(!s.pointLightsEnabled); break;
    }
  }
  function applyGraphicsValue(key: string, v: number) {
    const r = ctx.renderer as WebGPURenderer;
    const s = useGameStore.getState();
    switch (key) {
      case "bloomStrength": s.setBloomStrength(v); (r as any).setBloomStrength?.(v); break;
      case "bloomThreshold": s.setBloomThreshold(v); (r as any).setBloomThreshold?.(v); break;
      case "exposure": s.setExposure(v); (r as any).setExposure?.(v); break;
      case "vignetteStrength": s.setVignetteStrength(v); (r as any).setVignetteStrength?.(v); break;
      case "sunR": s.setSunColor(v, s.sunColorG, s.sunColorB); (r as any).setSunColor?.(v, s.sunColorG, s.sunColorB); break;
      case "sunG": s.setSunColor(s.sunColorR, v, s.sunColorB); (r as any).setSunColor?.(s.sunColorR, v, s.sunColorB); break;
      case "sunB": s.setSunColor(s.sunColorR, s.sunColorG, v); (r as any).setSunColor?.(s.sunColorR, s.sunColorG, v); break;
      case "ambient": s.setAmbientIntensity(v); (r as any).setAmbientIntensity?.(v); break;
    }
  }

  function closeEscMenu() {
    useGameStore.getState().setShowEscMenu(false);
    sim.resume();
    // Notify the pointerlockchange handler that we just closed the menu,
    // so it doesn't auto-reopen from a stale ESC.
    (ctx as any)._markMenuClosed?.();
    // Re-acquire pointer lock after the cooldown.
    (ctx as any)._requestPointerLockSafe?.();
  }

  // ── ESC Menu keyboard navigation (WASD + Space) ──
  // A/D → switch between sidebar (tabs) and content panel
  // W/S → move up/down within the current column
  // Space/Enter → activate the selected entry
  function collectEscNavTargets(column: "sidebar" | "content"): HTMLElement[] {
    if (column === "sidebar") return escTabBtns;
    const tab = useGameStore.getState().escMenuTab;
    if (tab === "controls") return []; // display-only
    const selector = tab === "main" ? ".sandbox-esc-item"
      : tab === "graphics" ? ".sandbox-esc-gfx-row"
      : tab === "content" ? ".sandbox-esc-content-item"
      : null;
    if (!selector) return [];
    return Array.from(escContent.querySelectorAll<HTMLElement>(selector));
  }

  function updateEscSelection(): void {
    escMenu.querySelectorAll(".sandbox-esc-selected").forEach(el => el.classList.remove("sandbox-esc-selected"));
    if (!escNavActive) return; // No visible selection until keyboard is used
    let targets = collectEscNavTargets(escNavColumn);
    // If the current column has no targets (e.g. controls tab), fall back to sidebar.
    if (targets.length === 0 && escNavColumn === "content") {
      escNavColumn = "sidebar";
      escNavIndex = escTabs.findIndex(t => t.id === useGameStore.getState().escMenuTab);
      if (escNavIndex < 0) escNavIndex = 0;
      targets = collectEscNavTargets(escNavColumn);
    }
    if (targets.length === 0) return;
    if (escNavIndex >= targets.length) escNavIndex = targets.length - 1;
    if (escNavIndex < 0) escNavIndex = 0;
    const el = targets[escNavIndex];
    el.classList.add("sandbox-esc-selected");
    el.scrollIntoView({ block: "nearest" });
  }

  function activateEscSelection(): void {
    const targets = collectEscNavTargets(escNavColumn);
    if (targets.length === 0) return;
    if (escNavIndex >= targets.length) escNavIndex = targets.length - 1;
    if (escNavIndex < 0) escNavIndex = 0;
    const el = targets[escNavIndex];
    // Graphics toggle rows: click the toggle element inside the row.
    // Slider rows: focus the range input so arrow keys can adjust.
    const toggle = el.querySelector(".sandbox-esc-toggle");
    if (toggle) { (toggle as HTMLElement).click(); return; }
    const slider = el.querySelector("input[type=\"range\"]");
    if (slider) { (slider as HTMLElement).focus(); return; }
    el.click();
    // If we activated a sidebar tab, move into the content panel so the
    // player can immediately navigate the tab's entries.
    if (escNavColumn === "sidebar") {
      const contentTargets = collectEscNavTargets("content");
      if (contentTargets.length > 0) {
        escNavColumn = "content";
        escNavIndex = 0;
        updateEscSelection();
      }
    }
  }

  window.addEventListener("keydown", (e) => {
    if (!useGameStore.getState().showEscMenu) return;
    // If a range slider is focused, let it handle arrow keys natively.
    // Escape de-focuses the slider back to row navigation.
    const focused = document.activeElement;
    if (focused && focused.tagName === "INPUT" && (focused as HTMLInputElement).type === "range") {
      if (e.code === "Escape") { (focused as HTMLElement).blur(); e.preventDefault(); }
      return;
    }
    switch (e.code) {
      case "KeyW": case "ArrowUp": {
        e.preventDefault();
        escNavActive = true;
        const targets = collectEscNavTargets(escNavColumn);
        if (targets.length === 0) break;
        // Clamp at the top — don't wrap to the bottom.
        escNavIndex = Math.max(0, escNavIndex - 1);
        updateEscSelection();
        break;
      }
      case "KeyS": case "ArrowDown": {
        e.preventDefault();
        escNavActive = true;
        const targets = collectEscNavTargets(escNavColumn);
        if (targets.length === 0) break;
        // Clamp at the bottom — don't wrap to the top.
        escNavIndex = Math.min(targets.length - 1, escNavIndex + 1);
        updateEscSelection();
        break;
      }
      case "Space": case "Enter":
        e.preventDefault();
        // If keyboard nav hasn't been used yet, activate the first item.
        if (!escNavActive) { escNavActive = true; escNavIndex = 0; updateEscSelection(); }
        activateEscSelection();
        break;
    }
  });

  // Right-click backs out one level (content→sidebar) but doesn't close
  // the ESC menu.
  escMenu.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (escNavColumn === "content") {
      escNavColumn = "sidebar";
      escNavIndex = escTabs.findIndex(t => t.id === useGameStore.getState().escMenuTab);
      if (escNavIndex < 0) escNavIndex = 0;
      escNavActive = true;
      updateEscSelection();
    }
  });

  // Subscribe to store to show/hide the menu. Only react when showEscMenu or
  // escMenuTab actually changes — the store also fires for fps/propCount/etc.
  // updates, and re-rendering on those would reset the keyboard selection.
  let prevShowEsc = false;
  let prevEscTab: EscTab = "main";
  useGameStore.subscribe((state) => {
    const opened = state.showEscMenu !== prevShowEsc;
    const tabChanged = state.escMenuTab !== prevEscTab;
    prevShowEsc = state.showEscMenu;
    prevEscTab = state.escMenuTab;
    if (!opened && !tabChanged) return;
    escMenu.style.display = state.showEscMenu ? "flex" : "none";
    // Blur the game world behind the menu unless the player is on the
    // graphics tab — there they need to see the unblurred scene to judge
    // the effect of their setting changes.
    escMenu.classList.toggle("blurred", state.showEscMenu && state.escMenuTab !== "graphics");
    if (state.showEscMenu) {
      // Reset nav state: sidebar, no visible selection until keyboard used.
      escNavColumn = "sidebar";
      escNavIndex = escTabs.findIndex(t => t.id === state.escMenuTab);
      if (escNavIndex < 0) escNavIndex = 0;
      escNavActive = false;
      updateEscTab();
    }
  });

  document.body.appendChild(escMenu);

  // Expose a single ESC handler for the global keydown handler (which is
  // registered earlier and runs before the nav handler). Returns true if the
  // nav system consumed ESC (content→sidebar), false if the menu should close.
  (ctx as any)._escHandleEscape = (): boolean => {
    if (escNavColumn === "content") {
      escNavColumn = "sidebar";
      escNavIndex = escTabs.findIndex(t => t.id === useGameStore.getState().escMenuTab);
      if (escNavIndex < 0) escNavIndex = 0;
      updateEscSelection();
      return true;
    }
    return false;
  };

  // Expose toggle + updateToolBtns for external keydown handler
  (ctx as any)._domHud = {
    hud, toolbar, funbar, palette,
    escMenu,
    updateToolBtns,
    tools,
  };
}

function applyCamera(renderer: WebGPURenderer, yaw: number, pitch: number): void {
  const fwd = getForwardVector(yaw, pitch);
  switch (cameraMode) {
    case CameraMode.FirstPerson: {
      const eye: [number, number, number] = [
        playerState.pos[0],
        playerState.pos[1] + currentEyeHeight,
        playerState.pos[2],
      ];
      renderer.setCameraPosition(eye);
      renderer.setCameraTarget([eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]]);
      break;
    }
    case CameraMode.ThirdPerson: {
      const eye: [number, number, number] = [
        playerState.pos[0],
        playerState.pos[1] + currentEyeHeight,
        playerState.pos[2],
      ];
      // Orbit the camera behind the player along the view forward, looking at
      // the eye. Distance is adjustable via the scroll wheel.
      renderer.setCameraPosition([
        eye[0] - fwd[0] * thirdPersonDistance,
        eye[1] - fwd[1] * thirdPersonDistance,
        eye[2] - fwd[2] * thirdPersonDistance,
      ]);
      renderer.setCameraTarget(eye);
      break;
    }
    case CameraMode.FreeCam: {
      renderer.setCameraPosition(freecamPos);
      renderer.setCameraTarget([
        freecamPos[0] + fwd[0],
        freecamPos[1] + fwd[1],
        freecamPos[2] + fwd[2],
      ]);
      break;
    }
  }
}

function getForwardVector(yaw: number, pitch: number): [number, number, number] {
  return [
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    -Math.cos(pitch) * Math.cos(yaw),
  ];
}

// Horizontal forward vector (yaw only, no pitch) — used for WASD movement
// so looking up/down doesn't reduce horizontal speed.
function getMoveForward(yaw: number): [number, number, number] {
  return [Math.sin(yaw), 0, -Math.cos(yaw)];
}

function getRightVector(yaw: number): [number, number, number] {
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}
