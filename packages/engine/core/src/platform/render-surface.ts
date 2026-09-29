// ============================================================================
// RenderSurface — the engine's renderer-facing surface contract
//
// A RenderSurface is the thing a game renderer draws into: a WebGPU
// presentation target with a size, a resize event, and an input event
// target. It is intentionally NOT a DOM type — on the native host it is
// backed by an SDL window + wgpu surface (`NativeSurface`), on a DOM host
// it is the HTMLCanvasElement itself (which satisfies this interface
// structurally).
//
// Canvas-era APIs that are NOT part of this contract (2d contexts, toBlob,
// style, focus/blur, DOM tree traversal) live behind the PixiJS/DOM compat
// layer — engine code must never require them.
// ============================================================================

/**
 * The WebGPU context for a RenderSurface. Structurally matches the slice of
 * GPUCanvasContext the engine uses — both the real DOM GPUCanvasContext and
 * the native NativeCanvasContext satisfy it. (GPUCanvasContext itself is a
 * branded type that cannot be `implements`-ed, so this minimal shape is the
 * engine's own contract.)
 */
export interface RenderSurfaceContext {
  /** Configure the surface for presentation from a device. */
  configure(config: GPUCanvasConfiguration): void;
  /** Release the surface configuration. */
  unconfigure(): void;
  /** Acquire the next frame's texture for rendering. Can return null when
   *  the swapchain can't produce a frame (resize in flight, occluded
   *  window) — callers must treat null as "skip this frame". */
  getCurrentTexture(): GPUTexture | null;
}

/** Listener signature — the native event target dispatches plain event
 *  objects; DOM hosts dispatch real Events. Keep the parameter `any` so
 *  both event shapes flow through without casts. */
export type RenderSurfaceListener = (event: any) => void;

/**
 * The renderer-facing surface: size + WebGPU context + event target.
 *
 * `width`/`height` are the backing (pixel) size and are assignable —
 * `surface.width = w` resizes the backing store, matching canvas
 * semantics. `clientWidth`/`clientHeight` are the CSS-space size (equal to
 * the backing size on native; DPR-scaled on DOM hosts).
 *
 * Events: `"resize"` fires when the host resizes the surface; input events
 * (pointer/mouse/wheel/keyboard) are dispatched here on native and by the
 * DOM on browser hosts.
 */
export interface RenderSurface {
  /** Backing pixel width. Assignable — resizes the surface. */
  width: number;
  /** Backing pixel height. Assignable — resizes the surface. */
  height: number;
  /** CSS-space width (== width on native). */
  readonly clientWidth: number;
  /** CSS-space height (== height on native). */
  readonly clientHeight: number;
  /** Element-space bounding box for pointer coordinate mapping. */
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** Acquire a rendering context. Only "webgpu" is part of the contract —
   *  other context ids return null (2d lives in the compat layer). */
  getContext(contextId: "webgpu"): RenderSurfaceContext | null;
  getContext(contextId: string): unknown;
  /** Input + "resize" event target. */
  addEventListener(type: string, listener: RenderSurfaceListener, options?: unknown): void;
  removeEventListener(type: string, listener: RenderSurfaceListener, options?: unknown): void;
  /** Dispatch an event — `Event` on DOM hosts, a plain `{ type, ...fields }`
   *  object on native. Typed `any` because the two event shapes share no
   *  common supertype and both flow through the same listeners. */
  dispatchEvent(event: any): boolean;
  /** Pointer lock (pointer-lock games). Optional — absent where the
   *  concept doesn't exist; presence is the feature check. */
  requestPointerLock?(): Promise<void> | void;
  exitPointerLock?(): void;
}
