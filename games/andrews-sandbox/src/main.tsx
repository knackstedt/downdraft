// ============================================================================
// Andrew's Sandbox — Renderer Entry Point
// Declarative GameModule + startGame() bootstrap.
// ============================================================================

import { ContentRegistry, DragDropImporter, PluginScanner, type ContentListItem } from "@andrews-sandbox/library-content";
import { BUILTIN_PROPS } from "@andrews-sandbox/library-props";
import { PaintSystem } from "@andrews-sandbox/module-paint";
import { PhysicsPropsController } from "@andrews-sandbox/module-physics-props";
import { SandboxVRModule } from "@andrews-sandbox/module-vr";
import { WeaponController } from "@andrews-sandbox/module-weapons";
import { downdraft, startGame, type SimWorkerSeed } from "@downdraft/app/renderer";
import { ENGINE_VERSION, ENT, SimBufferReader } from "@downdraft/core";
import { PixiUiHost } from "@downdraft/library-pixi-ui";
import { FunMode, ToolType, ToolgunContext } from "@sandbox/shared/types";
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

  onFpsUpdate: (fps, _ctx) => {
    useGameStore.getState().setFps(fps);
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

    // ── Click-to-play overlay ──
    const clickToPlay = document.createElement("div");
    clickToPlay.className = "sandbox-click-to-play";
    clickToPlay.textContent = "Click to play  |  WASD: move  |  Space/Shift: up/down  |  ESC: release mouse";
    document.body.appendChild(clickToPlay);

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
    } catch (err) {
      console.warn("[Renderer] PixiUI worker failed to start (UI will be unavailable):", err);
    }
    // The PixiUI overlay canvas has pointer-events: auto (pass-through mode)
    // and sits above the game canvas (z-index 50 vs 0). When the worker fails,
    // forwardPointer() returns early (no worker) and clicks are never forwarded
    // to the game canvas. Disable pointer events on the overlay so clicks reach
    // the game canvas directly — otherwise pointer lock and all mouse input break.
    // Always disable PixiUI overlay pointer events (we use DOM HUD instead)
    const overlay = pixiHost.overlayCanvas;
    if (overlay) overlay.style.pointerEvents = "none";
    // Build DOM HUD (replaces PixiUI which has a broken worker)
    buildDomHud(ctx, contentRegistry, weaponController, physicsController, paintSystem, sim);

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

    // ── Pointer lock + keyboard + mouse input ──
    const canvas = ctx.canvas;
    let yaw = 0;
    let pitch = 0;
    let pointerLocked = false;
    const keys = new Set<string>();

    // Click canvas to request pointer lock
    canvas.addEventListener("click", () => {
      if (!pointerLocked) {
        canvas.requestPointerLock();
      }
    });

    // Track pointer lock state
    document.addEventListener("pointerlockchange", () => {
      pointerLocked = document.pointerLockElement === canvas;
      console.log(`[Input] Pointer lock: ${pointerLocked ? "active" : "released"}`);
      clickToPlay.classList.toggle("hidden", pointerLocked);
    });

    // Mouse look — uses movementX/Y during pointer lock
    document.addEventListener("mousemove", (e) => {
      if (!pointerLocked) return;
      yaw += e.movementX * 0.0025;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch - e.movementY * 0.0025));
      updateCamera(renderer as WebGPURenderer, yaw, pitch);
    });

    // Left-click fires weapon (only during pointer lock)
    canvas.addEventListener("mousedown", (e) => {
      if (!pointerLocked) return;
      if (e.button === 0) {
        weaponController.onPrimaryDown();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.startFiring();
      }
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        weaponController.onPrimaryUp();
        if (weaponController.getTool() === ToolType.Paintgun) paintSystem?.stopFiring();
      }
    });

    // Prevent context menu (so right-click doesn't break flow)
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Scroll wheel adjusts physgun grab distance
    canvas.addEventListener("wheel", (e) => {
      if (weaponController.getTool() === ToolType.Physgun && weaponController.getPhysgun().isGrabbing()) {
        e.preventDefault();
        weaponController.getPhysgun().adjustDistance(-e.deltaY * 0.01);
      }
    }, { passive: false });

    // Unified keyboard handler — shortcuts + movement keys
    window.addEventListener("keydown", (e) => {
      keys.add(e.code);
      const s = useGameStore.getState();
      switch (e.code) {
        case "KeyB": toggleDomPanel(ctx, "browser"); if (document.pointerLockElement) document.exitPointerLock(); break;
        case "KeyP": toggleDomPanel(ctx, "palette"); if (document.pointerLockElement) document.exitPointerLock(); break;
        case "F5": e.preventDefault(); sim.save("autosave"); break;
        case "F9": e.preventDefault(); sim.load("autosave"); break;
        case "Digit1": weaponController.setTool(ToolType.Physgun); s.setActiveTool(ToolType.Physgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit2": weaponController.setTool(ToolType.Toolgun); s.setActiveTool(ToolType.Toolgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit3": weaponController.setTool(ToolType.Pistol); s.setActiveTool(ToolType.Pistol); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "Digit4": weaponController.setTool(ToolType.Paintgun); s.setActiveTool(ToolType.Paintgun); (ctx as any)._domHud?.updateToolBtns?.(); break;
        case "KeyV": vrModule?.toggleVR().catch((e) => console.warn("[VR] Failed to toggle VR:", e)); break;
        case "KeyR": weaponController.getToolgun().setContext(ToolgunContext.Remove); console.log("[Toolgun] Context: Remove"); break;
        case "KeyT": weaponController.getToolgun().setContext(ToolgunContext.Spawn); console.log("[Toolgun] Context: Spawn"); break;
        case "KeyG": weaponController.getToolgun().setContext(ToolgunContext.SetFunMode); console.log("[Toolgun] Context: SetFunMode"); break;
      }
    });
    window.addEventListener("keyup", (e) => { keys.delete(e.code); });

    // Game loop — weapon tick + WASD movement + player gravity
    const EYE_HEIGHT = 2.0;
    const GRAVITY = 20.0;
    const JUMP_VELOCITY = 8.0;
    const MOVE_SPEED = 8.0;
    let vy = 0;
    let onGround = true;
    let lastWeaponTick = performance.now();
    const moveLoop = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - lastWeaponTick) / 1000, 0.05);
      lastWeaponTick = now;
      weaponController.tick(dt);
      paintSystem?.tick();
      vrModule?.tick(dt);
      const r = renderer as WebGPURenderer;
      const cam = r.getCameraPosition();
      const fwd = getForwardVector(yaw, pitch);
      const right = getRightVector(yaw);
      let nx = cam[0], nz = cam[2];
      // Horizontal movement (WASD)
      if (keys.has("KeyW")) { nx += fwd[0] * MOVE_SPEED * dt; nz += fwd[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyS")) { nx -= fwd[0] * MOVE_SPEED * dt; nz -= fwd[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyA")) { nx -= right[0] * MOVE_SPEED * dt; nz -= right[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyD")) { nx += right[0] * MOVE_SPEED * dt; nz += right[2] * MOVE_SPEED * dt; }
      // Jump (impulse, not continuous)
      if (keys.has("Space") && onGround) {
        vy = JUMP_VELOCITY;
        onGround = false;
      }
      // Crouch / descend
      if (keys.has("ShiftLeft")) {
        vy = -MOVE_SPEED;
        onGround = false;
      }
      // Apply gravity
      vy -= GRAVITY * dt;
      let ny = cam[1] + vy * dt;
      // Floor collision
      if (ny <= EYE_HEIGHT) {
        ny = EYE_HEIGHT;
        vy = 0;
        onGround = true;
      }
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
    const hudInterval = (ctx as any)._hudInterval as ReturnType<typeof setInterval>;
    if (hudInterval) clearInterval(hudInterval);
    const domHud = (ctx as any)._domHud as any;
    if (domHud) {
      domHud.hud?.remove();
      domHud.browser?.remove();
      domHud.toolbar?.remove();
      domHud.funbar?.remove();
      domHud.palette?.remove();
    }
    document.querySelector(".sandbox-crosshair")?.remove();
    document.querySelector(".sandbox-click-to-play")?.remove();
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
    if (type !== 0 && type !== 255) props++;
  }
  return props;
}

// Toggle a DOM HUD panel by name
function toggleDomPanel(ctx: any, name: "browser" | "palette"): void {
  const domHud = (ctx as any)._domHud as any;
  if (!domHud) return;
  const el = domHud[name] as HTMLElement;
  if (!el) return;
  const visible = el.style.display !== "none";
  el.style.display = visible ? "none" : "block";
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
  const FUN_NAMES = ["Normal", "Moon", "ZeroG", "Bouncy"];
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
  hud.appendChild(hudRight);
  document.body.appendChild(hud);

  // Update HUD from store
  const hudInterval = setInterval(() => {
    const s = useGameStore.getState();
    fpsBadge.textContent = `FPS: ${s.fps}`;
    propBadge.textContent = `Props: ${s.propCount}`;
    toolBadge.textContent = `Tool: ${TOOL_NAMES[s.activeTool] ?? s.activeTool}`;
    modeBadge.textContent = `Mode: ${FUN_NAMES[s.activeFunMode] ?? s.activeFunMode}`;
  }, 200);
  (ctx as any)._hudInterval = hudInterval;

  // Content browser
  const browser = document.createElement("div");
  browser.className = "sandbox-browser";
  browser.style.display = "block";
  const title = document.createElement("h3");
  title.textContent = "Content Browser (B)";
  browser.appendChild(title);
  const list = document.createElement("div");
  browser.appendChild(list);

  function renderBrowserItems() {
    list.innerHTML = "";
    const items = registry.listItems();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "sandbox-browser-item";
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
        const shape = item.id.includes("sphere") || item.id.includes("ball") ? "sphere" : "box";
        sim.sendCommand({
          type: "spawn",
          contentId: item.id,
          position: [cam[0] + (dx/dl)*5, cam[1] + (dy/dl)*5 + 2, cam[2] + (dz/dl)*5],
          physics: entry?.physics,
          shape,
          scale: entry?.scale ?? 1.0,
        });
        weapons.getToolgun().setSelectedContent(item.id);
      };
      list.appendChild(row);
    }
    const clearBtn = document.createElement("button");
    clearBtn.className = "clear-btn";
    clearBtn.textContent = "Clear All Props";
    clearBtn.onclick = () => sim.sendCommand({ type: "clear" });
    list.appendChild(clearBtn);
  }
  renderBrowserItems();
  document.body.appendChild(browser);

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
  for (const t of tools) {
    const btn = document.createElement("button");
    btn.className = "tool-btn";
    btn.textContent = t.label;
    btn.onclick = () => {
      weapons.setTool(t.type);
      useGameStore.getState().setActiveTool(t.type);
      toolBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    };
    toolbar.appendChild(btn);
    toolBtns.push(btn);
  }
  document.body.appendChild(toolbar);

  // Fun mode bar
  const funbar = document.createElement("div");
  funbar.className = "sandbox-funmode";
  const modes: Array<{mode: FunMode, label: string}> = [
    { mode: FunMode.Normal, label: "Normal" },
    { mode: FunMode.Moon, label: "Moon" },
    { mode: FunMode.ZeroG, label: "ZeroG" },
    { mode: FunMode.Bouncy, label: "Bouncy" },
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
  }

  // Expose toggle + updateToolBtns for external keydown handler
  (ctx as any)._domHud = {
    hud, browser, toolbar, funbar, palette,
    updateToolBtns,
    tools,
  };
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
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}
