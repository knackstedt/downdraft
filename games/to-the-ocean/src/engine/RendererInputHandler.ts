// ============================================================================
// RendererInputHandler — input processing, pointer lock, mouse state, builder wheel
// Extracted from WebGPURenderer for modularity
// ============================================================================

import type { UIInputRouter } from "@downdraft/core";
import { InputBufferWriter, KEY } from "@shared/input-buffer";
import { PLR, PLR_FLAG, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode } from "@shared/types";
import { useGameStore } from "../stores/gameStore";
import type { CameraSystem } from "./CameraSystem";

export class RendererInputHandler {
  private canvas: HTMLCanvasElement;
  private inputWriter: InputBufferWriter | null = null;
  private simReader: SimBufferReader | null = null;
  private cameraSystem: CameraSystem | null = null;
  private uiInputRouter: UIInputRouter | null = null;

  keysDown = new Set<number>();
  mouseState = { x: 0, y: 0, left: false, right: false, wheel: 0, _wheel: 0 };
  mouseDelta = { dx: 0, dy: 0 };
  pointerLocked = false;
  prevCameraMode: CameraMode = CameraMode.FirstPerson;
  private pointerLockRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerLockRetryCount = 0;
  private lastBuilderWheelTime = 0;

  onInputProcessed: (() => void) | null = null;
  onOSRKey: ((type: "keyDown" | "keyUp", keyCode: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setBuffers(inputWriter: InputBufferWriter, simReader: SimBufferReader): void {
    this.inputWriter = inputWriter;
    this.simReader = simReader;
  }

  setCameraSystem(cameraSystem: CameraSystem): void {
    this.cameraSystem = cameraSystem;
  }

  setUIInputRouter(uiInputRouter: UIInputRouter): void {
    this.uiInputRouter = uiInputRouter;
  }

  processInput(viewportCount: number): void {
    if (!this.inputWriter) return;

    // Keyboard
    const keysDown = this.getKeysDown();
    for (let p = 0; p < viewportCount; p++) {
      // Reset all keys for this player
      for (let k = 0; k < 256; k++) {
        this.inputWriter.setKey(p, k, false);
      }
      // Set pressed keys
      for (let j = 0; j < keysDown.length; j++) {
        this.inputWriter.setKey(p, keysDown[j], true);
      }
    }

    // Mouse
    const mouse = this.getMouseState();
    const md = this.mouseDelta;
    for (let p = 0; p < viewportCount; p++) {
      this.inputWriter.setMousePos(p, mouse.x, mouse.y);
      this.inputWriter.setMouseButton(p, 0, mouse.left);
      this.inputWriter.setMouseButton(p, 2, mouse.right);
      this.inputWriter.setWheel(p, mouse._wheel);
      this.inputWriter.setMouseDelta(p, md.dx, md.dy);
    }
    this.mouseDelta.dx = 0;
    this.mouseDelta.dy = 0;

    // Write current third-person zoom distance to input buffer
    if (this.cameraSystem) {
      const zoom = this.cameraSystem.getThirdPersonDistance();
      const lookHeading = this.cameraSystem.getLookHeading();
      const lookPitch = this.cameraSystem.getLookPitch();
      for (let p = 0; p < viewportCount; p++) {
        this.inputWriter.setCameraZoom(p, zoom);
        this.inputWriter.setLookHeading(p, lookHeading);
        this.inputWriter.setLookPitch(p, lookPitch);
      }
    }

    // Write builder cell type and rotation from gameStore
    const gs = useGameStore.getState();
    const builderCellType = gs.builderCellType;
    const builderRotation = gs.builderRotation;
    for (let p = 0; p < viewportCount; p++) {
      this.inputWriter.setBuilderCellType(p, builderCellType);
      this.inputWriter.setBuilderRotation(p, builderRotation);
    }

    this.inputWriter.setPlayerCount(viewportCount);
    this.inputWriter.incrementSequence();
  }

  lockPointer(): void {
    if (this.pointerLocked) return;
    this.pointerLockRetryCount = 0;
    this.tryLockPointer();
  }

  private tryLockPointer(): void {
    if (this.pointerLocked) return;
    if (this.pointerLockRetryCount >= 20) return;
    this.pointerLockRetryCount++;
    try {
      this.canvas.requestPointerLock();
    } catch (_e) {
      // ignore — fallback timer below will retry
    }
    // Always schedule a check: if pointerlockchange doesn't fire within
    // 300ms (silent failure during ESC cooldown), retry.
    if (this.pointerLockRetryTimer) clearTimeout(this.pointerLockRetryTimer);
    this.pointerLockRetryTimer = setTimeout(() => {
      this.pointerLockRetryTimer = null;
      if (!this.pointerLocked) this.tryLockPointer();
    }, 300);
  }

  private schedulePointerLockRetry(): void {
    if (this.pointerLockRetryTimer) clearTimeout(this.pointerLockRetryTimer);
    if (this.pointerLockRetryCount >= 10) return;
    this.pointerLockRetryCount++;
    this.pointerLockRetryTimer = setTimeout(() => this.tryLockPointer(), 200);
  }

  private getKeysDown(): number[] {
    return Array.from(this.keysDown);
  }

  private getMouseState() {
    const wheel = this.mouseState.wheel;
    this.mouseState.wheel = 0; // reset after read
    this.mouseState._wheel = wheel; // store non-reset wheel for caller
    return this.mouseState;
  }

  private tryOpenBuilderWheel(): void {
    // Debounce: mousedown and contextmenu can both fire for the same right-click
    const now = performance.now();
    if (now - this.lastBuilderWheelTime < 200) return;
    this.lastBuilderWheelTime = now;

    const gs = useGameStore.getState();
    if (gs.showBuilderWheel) return;
    if (!this.simReader?.isValid()) return;
    const slot = this.simReader.getPlayerSlot(0);
    if (!slot) return;
    const activeSlot = slot.u32[PLR.ACTIVE_SLOT] ?? 0;
    const flags = slot.u32[PLR.FLAGS];
    if (activeSlot !== 0 || (flags & PLR_FLAG.ONBOARD) === 0) return;
    // Don't open if any other overlay is open
    const anyOverlay = gs.showSettings || gs.showPauseMenu || gs.showInventory ||
      gs.showMap || gs.showBuildMenu || gs.showCraftMenu || gs.showFishingMinigame ||
      gs.showTradeMenu || gs.showCharacterCustomization;
    if (anyOverlay) return;
    gs.setSuppressPauseMenu(true);
    gs.setShowBuilderWheel(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private tryBuilderRotate(direction: number): void {
    if (!this.simReader?.isValid()) return;
    const slot = this.simReader.getPlayerSlot(0);
    if (!slot) return;
    const activeSlot = slot.u32[PLR.ACTIVE_SLOT] ?? 0;
    const flags = slot.u32[PLR.FLAGS];
    if (activeSlot !== 0 || (flags & PLR_FLAG.ONBOARD) === 0) return;
    const gs = useGameStore.getState();
    const anyOverlay = gs.showSettings || gs.showPauseMenu || gs.showInventory ||
      gs.showMap || gs.showBuildMenu || gs.showCraftMenu || gs.showFishingMinigame ||
      gs.showTradeMenu || gs.showCharacterCustomization ||
      gs.showBuilderWheel;
    if (anyOverlay) return;
    gs.setBuilderRotation(gs.builderRotation + direction);
  }

  setupInputListeners(): void {
    window.addEventListener("keydown", (e) => {
      this.keysDown.add(e.keyCode);
      this.uiInputRouter?.handleKeyDown(e.keyCode);
      this.onOSRKey?.("keyDown", e.keyCode);
      // Builder rotation: R or ] = rotate CW, [ = rotate CCW (only when builder tool active)
      if (!e.repeat && (e.keyCode === KEY.R || e.keyCode === KEY.BRACKET_LEFT || e.keyCode === KEY.BRACKET_RIGHT)) {
        this.tryBuilderRotate(e.keyCode === KEY.BRACKET_LEFT ? -1 : 1);
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.keyCode);
      this.uiInputRouter?.handleKeyUp(e.keyCode);
      this.onOSRKey?.("keyUp", e.keyCode);
    });
    this.canvas.addEventListener("click", () => {
      if (!this.pointerLocked) {
        this.pointerLockRetryCount = 0;
        this.tryLockPointer();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      const wasLocked = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      console.log(`[PointerLock] change: locked=${this.pointerLocked} wasLocked=${wasLocked} element=${document.pointerLockElement?.tagName ?? 'null'}`);
      if (this.pointerLocked) {
        this.pointerLockRetryCount = 0;
        if (this.pointerLockRetryTimer) {
          clearTimeout(this.pointerLockRetryTimer);
          this.pointerLockRetryTimer = null;
        }
      } else if (wasLocked) {
        this.keysDown.clear();
        this.mouseState.left = false;
        this.mouseState.right = false;
        this.mouseDelta.dx = 0;
        this.mouseDelta.dy = 0;
      }
    });
    document.addEventListener("pointerlockerror", () => {
      // No action needed — tryLockPointer's fallback timer will retry.
    });
    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.mouseState.left = false;
      this.mouseState.right = false;
      this.mouseDelta.dx = 0;
      this.mouseDelta.dy = 0;
    });
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseState.x = e.clientX - rect.left;
      this.mouseState.y = e.clientY - rect.top;
      this.uiInputRouter?.handleMouseMove(e.clientX, e.clientY);
      if (this.pointerLocked) {
        this.mouseDelta.dx += e.movementX;
        this.mouseDelta.dy += e.movementY;
      }
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        this.mouseState.left = true;
        this.uiInputRouter?.handleMouseDown(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.mouseState.right = true;
        this.tryOpenBuilderWheel();
      }
    });
    this.canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) {
        this.mouseState.left = false;
        this.uiInputRouter?.handleMouseUp(e.clientX, e.clientY);
      }
      if (e.button === 2) this.mouseState.right = false;
    });
    this.canvas.addEventListener("wheel", (e) => {
      this.mouseState.wheel += e.deltaY;
    });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.tryOpenBuilderWheel();
    });
  }

  destroy(): void {
    if (this.pointerLockRetryTimer) {
      clearTimeout(this.pointerLockRetryTimer);
      this.pointerLockRetryTimer = null;
    }
  }
}
