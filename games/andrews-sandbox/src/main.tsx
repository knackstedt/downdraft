// ============================================================================
// Andrew's Sandbox — Renderer Entry Point
// Declarative GameModule + startGame() bootstrap.
// ============================================================================

import { ContentRegistry, DragDropImporter, PluginScanner } from "@andrews-sandbox/library-content";
import { BUILTIN_PROPS } from "@andrews-sandbox/library-props";
import { PaintSystem } from "@andrews-sandbox/module-paint";
import { PhysicsPropsController } from "@andrews-sandbox/module-physics-props";
import { SandboxVRModule } from "@andrews-sandbox/module-vr";
import { WeaponController } from "@andrews-sandbox/module-weapons";
import { downdraft, startGame, type SimWorkerSeed } from "@downdraft/app/renderer";
import { ENGINE_VERSION, ENT, SimBufferReader } from "@downdraft/core";
import { PixiUiHost } from "@downdraft/library-pixi-ui";
import { EntityType, FunMode, ToolType, ToolgunContext } from "@sandbox/shared/types";
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

// Player state shared between the sim event handler and the renderer move loop.
// The sim worker owns the authoritative position (Rapier character controller);
// the renderer reads it to position the camera.
// Player feet start at y=PLAYER_HEIGHT (matches sim worker's initial playerPos).
const PLAYER_HEIGHT = 1.8;
const playerState = { pos: [0, PLAYER_HEIGHT, 0] as [number, number, number], grounded: false };

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
          // entityId = slotIdx + 1, so slotIdx = entityId - 1
          const slotIdx = data.entityId - 1;
          const reader = new SimBufferReader(ctx.simSAB!);
          const slot = reader.getEntitySlot(slotIdx);
          slot.u32[ENT.ID] = nodeIdNum;
        }
      }

      // Reseed the interpolation buffer so the prop doesn't interpolate from
      // a stale prev position (avoids a visual snap on spawn).
      renderer.onPropSpawned(data.entityId);

      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);
    },
    prop_removed: (data, ctx) => {
      const renderer = ctx.renderer as WebGPURenderer;
      renderer.onPropRemoved(data.entityId);
      const propCount = countProps(ctx.simSAB!);
      useGameStore.getState().setPropCount(propCount);
    },
    fun_mode_changed: (data) => {
      useGameStore.getState().setActiveFunMode(data.mode);
    },
    paint_updated: (_data) => { /* Phase 5 */ },
    player_moved: (data) => {
      playerState.pos[0] = data.position[0];
      playerState.pos[1] = data.position[1];
      playerState.pos[2] = data.position[2];
      playerState.grounded = data.grounded;
    },
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
    // Hide the PixiUI overlay canvas entirely — we use the DOM HUD instead.
    const overlay = pixiHost.overlayCanvas;
    if (overlay) {
      overlay.style.pointerEvents = "none";
      overlay.style.display = "none";
    }
    // Build DOM HUD (replaces PixiUI which has a broken worker)
    buildDomHud(ctx, contentRegistry, weaponController, physicsController, paintSystem, sim);

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
          const shape = entry?.shape ?? (a.contentId.includes("sphere") || a.contentId.includes("ball") ? "sphere" : "box");
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
      // Stats now handled by DOM HUD — no PixiUI stats needed
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

    // Track pointer lock state — when pointer lock is lost unexpectedly
    // (i.e. the browser intercepted ESC, which doesn't deliver a keydown),
    // auto-open the ESC menu.
    let intentionalUnlock = false;
    document.addEventListener("pointerlockchange", () => {
      pointerLocked = document.pointerLockElement === canvas;
      console.log(`[Input] Pointer lock: ${pointerLocked ? "active" : "released"}`);
      if (!pointerLocked && !intentionalUnlock && !useGameStore.getState().showEscMenu) {
        // Browser consumed ESC to exit pointer lock — open the menu
        useGameStore.getState().setShowEscMenu(true);
        sim.pause();
      }
      intentionalUnlock = false;
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
      // ESC menu — takes priority over everything else
      if (e.code === "Escape") {
        e.preventDefault();
        const cur = useGameStore.getState();
        if (cur.showEscMenu) {
          // Close menu, resume, and re-acquire pointer lock
          useGameStore.getState().setShowEscMenu(false);
          sim.resume();
          canvas.requestPointerLock();
        } else {
          // Open menu and pause
          if (document.pointerLockElement) { intentionalUnlock = true; document.exitPointerLock(); }
          useGameStore.getState().setShowEscMenu(true);
          sim.pause();
        }
        return;
      }
      // Block game input while ESC menu is open
      if (useGameStore.getState().showEscMenu) return;

      keys.add(e.code);
      const s = useGameStore.getState();
      switch (e.code) {
        case "KeyB": toggleDomPanel(ctx, "browser"); if (document.pointerLockElement) { intentionalUnlock = true; document.exitPointerLock(); } break;
        case "KeyP": toggleDomPanel(ctx, "palette"); if (document.pointerLockElement) { intentionalUnlock = true; document.exitPointerLock(); } break;
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

    // Game loop — weapon tick + WASD movement via Rapier character controller
    const EYE_HEIGHT = 1.62; // eye height above feet (player is 1.8m tall)
    const GRAVITY = 20.0;
    const JUMP_VELOCITY = 8.0;
    const MOVE_SPEED = 8.0;
    let vy = 0;
    let lastWeaponTick = performance.now();
    const moveLoop = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - lastWeaponTick) / 1000, 0.05);
      lastWeaponTick = now;
      // Skip game logic while ESC menu is open
      if (useGameStore.getState().showEscMenu) return;
      weaponController.tick(dt);
      paintSystem?.tick();
      vrModule?.tick(dt);
      const r = renderer as WebGPURenderer;
      const fwd = getMoveForward(yaw);
      const right = getRightVector(yaw);
      // Compute desired horizontal movement (WASD) — uses yaw-only forward
      // so looking up/down doesn't reduce horizontal speed.
      let dx = 0, dz = 0;
      if (keys.has("KeyW")) { dx += fwd[0] * MOVE_SPEED * dt; dz += fwd[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyS")) { dx -= fwd[0] * MOVE_SPEED * dt; dz -= fwd[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyA")) { dx -= right[0] * MOVE_SPEED * dt; dz -= right[2] * MOVE_SPEED * dt; }
      if (keys.has("KeyD")) { dx += right[0] * MOVE_SPEED * dt; dz += right[2] * MOVE_SPEED * dt; }
      // Reset vertical velocity when grounded (prevents unbounded gravity
      // accumulation that causes the character controller to receive huge
      // downward deltas, leading to ground clipping and sideways jitter).
      if (playerState.grounded) {
        vy = 0;
      }
      // Jump
      if (keys.has("Space") && playerState.grounded) {
        vy = JUMP_VELOCITY;
      }
      // Crouch / descend
      if (keys.has("ShiftLeft")) {
        vy = -MOVE_SPEED;
      }
      // Apply gravity
      vy -= GRAVITY * dt;
      // Send desired movement delta to the sim worker (Rapier character controller)
      sim.sendCommand({ type: "movePlayer", desiredDelta: [dx, vy * dt, dz] });
      // Update camera to player's eye position
      r.setCameraPosition([playerState.pos[0], playerState.pos[1] + EYE_HEIGHT, playerState.pos[2]]);
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
      };
      list.appendChild(row);
    }
    const clearBtn = document.createElement("button");
    clearBtn.className = "clear-btn";
    clearBtn.textContent = "Clear All Props";
    clearBtn.onclick = () => sim.sendCommand({ type: "clear" });
    list.appendChild(clearBtn);

    // Spawn 10 cubes at once, scattered in front of the camera
    const spawn10Btn = document.createElement("button");
    spawn10Btn.className = "clear-btn";
    spawn10Btn.textContent = "Spawn 10 Cubes";
    spawn10Btn.onclick = () => {
      const cam = (ctx.renderer as WebGPURenderer).getCameraPosition();
      const target = (ctx.renderer as WebGPURenderer).getCameraTarget();
      const dx = target[0] - cam[0], dy = target[1] - cam[1], dz = target[2] - cam[2];
      const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      const fx = dx / dl, fy = dy / dl, fz = dz / dl;
      const entry = registry.get("builtin:cube");
      for (let i = 0; i < 10; i++) {
        // Spread cubes in a rough grid perpendicular to the view direction
        const spread = 2.5;
        const offX = (i % 5 - 2) * spread;
        const offY = Math.floor(i / 5) * spread;
        // Right vector relative to forward (in XZ plane)
        const rx = fz, rz = -fx;
        sim.sendCommand({
          type: "spawn",
          contentId: "builtin:cube",
          position: [
            cam[0] + fx * 6 + rx * offX,
            cam[1] + fy * 6 + 2 + offY,
            cam[2] + fz * 6 + rz * offX,
          ],
          physics: entry?.physics,
          shape: entry?.shape ?? "box",
          scale: entry?.scale ?? 1.0,
        });
      }
      weapons.getToolgun().setSelectedContent("builtin:cube");
    };
    list.appendChild(spawn10Btn);
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

  type EscTab = "main" | "graphics" | "content" | "controls";
  const escTabs: Array<{ id: EscTab; label: string }> = [
    { id: "main", label: "Menu" },
    { id: "graphics", label: "Graphics" },
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
      updateEscTab();
    };
    escSidebar.appendChild(btn);
    escTabBtns.push(btn);
  }
  escMenu.appendChild(escSidebar);

  // Content area (panels swap based on active tab)
  const escContent = document.createElement("div");
  escContent.className = "sandbox-esc-content";
  escMenu.appendChild(escContent);

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
          action: () => { sim.save("autosave"); flashStatus("Game saved"); },
        },
        {
          label: "Load Game",
          desc: "Load from autosave slot",
          action: () => { sim.load("autosave"); flashStatus("Game loaded"); },
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
        ["Space", "Jump"],
        ["Shift", "Descend / crouch"],
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
        ["ESC", "Open / close this menu"],
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
  }

  // Status flash (transient toast inside the menu)
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

  // Graphics apply helpers — delegate to the existing action handler
  function applyGraphicsToggle(key: string) {
    const r = ctx.renderer as WebGPURenderer;
    const s = useGameStore.getState();
    switch (key) {
      case "bloom": s.setBloomEnabled(!s.bloomEnabled); (r as any).setBloom?.(!s.bloomEnabled); break;
      case "fxaa": s.setFXAAEnabled(!s.fxaaEnabled); (r as any).setFXAA?.(!s.fxaaEnabled); break;
      case "tonemap": s.setTonemapEnabled(!s.tonemapEnabled); (r as any).setTonemap?.(!s.tonemapEnabled); break;
      case "vignette": s.setVignetteEnabled(!s.vignetteEnabled); (r as any).setVignette?.(!s.vignetteEnabled); break;
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
    // Re-acquire pointer lock so the player can resume without clicking
    const canvas = ctx.canvas as HTMLCanvasElement;
    canvas.requestPointerLock();
  }

  // Subscribe to store to show/hide the menu
  useGameStore.subscribe((state) => {
    escMenu.style.display = state.showEscMenu ? "flex" : "none";
    if (state.showEscMenu) updateEscTab();
  });

  document.body.appendChild(escMenu);

  // Expose toggle + updateToolBtns for external keydown handler
  (ctx as any)._domHud = {
    hud, browser, toolbar, funbar, palette,
    escMenu,
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

// Horizontal forward vector (yaw only, no pitch) — used for WASD movement
// so looking up/down doesn't reduce horizontal speed.
function getMoveForward(yaw: number): [number, number, number] {
  return [Math.sin(yaw), 0, -Math.cos(yaw)];
}

function getRightVector(yaw: number): [number, number, number] {
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}
