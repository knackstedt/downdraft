// ============================================================================
// Renderer Plugin System — first-class renderer-thread plugin surface
//
// Distinct from the sim-thread `Plugin` (which registers ECS systems/resources
// against a World). Renderer plugins run on the renderer thread and own
// DOM/GPU/input/frame-hook concerns: camera controllers, gizmos, XR frame
// loops, offscreen render targets, etc.
//
// A plugin that spans both threads (e.g. XR) ships two objects: a sim `Plugin`
// for sim-side resources and a `RendererPlugin` for the renderer-side frame
// loop. See docs/site/src/content/docs/guides/plugins.md.
// ============================================================================

import type { CameraState } from "../render/camera";
import type {
    CameraViewportInfo,
    CancelRAF,
    OffscreenMode,
    RAFSource,
    RenderTargetProvider
} from "../render/game-renderer";
import type { RenderPipeline } from "../render/render-pipeline";

// ── Input bus ──

/**
 * Drag delta emitted by `RendererInputBus.onDrag` while a pointer button is
 * held. `buttons` mirrors `PointerEvent.buttons`. `shift` is the shift-key
 * state at event time (used by orbit controllers to switch rotate→pan).
 */
export interface DragDelta {
  dx: number;
  dy: number;
  buttons: number;
  shift: boolean;
}

/**
 * Per-dispatch control object passed to input bus handlers. Calling
 * `stopPropagation()` prevents lower-priority subscribers from receiving the
 * current event. Used by tools like the transform gizmo to capture a drag and
 * block the camera controller from also rotating.
 */
export interface InputEventControl {
  stopPropagation(): void;
  readonly propagationStopped: boolean;
}

export type PointerHandler = (e: PointerEvent, ctrl: InputEventControl) => void;
export type WheelHandler = (e: WheelEvent, ctrl: InputEventControl) => void;
export type KeyHandler = (e: KeyboardEvent, ctrl: InputEventControl) => void;
export type DragHandler = (d: DragDelta, ctrl: InputEventControl) => void;

/**
 * Host-owned DOM input surface. The `RendererPluginHost` owns the underlying
 * `addEventListener` calls on the canvas/window; plugins subscribe through
 * this bus instead of attaching their own listeners. Subscribers are
 * dispatched in priority order (lower number = earlier); a handler may call
 * `ctrl.stopPropagation()` to block later subscribers.
 *
 * Returns an unsubscribe function from each `on*` method.
 */
export interface RendererInputBus {
  onPointerDown(handler: PointerHandler, priority?: number): () => void;
  onPointerMove(handler: PointerHandler, priority?: number): () => void;
  onPointerUp(handler: PointerHandler, priority?: number): () => void;
  onWheel(handler: WheelHandler, priority?: number): () => void;
  onKeyDown(handler: KeyHandler, priority?: number): () => void;
  onKeyUp(handler: KeyHandler, priority?: number): () => void;
  /** Drag helper: emits `{dx,dy,buttons,shift}` deltas while a button is held. */
  onDrag(handler: DragHandler, priority?: number): () => void;
  /** Destroy the bus and remove all DOM listeners. */
  destroy(): void;
}

// ── Camera controller slot ──

/**
 * Contract for anything that can serve as the active camera provider for the
 * renderer. The `RendererPluginHost` holds at most one active controller at a
 * time; `GameRenderer` falls back to it when a viewport's `onViewport`
 * callback returns null.
 */
export interface CameraControllerLike {
  getCameraState(viewportIdx: number): CameraState;
  setAspect(w: number, h: number): void;
  frameBounds(min: [number, number, number], max: [number, number, number]): void;
}

// ── Render-pass hook ──

/**
 * Called inside each viewport's active `GPURenderPassEncoder` between the
 * RenderPipeline entries and pass end. Used by renderer plugins that need to
 * draw into the scene pass (e.g. the transform gizmo overlays geometry on top
 * of the scene).
 */
export type RenderPassHook = (
  passEncoder: GPURenderPassEncoder,
  camera: CameraState,
  viewportIdx: number,
) => void;

// ── Frame hooks ──

export type FramePhase =
  | "beforeFrame"
  | "beforeViewports"
  | "afterViewports"
  | "afterFrame";

export type FrameHook = (dt: number, elapsedTime: number) => void;
export type ResizeHook = (cssWidth: number, cssHeight: number, dpr: number) => void;

// ── Renderer plugin context ──

/**
 * Surface exposed to a `RendererPlugin` during `register()`. Each plugin
 * receives its own facade so hooks/dispose fns are tracked per-plugin and
 * cleaned up on `unloadPlugin`.
 */
export interface RendererPluginContext {
  /** Plugin name (set by the host during activation). */
  readonly name: string;

  // ── GPU / canvas ──
  getCanvas(): HTMLCanvasElement;
  getDevice(): GPUDevice;
  getFormat(): GPUTextureFormat;
  getPipeline(): RenderPipeline;

  // ── Input ──
  getInputBus(): RendererInputBus;

  // ── Frame / resize hooks ──
  onFrame(phase: FramePhase, fn: FrameHook): () => void;
  onResize(fn: ResizeHook): () => void;
  /** Hook into each viewport's active render pass. */
  onRenderPass(fn: RenderPassHook): () => void;

  // ── Camera controller slot ──
  setCameraController(controller: CameraControllerLike | null): void;
  getCameraController(): CameraControllerLike | null;

  /**
   * Install a viewport camera provider that takes priority over both the
   * game's `onViewport` callback and the camera controller. When set,
   * `GameRenderer` calls it first for each viewport; if it returns a
   * `CameraViewportInfo`, that camera is used. Used by XR to provide per-eye
   * stereo cameras that override the game's desktop camera.
   *
   * The provider receives the viewport index, frame dt, and elapsed time
   * (same signature as `FrameCallbacks.onViewport`).
   */
  setViewportCameraProvider(
    provider: ((viewportIdx: number, dt: number, elapsedTime: number) => CameraViewportInfo | null) | null,
  ): void;

  /**
   * Set the number of viewports. Used by XR to switch to stereo (2) on
   * enter and back to mono (1) on exit.
   */
  setViewportCount(count: number): void;

  // ── Offscreen / XR hooks (mirror GameRenderer setters) ──
  setOffscreenMode(mode: OffscreenMode | null): void;
  setRenderTargetProvider(provider: RenderTargetProvider | null): void;
  setRAFSource(src: RAFSource | null, cancel: CancelRAF | null): void;

  // ── Lifecycle ──
  onDispose(fn: () => void): void;
}

// ── Renderer plugin ──

/**
 * Renderer-thread plugin. Distinct from the sim-thread `Plugin` — a plugin
 * that needs both surfaces ships two objects (see XR).
 */
export interface RendererPlugin {
  name: string;
  version: string;
  /** Other renderer plugins that must be registered first. */
  dependencies?: string[];
  register(ctx: RendererPluginContext): void;
}
