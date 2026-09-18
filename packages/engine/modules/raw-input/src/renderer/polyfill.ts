// ============================================================================
// Pointer Lock Polyfill — DOM API override backed by native raw mouse capture
// ============================================================================
//
// This module replaces the browser's Pointer Lock API with a native-backed
// implementation that bypasses Chrome's ESC-exits-pointer-lock behavior and
// ~1.2s re-lock cooldown. It is a no-op when the native bridge is not
// available (browser/web dev mode), so the real Pointer Lock API is used as
// a fallback.
//
// Import this module for its side effect BEFORE any code that calls
// requestPointerLock / reads movementX/movementY:
//
//   import "@downdraft/engine/modules/raw-input/polyfill";
//
// The polyfill:
//   1. Overrides Element.prototype.requestPointerLock + Document.prototype.exitPointerLock
//      + Document.prototype.pointerLockElement (getter).
//   2. On requestPointerLock: sets a fake locked element, hides the cursor,
//     calls downdraft.rawInput.start() (IPC → native addon begins raw capture).
//   3. On exitPointerLock: restores cursor, clears fake locked element,
//     calls downdraft.rawInput.stop().
//   4. On each raw delta from the native addon (via downdraft.rawInput.onDelta):
//     accumulates dx/dy, then dispatches a synthetic MouseEvent("mousemove")
//     with movementX/movementY on the locked element via requestAnimationFrame.
//
// movementX/movementY are writable via the MouseEventInit constructor dict
// even though they're normally computed internally by Blink — this is the
// same trick older pointer-lock polyfills used for pre-standardization browsers.

// --- Bridge shape (subset of DowndraftRawInputBridgeAPI) ---
// We avoid importing the full bridge type to keep this module dependency-free.
interface RawInputBridge {
  start(): void;
  stop(): void;
  onDelta(cb: (dx: number, dy: number) => void): void;
  onStopped(cb: () => void): void;
  setCursorVisible(visible: boolean): void;
}

interface DowndraftGlobalWithRawInput {
  downdraft?: {
    rawInput?: RawInputBridge;
  };
}

let installed = false;
let fakeLockedElement: Element | null = null;
let pendingDx = 0;
let pendingDy = 0;
let rafId: number | null = null;

// Saved originals for uninstall / browser fallback.
let origRequestPointerLock: typeof Element.prototype.requestPointerLock | null = null;
let origExitPointerLock: typeof Document.prototype.exitPointerLock | null = null;
let origPointerLockElementDescriptor: PropertyDescriptor | null = null;

/**
 * Returns true if the native raw input bridge is available (Electron + feature
 * enabled + native addon loaded). When false, the polyfill is a no-op and the
 * real Pointer Lock API is used.
 */
function isRawInputAvailable(): boolean {
  const g = globalThis as unknown as DowndraftGlobalWithRawInput;
  return !!g.downdraft?.rawInput;
}

function getRawInputBridge(): RawInputBridge {
  const g = globalThis as unknown as DowndraftGlobalWithRawInput;
  return g.downdraft!.rawInput!;
}

/**
 * Dispatch accumulated mouse deltas as a synthetic mousemove event on the
 * locked element. Runs once per animation frame to batch multiple native
 * deltas into a single DOM event (matching how Chrome batches pointer-lock
 * movement events to the frame rate).
 */
function flushDeltas(): void {
  rafId = null;
  if (!fakeLockedElement) return;
  if (pendingDx === 0 && pendingDy === 0) return;
  const dx = pendingDx;
  const dy = pendingDy;
  pendingDx = 0;
  pendingDy = 0;
  // MouseEventInit accepts movementX/movementY even though they're read-only
  // on the resulting MouseEvent instance. This is the polyfill trick.
  const event = new MouseEvent("mousemove", {
    movementX: dx,
    movementY: dy,
    bubbles: true,
    cancelable: true,
  });
  fakeLockedElement.dispatchEvent(event);
}

function scheduleFlush(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(flushDeltas);
}

// --- Polyfill implementations ---

function polyfillRequestPointerLock(this: Element): Promise<void> | void {
  if (fakeLockedElement === this) return;
  fakeLockedElement = this;
  (this as HTMLElement).style.cursor = "none";
  try {
    getRawInputBridge().start();
  } catch (e) {
    console.error("[raw-input] Failed to start native capture:", e);
  }
  // Dispatch pointerlockchange so existing listeners (InputManager,
  // RendererInputHandler) update their pointerLocked state.
  document.dispatchEvent(new Event("pointerlockchange"));
  // The real API returns undefined (legacy) or Promise<void> (newer Chrome).
  // Return undefined — callers that expect a Promise use .catch guards that
  // handle undefined (see RendererInputHandler.tryLockPointer).
  return undefined;
}

function polyfillExitPointerLock(this: Document): void {
  if (fakeLockedElement) {
    (fakeLockedElement as HTMLElement).style.cursor = "";
  }
  fakeLockedElement = null;
  pendingDx = 0;
  pendingDy = 0;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  try {
    getRawInputBridge().stop();
  } catch (e) {
    console.error("[raw-input] Failed to stop native capture:", e);
  }
  document.dispatchEvent(new Event("pointerlockchange"));
}

/**
 * Install the pointer lock polyfill. Safe to call multiple times — subsequent
 * calls are no-ops. Automatically no-ops if the native bridge is not available
 * (browser/web dev mode), leaving the real Pointer Lock API intact.
 */
export function installPointerLockPolyfill(): void {
  if (installed) return;
  if (!isRawInputAvailable()) {
    // Browser fallback — real Pointer Lock API is used.
    return;
  }
  installed = true;

  // Save originals.
  origRequestPointerLock = Element.prototype.requestPointerLock;
  origExitPointerLock = Document.prototype.exitPointerLock;
  origPointerLockElementDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "pointerLockElement",
  ) ?? null;

  // Override requestPointerLock on Element.prototype.
  // Use defineProperty to replace the native method (which is non-writable).
  Object.defineProperty(Element.prototype, "requestPointerLock", {
    value: polyfillRequestPointerLock,
    writable: true,
    configurable: true,
  });

  // Override exitPointerLock on Document.prototype.
  Object.defineProperty(Document.prototype, "exitPointerLock", {
    value: polyfillExitPointerLock,
    writable: true,
    configurable: true,
  });

  // Override pointerLockElement getter on Document.prototype.
  Object.defineProperty(Document.prototype, "pointerLockElement", {
    get() {
      return fakeLockedElement;
    },
    configurable: true,
  });

  // Wire up the delta callback from the native bridge.
  getRawInputBridge().onDelta((dx, dy) => {
    if (!fakeLockedElement) return;
    pendingDx += dx;
    pendingDy += dy;
    scheduleFlush();
  });

  // Native side detected focus loss and stopped capture on its own.
  // Exit pointer lock so the game's pointerlockchange listeners update
  // state. This is the primary mechanism — window.blur is a fallback.
  getRawInputBridge().onStopped(() => {
    if (fakeLockedElement) {
      // Don't call the bridge's stop() — the native side already stopped.
      // Just clean up the DOM state.
      (fakeLockedElement as HTMLElement).style.cursor = "";
      fakeLockedElement = null;
      pendingDx = 0;
      pendingDy = 0;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.dispatchEvent(new Event("pointerlockchange"));
    }
  });

  // Release capture on window blur (fallback — the native side's focus
  // detection is the primary mechanism).
  window.addEventListener("blur", () => {
    if (fakeLockedElement) {
      document.exitPointerLock();
    }
  });
}

/**
 * Uninstall the polyfill and restore the original Pointer Lock API.
 */
export function uninstallPointerLockPolyfill(): void {
  if (!installed) return;
  installed = false;

  // Stop any active capture.
  if (fakeLockedElement) {
    (fakeLockedElement as HTMLElement).style.cursor = "";
    fakeLockedElement = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingDx = 0;
  pendingDy = 0;

  // Restore originals.
  if (origRequestPointerLock) {
    Object.defineProperty(Element.prototype, "requestPointerLock", {
      value: origRequestPointerLock,
      writable: true,
      configurable: true,
    });
    origRequestPointerLock = null;
  }
  if (origExitPointerLock) {
    Object.defineProperty(Document.prototype, "exitPointerLock", {
      value: origExitPointerLock,
      writable: true,
      configurable: true,
    });
    origExitPointerLock = null;
  }
  if (origPointerLockElementDescriptor) {
    Object.defineProperty(Document.prototype, "pointerLockElement", origPointerLockElementDescriptor);
    origPointerLockElementDescriptor = null;
  }
}

// ── Auto-install on side-effect import ──
//
// `import "@downdraft/engine/modules/raw-input/polyfill"` triggers this call.
// It's a no-op if the native bridge isn't available (browser/web dev mode),
// so importing the polyfill is always safe — it only activates in Electron
// when features.rawInput is enabled.
//
// With contextIsolation: true, the preload's contextBridge.exposeInMainWorld()
// runs before the renderer's main world scripts, so window.downdraft should
// be available at import time. If for some reason it isn't yet (race
// condition), we retry once on the next microtask.
installPointerLockPolyfill();
if (!installed) {
  // Bridge wasn't available at import time — retry after the current
  // module evaluation completes, in case the preload is still setting up.
  Promise.resolve().then(() => installPointerLockPolyfill());
}
