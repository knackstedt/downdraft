// ============================================================================
// Andrew's Sandbox — Renderer Entry Point
// Declarative GameModule + startGame() bootstrap.
// ============================================================================

import { downdraft, startGame, type SimWorkerSeed } from "@downdraft/app/renderer";
import { ENGINE_VERSION, ENT, SimBufferReader } from "@downdraft/core";
import { PixiUiHost } from "@downdraft/library-pixi-ui";
import { FunMode, ToolType, ToolgunContext } from "@sandbox/shared/types";
import { ContentRegistry, DragDropImporter, PluginScanner, type ContentListItem } from "@andrews-sandbox/library-content";
import { BUILTIN_PROPS } from "@andrews-sandbox/library-props";
import { PhysicsPropsController } from "@andrews-sandbox/module-physics-props";
import { WeaponController } from "@andrews-sandbox/module-weapons";
import { PaintSystem } from "@andrews-sandbox/module-paint";
import { SandboxVRModule } from "@andrews-sandbox/module-vr";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { SANDBOX_STATS_LAYOUT, type SandboxAction } from "./pixi/bridge-protocol";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

(globalThis as any).__ddThreadTag = "R0";

// ── Shared content registry (module-scoped so event handlers can access it) ──
const contentRegistry = new ContentRegistry();
const pluginScanner = new PluginScanner();
let dragDropImporter: DragDropImporter | null = null;
let physicsController: PhysicsPropsController | null = null;
let paintSystem: PaintSystem | null = null;
let vrModule: SandboxVRModule | null = null;

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
  });
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
          const u32 = new Uint32Array(ctx.simSAB!);
          const slotOffset = (data.entityId - 1) * 32 + 18;
          if (slotOffset < u32.length) u32[slotOffset] = nodeIdNum;
        }
      }

      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);
    },
    prop_removed: (_data, ctx) => {
      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);
    },
    fun_mode_changed: (data) => {
      useGameStore.getState().setActiveFunMode(data.mode);
    },
    paint_updated: (_data) => { /* Phase 5 */ },
  },

  save: {
    mode: "auto",
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
    const { renderer, simSAB, inputSAB } = ctx;
    const sim = ctx.sim! as SimWebWorker;

    useGameStore.getState().setRendererReady(true);

    (renderer as WebGPURenderer).setSimReader(simSAB!);
    (renderer as WebGPURenderer).setInputWriter(inputSAB!);

    // ── Physics props controller ──
    physicsController = new PhysicsPropsController(sim);

    // ── Weapon controller ──
    const weaponController = new WeaponController({ sim, renderer: renderer as WebGPURenderer, simSAB: simSAB! });

    // ── Paint system ──
    paintSystem = new PaintSystem({ sim, renderer: renderer as WebGPURenderer, simSAB: simSAB! });

    // ── VR module ──
    vrModule = new SandboxVRModule({ renderer: renderer as WebGPURenderer, sim });
    vrModule.checkSupport().then((supported) => {
      if (supported) console.log("[VR] VR supported — press KeyV to enter VR mode");
      else console.log("[VR] VR not supported on this device");
    });

    // ── Discover plugins ──
    try {
      const pluginModules = import.meta.glob("../plugins/*/plugin.json", { eager: true, query: "?json", import: "default" });
      const manifests: Array<{ manifest: any; baseUrl: string }> = [];
      for (const [path, manifest] of Object.entries(pluginModules)) {
        const pluginDir = path.replace("/plugin.json", "");
        manifests.push({ manifest: manifest as any, baseUrl: pluginDir });
      }
      if (manifests.length > 0) {
        const scanned = pluginScanner.scan(manifests);
        for (const plugin of scanned) {
          for (const entry of plugin.entries) {
            contentRegistry.register(entry);
          }
          console.log(`[Renderer] Loaded plugin: ${plugin.manifest.id} (${plugin.entries.length} entries)`);
        }
      }
    } catch (err) {
      console.warn("[Renderer] Plugin discovery failed:", err);
    }

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
      passThrough: true,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
    });
    try {
      await pixiHost.start();
    } catch (err) {
      console.warn("[Renderer] PixiUI worker failed to start (UI will be unavailable):", err);
    }

    pixiHost.postEvent({ kind: "contentList", items: contentRegistry.listItems() });
    contentRegistry.onChange((items: ContentListItem[]) => {
      pixiHost.postEvent({ kind: "contentList", items });
    });

    pixiHost.onAction = ((action: any) => {
      const a = action as SandboxAction;
      const s = useGameStore.getState();
      switch (a.kind) {
        case "toggleContentBrowser":
          s.toggleContentBrowser();
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
          const entry = contentRegistry.get(a.contentId);
          const shape = a.contentId.includes("sphere") || a.contentId.includes("ball") ? "sphere" : "box";
          sim.sendCommand({
            type: "spawn",
            contentId: a.contentId,
            position: [cam[0] + (dx / dl) * 5, cam[1] + (dy / dl) * 5 + 2, cam[2] + (dz / dl) * 5],
            physics: entry?.physics,
            shape,
            scale: entry?.scale ?? 1.0,
          });
          // Also set the toolgun's selected content so toolgun-spawn can use it
          weaponController.getToolgun().setSelectedContent(a.contentId);
          break;
        }
        case "clearProps":
          sim.sendCommand({ type: "clear" });
          break;
        case "saveGame":
          sim.save("autosave");
          break;
        case "loadGame":
          sim.load("autosave");
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
      const s = useGameStore.getState();
      pixiHost.writeStats({
        fps: s.fps,
        activeTool: s.activeTool,
        funMode: s.activeFunMode,
        propCount: s.propCount,
        showBrowser: s.showContentBrowser ? 1 : 0,
        showToolWheel: s.showToolWheel ? 1 : 0,
        showPaintPalette: s.showPaintPalette ? 1 : 0,
      });
    }, 100);

    // ── Keyboard shortcuts ──
    window.addEventListener("keydown", (e) => {
      const s = useGameStore.getState();
      switch (e.code) {
        case "KeyB": s.toggleContentBrowser(); break;
        case "KeyQ": s.toggleToolWheel(); break;
        case "KeyP": s.togglePaintPalette(); break;
        case "F5": e.preventDefault(); sim.save("autosave"); break;
        case "F9": e.preventDefault(); sim.load("autosave"); break;
        // Fun mode shortcuts
        case "Digit1": physicsController?.setFunMode(FunMode.Normal); break;
        case "Digit2": physicsController?.setFunMode(FunMode.Moon); break;
        case "Digit3": physicsController?.setFunMode(FunMode.ZeroG); break;
        case "Digit4": physicsController?.setFunMode(FunMode.Bouncy); break;
        case "KeyV": vrModule?.toggleVR().catch((e) => console.warn("[VR] Failed to toggle VR:", e)); break;
        case "KeyR": weaponController.getToolgun().setContext(ToolgunContext.Remove); console.log("[Toolgun] Context: Remove"); break;
        case "KeyT": weaponController.getToolgun().setContext(ToolgunContext.Spawn); console.log("[Toolgun] Context: Spawn"); break;
        case "KeyG": weaponController.getToolgun().setContext(ToolgunContext.SetFunMode); console.log("[Toolgun] Context: SetFunMode"); break;
      }
    });

    // ── Mouse look + WASD camera ──
    let mouseDown = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let yaw = 0;
    let pitch = 0;
    const canvas = ctx.canvas;

    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        weaponController.onPrimaryDown();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.startFiring();
      }
      if (e.button === 2) { mouseDown = true; lastMouseX = e.clientX; lastMouseY = e.clientY; }
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        weaponController.onPrimaryUp();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.stopFiring();
      }
      if (e.button === 2) mouseDown = false;
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!mouseDown) return;
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      yaw -= dx * 0.003;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch - dy * 0.003));
      updateCamera(renderer as WebGPURenderer, yaw, pitch);
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Scroll wheel adjusts physgun grab distance
    canvas.addEventListener("wheel", (e) => {
      if (weaponController.getTool() === ToolType.Physgun && weaponController.getPhysgun().isGrabbing()) {
        e.preventDefault();
        weaponController.getPhysgun().adjustDistance(-e.deltaY * 0.01);
      }
    }, { passive: false });

    const keys = new Set<string>();
    window.addEventListener("keydown", (e) => { keys.add(e.code); });
    window.addEventListener("keyup", (e) => { keys.delete(e.code); });

    let lastWeaponTick = performance.now();
    const moveLoop = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastWeaponTick) / 1000;
      lastWeaponTick = now;
      weaponController.tick(dt);
      paintSystem?.tick();
      vrModule?.tick(dt);
      const r = renderer as WebGPURenderer;
      const cam = r.getCameraPosition();
      const speed = 0.3;
      const fwd = getForwardVector(yaw, pitch);
      const right = getRightVector(yaw);
      let nx = cam[0], ny = cam[1], nz = cam[2];
      if (keys.has("KeyW")) { nx += fwd[0] * speed; nz += fwd[2] * speed; }
      if (keys.has("KeyS")) { nx -= fwd[0] * speed; nz -= fwd[2] * speed; }
      if (keys.has("KeyA")) { nx -= right[0] * speed; nz -= right[2] * speed; }
      if (keys.has("KeyD")) { nx += right[0] * speed; nz += right[2] * speed; }
      if (keys.has("Space")) ny += speed;
      if (keys.has("ShiftLeft")) ny -= speed;
      r.setCameraPosition([nx, ny, nz]);
      updateCamera(r, yaw, pitch);
    }, 16);

    (ctx as any)._statsInterval = statsInterval;
    (ctx as any)._moveLoop = moveLoop;
    (ctx as any)._pixiHost = pixiHost;

    console.log("[Renderer] Andrew's Sandbox ready");
  },

  onDispose: async (ctx) => {
    const statsInterval = (ctx as any)._statsInterval as ReturnType<typeof setInterval>;
    if (statsInterval) clearInterval(statsInterval);
    const moveLoop = (ctx as any)._moveLoop as ReturnType<typeof setInterval>;
    if (moveLoop) clearInterval(moveLoop);
    const pixiHost = (ctx as any)._pixiHost as PixiUiHost;
    pixiHost?.dispose();
    dragDropImporter?.detach();
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
    if (type !== 0) props++;
  }
  return props;
}

function updateCamera(renderer: WebGPURenderer, yaw: number, pitch: number): void {
  const pos = renderer.getCameraPosition();
  const target = getForwardVector(yaw, pitch);
  renderer.setCameraTarget([pos[0] + target[0], pos[1] + target[1], pos[2] + target[2]]);
}

function getForwardVector(yaw: number, pitch: number): [number, number, number] {
  return [
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    -Math.cos(pitch) * Math.cos(yaw),
  ];
}

function getRightVector(yaw: number): [number, number, number] {
  return [Math.cos(yaw), 0, -Math.sin(yaw)];
}
