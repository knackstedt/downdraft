// ============================================================================
// Renderer Module System — first-class renderer-thread plugin surface
//
// Distinct from the sim-thread `Module` (which registers ECS systems/resources
// against a World). Renderer plugins run on the renderer thread and own
// DOM/GPU/input/frame-hook concerns: camera controllers, gizmos, XR frame
// loops, offscreen render targets, etc.
//
// A plugin that spans both threads (e.g. XR) ships two objects: a sim `Module`
// for sim-side resources and a `RendererModule` for the renderer-side frame
// loop. See docs/site/src/content/docs/guides/plugins.md.
// ============================================================================

import type { ResourceToken } from "../ecs/resource";
import type { UIInputRouter } from "../input/ui-router";
import type { RenderSurface } from "../platform/render-surface";
import type { CameraState } from "../render/camera";
import type { FrameGraph, SlotRegistry } from "../render/frame-graph";
import type {
    CameraViewportInfo,
    CancelRAF,
    OffscreenMode,
    RAFSource,
    RenderTargetProvider
} from "../render/game-renderer";

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
 * Host-owned DOM input surface. The `RendererModuleHost` owns the underlying
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
 * renderer. The `RendererModuleHost` holds at most one active controller at a
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
 * FrameGraph passes and pass end. Used by renderer plugins that need to
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

/**
 * Draws UI textures into the surface pass during GameRenderer's end-of-frame
 * UI block (after afterFrame callbacks).
 * Registered by the html-ui module; kept in core so host and module share it.
 */
export interface ScreenUiCompositor {
  /** Draw into the open surface render pass. */
  render(pass: GPURenderPassEncoder, surfaceWidth: number, surfaceHeight: number): void;
  /** When false for all compositors, no UI pass is opened. */
  hasContent(): boolean;
  /** Draw order — higher renders later (on top). Default 0; the devtools
   *  dock uses a large value so it overlays fullscreen game UI panels. */
  order?: number;
}

// ── Renderer plugin context ──

/**
 * Surface exposed to a `RendererModule` during `register()`. Each plugin
 * receives its own facade so hooks/dispose fns are tracked per-plugin and
 * cleaned up on `unloadModule`.
 */
export interface RendererModuleContext {
  /** Module name (set by the host during activation). */
  readonly name: string;

  // ── GPU / surface ──
  /** The render surface this renderer draws into. Canonical accessor. */
  getSurface(): RenderSurface;
  /** @deprecated Use getSurface() — the surface is not necessarily a DOM canvas. */
  getCanvas(): RenderSurface;
  getDevice(): GPUDevice;
  getFormat(): GPUTextureFormat;
  getGraph(): FrameGraph;
  getSlotRegistry(): SlotRegistry;

  // ── Input ──
  getInputBus(): RendererInputBus;

  // ── UI input ──
  /**
   * The router that hit-tests and dispatches pointer/key events to the
   * active UI stack (html-ui installs its Blitz router here).
   */
  getUIInputRouter(): UIInputRouter | null;

  /**
   * Register a screen-space UI compositor drawn in GameRenderer's
   * end-of-frame UI pass. Returns an unregister function.
   */
  registerUiCompositor?(c: ScreenUiCompositor): () => void;

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

  // ── DevTools ──
  /**
   * DevTools registration surface. Renderer plugins self-register debug
   * panels, data feeds, and commands via `ctx.devtools.register*(...)`.
   * Same interface as the sim-thread ModuleContext.devtools.
   */
  readonly devtools: import("../module/module").ModuleDevToolsAPI;

  // ── Typed DI ──
  /**
   * Provide a typed resource to the renderer plugin graph. Other renderer
   * plugins can `inject()` it by the same token. In DOWNDRAFT_STRICT mode,
   * duplicate provides of the same token throw a DiagnosticError.
   */
  provide<T>(token: ResourceToken<T>, value: T): void;
  /**
   * Read a typed resource provided by another renderer plugin. Throws if
   * the token has no provider (use `injectOptional` for safe reads).
   */
  inject<T>(token: ResourceToken<T>): T;
  /**
   * Read a typed resource, returning `undefined` if no plugin provides it.
   */
  injectOptional<T>(token: ResourceToken<T>): T | undefined;

  // ── Lifecycle ──
  onDispose(fn: () => void): void;
}

// ── Renderer plugin ──

/**
 * Renderer-thread plugin. Distinct from the sim-thread `Module` — a plugin
 * that needs both surfaces ships two objects (see XR).
 */
export interface RendererModule {
  name: string;
  version: string;
  /** Other renderer plugins that must be registered first. */
  dependencies?: string[];
  /** Typed tokens this plugin provides to the graph. Validated at activation. */
  provides?: ResourceToken<unknown>[];
  /** Typed tokens this plugin requires from the graph. Validated at activation. */
  requires?: ResourceToken<unknown>[];
  register(ctx: RendererModuleContext): void;
}
