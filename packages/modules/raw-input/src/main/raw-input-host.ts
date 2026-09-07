// ============================================================================
// RawInputHost — Main-process host for the native raw mouse capture addon
// ============================================================================
//
// Loads the napi-rs native addon (.node file), manages the capture lifecycle,
// and forwards raw mouse deltas to the renderer via IPC.
//
// The native addon is loaded lazily on first start() call. If the addon is not
// available (e.g. not built for this platform, or running outside Electron),
// the host reports platform "unsupported" and the renderer falls back to the
// real Pointer Lock API.

import { createLogger } from "@downdraft/core/util/logger";
import type { WebContents } from "electron";
import { existsSync } from "fs";
import { join } from "path";
import type { RawInputCaptureConfig, RawInputPlatform, RawInputStatus } from "../types";

const log = createLogger("info");

// --- Native addon interface (matches the napi-rs crate exports) ---
// The callback uses error-first style due to napi's CalleeHandled ErrorStrategy.
interface NativeAddon {
  detectPlatform(): RawInputPlatform;
  startCapture(
    windowHandle: Buffer,
    callback: (err: Error | null, dx: number, dy: number) => void,
  ): void;
  stopCapture(): void;
  setCursorVisible(visible: boolean): void;
  getStatus(): RawInputStatus;
}

/**
 * Load the native addon for the current platform.
 * napi-rs produces platform-specific .node files named like:
 *   index.linux-x64-gnu.node
 *   index.darwin-arm64.node
 *   index.win32-x64-msvc.node
 */
function loadNativeAddon(): NativeAddon | null {
  const platform = process.platform;
  const arch = process.arch;
  let filename: string;
  if (platform === "linux") {
    filename = `index.linux-${arch}-gnu.node`;
  } else if (platform === "darwin") {
    filename = `index.darwin-${arch}.node`;
  } else if (platform === "win32") {
    filename = `index.win32-${arch}-msvc.node`;
  } else {
    log.warn("raw-input", `Unsupported platform: ${platform}`);
    return null;
  }

  // The .node file location varies between dev and packaged builds:
  //  - Dev (Vite): main process is bundled into games/<game>/dist/main/,
  //    but the .node file is in the source tree at
  //    packages/modules/raw-input/native/.
  //  - Packaged: the .node file should be alongside the compiled JS or
  //    in the app's resources directory.
  const candidates = [
    // Next to compiled JS (packaged builds)
    join(__dirname, filename),
    // One/two/three levels up from dist (common layouts)
    join(__dirname, "../native", filename),
    join(__dirname, "../../native", filename),
    join(__dirname, "../../../native", filename),
    // Dev mode: __dirname is <repo>/dist/main/ — up 2 levels to repo root,
    // then into packages/modules/raw-input/native/
    join(__dirname, "../../packages/modules/raw-input/native", filename),
    // Dev mode: __dirname is <game>/dist/main/ — up 4 levels to repo root
    join(__dirname, "../../../../packages/modules/raw-input/native", filename),
    // Dev mode: process.cwd() is the repo root (CLI spawns with cwd: ROOT)
    join(process.cwd(), "packages/modules/raw-input/native", filename),
    // Dev mode: process.cwd() is the game directory
    join(process.cwd(), "../../packages/modules/raw-input/native", filename),
    // Packaged: node_modules
    join(process.cwd(), "node_modules/@downdraft/module-raw-input/native", filename),
  ];

  log.info("raw-input", `Looking for native addon: __dirname=${__dirname} cwd=${process.cwd()}`);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      // require() is needed for .node files — import() doesn't work for
      // native addons in all Electron versions.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const addon = require(candidate) as NativeAddon;
      log.info("raw-input", `Loaded native addon from ${candidate}`);
      return addon;
    } catch (e) {
      log.warn("raw-input", `Found ${candidate} but failed to load: ${e}`);
    }
  }

  log.warn("raw-input", `Native addon not found (${filename}) — tried ${candidates.length} paths, raw input disabled, falling back to browser pointer lock`);
  return null;
}

export class RawInputHost {
  private addon: NativeAddon | null = null;
  private webContents: WebContents | null = null;
  private capturing = false;
  private deltaBuffer: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly FLUSH_INTERVAL_MS = 2;

  /**
   * Set the target webContents to receive delta events.
   * Called once during app init (after window creation).
   */
  setTargetWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  /**
   * Lazily load the native addon. Returns the detected platform, or
   * "unsupported" if the addon is not available.
   */
  getPlatform(): RawInputPlatform {
    if (!this.addon) {
      this.addon = loadNativeAddon();
    }
    return this.addon?.detectPlatform() ?? "unsupported";
  }

  /**
   * Begin raw mouse capture for the given window.
   * Deltas are accumulated and flushed to the renderer via IPC at ~2ms intervals.
   */
  start(config: RawInputCaptureConfig): RawInputStatus {
    if (!this.addon) {
      this.addon = loadNativeAddon();
    }
    if (!this.addon) {
      return { platform: "unsupported", capturing: false, detail: "Native addon not loaded" };
    }
    if (this.capturing) {
      return this.addon.getStatus();
    }

    const hideCursor = config.hideCursor ?? true;
    const confineCursor = config.confineCursor ?? true;

    try {
      this.addon.startCapture(config.windowHandle, (err, dx, dy) => {
        if (err) {
          log.error("raw-input", `Native capture callback error: ${err}`);
          return;
        }
        this.deltaBuffer.dx += dx;
        this.deltaBuffer.dy += dy;
      });

      if (hideCursor) {
        this.addon.setCursorVisible(false);
      }

      this.capturing = true;

      // Start the delta flush timer — batches native callbacks into
      // periodic IPC sends to avoid flooding the renderer with one IPC
      // message per mouse event. Also monitors for unexpected capture
      // stops (e.g. window lost focus on the native side).
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushTimer = setInterval(() => {
        this.flushDeltas();
        this.checkCaptureStatus();
      }, this.FLUSH_INTERVAL_MS);

      log.info("raw-input", "Raw mouse capture started");
      return this.addon.getStatus();
    } catch (e) {
      log.error("raw-input", `Failed to start capture: ${e}`);
      return { platform: this.addon.detectPlatform(), capturing: false, detail: `Error: ${e}` };
    }
  }

  /**
   * Stop raw mouse capture and restore the cursor.
   */
  stop(): void {
    if (!this.addon || !this.capturing) return;

    try {
      this.addon.setCursorVisible(true);
      this.addon.stopCapture();
    } catch (e) {
      log.error("raw-input", `Failed to stop capture: ${e}`);
    }

    this.capturing = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush any remaining deltas.
    this.flushDeltas();
    log.info("raw-input", "Raw mouse capture stopped");
  }

  /**
   * Set the OS cursor visibility (used by the polyfill to hide/show the cursor).
   */
  setCursorVisible(visible: boolean): void {
    if (!this.addon) return;
    try {
      this.addon.setCursorVisible(visible);
    } catch (e) {
      log.error("raw-input", `Failed to set cursor visibility: ${e}`);
    }
  }

  /**
   * Get the current capture status from the native addon.
   */
  getStatus(): RawInputStatus {
    if (!this.addon) {
      return { platform: "unsupported", capturing: false, detail: "Native addon not loaded" };
    }
    return this.addon.getStatus();
  }

  /**
   * Flush accumulated deltas to the renderer via IPC.
   */
  private flushDeltas(): void {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    if (this.deltaBuffer.dx === 0 && this.deltaBuffer.dy === 0) return;
    const dx = this.deltaBuffer.dx;
    const dy = this.deltaBuffer.dy;
    this.deltaBuffer.dx = 0;
    this.deltaBuffer.dy = 0;
    this.webContents.send("raw-input:delta", dx, dy);
  }

  /**
   * Check if the native addon stopped capturing on its own (e.g. window
   * lost focus). If so, clean up host state and notify the renderer so the
   * polyfill can exit pointer lock.
   */
  private checkCaptureStatus(): void {
    if (!this.capturing || !this.addon) return;
    let nativeCapturing: boolean;
    try {
      nativeCapturing = this.addon.getStatus().capturing;
    } catch {
      return;
    }
    if (!nativeCapturing) {
      // Native side stopped on its own — clean up and notify renderer.
      this.capturing = false;
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushDeltas();
      log.info("raw-input", "Native capture stopped unexpectedly — notifying renderer");
      if (this.webContents && !this.webContents.isDestroyed()) {
        this.webContents.send("raw-input:stopped");
      }
    }
  }

  /**
   * Clean up — stop capture and dispose the addon.
   */
  destroy(): void {
    this.stop();
    this.addon = null;
    this.webContents = null;
  }
}
