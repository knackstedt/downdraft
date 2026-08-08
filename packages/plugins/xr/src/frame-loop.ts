// ============================================================================
// XRFrameLoop — drives the XR render loop through the RendererPluginContext
//
// Installs XR-specific overrides on the RendererPluginContext:
//  - XR rAF source (session.requestAnimationFrame instead of window.rAF)
//  - XR render target provider (per-eye XRGPULayer textures)
//  - Viewport camera provider (per-eye stereo cameras)
//  - Stereo viewport count (2)
//  - beforeFrame hook (XR input mapping)
//
// On stop(), all overrides are cleared and the desktop render loop resumes.
// ============================================================================

import type {
    CameraViewportInfo,
    InputState,
    RendererPluginContext,
    RenderTargetProvider,
    ViewportRect,
} from "@downdraft/core";
import type { XRCameraRig } from "./camera-rig";
import type { XRInputMapper } from "./input";
import type { XRLayerManager } from "./layer";
import type { XRSessionManager } from "./session";

const DEFAULT_VIEWPORT: ViewportRect = { x: 0, y: 0, w: 1, h: 1 };

class XRRenderTargetProvider implements RenderTargetProvider {
  private layerManager: XRLayerManager;

  constructor(layerManager: XRLayerManager) {
    this.layerManager = layerManager;
  }

  getColorView(viewportIdx: number): GPUTextureView {
    const eye = viewportIdx === 0 ? "left" : "right";
    return this.layerManager.getColorTextureView(eye);
  }

  getDepthView(viewportIdx: number, _w: number, _h: number): GPUTextureView {
    const eye = viewportIdx === 0 ? "left" : "right";
    return this.layerManager.getDepthTextureView(eye);
  }

  getViewportCount(): number {
    return 2;
  }

  getViewportRect(idx: number, _screenW: number, _screenH: number): ViewportRect {
    const eye = idx === 0 ? "left" : "right";
    const vp = this.layerManager.getViewport(eye);
    if (vp) {
      return { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
    }
    return DEFAULT_VIEWPORT;
  }

  beginFrame(): void {
    // no-op — layer views are updated in XRFrameLoop.onXRFrame before renderFrame
  }

  endFrame(_encoder: GPUCommandEncoder): void {
    // no-op — XRGPULayer textures are consumed by the XR compositor automatically
  }
}

export interface XRFrameLoopOptions {
  inputState?: InputState | null;
  inputMapper?: XRInputMapper | null;
  canvas: HTMLCanvasElement;
}

export class XRFrameLoop {
  private ctx: RendererPluginContext;
  private sessionManager: XRSessionManager;
  private layerManager: XRLayerManager;
  private cameraRig: XRCameraRig;
  private inputState: InputState | null;
  private inputMapper: XRInputMapper | null;
  private canvas: HTMLCanvasElement;

  private targetProvider: XRRenderTargetProvider;
  private active = false;
  private currentFrame: XRFrame | null = null;

  // Unsubscribe fns for context hooks installed during start().
  private unsubBeforeFrame: (() => void) | null = null;

  constructor(
    ctx: RendererPluginContext,
    sessionManager: XRSessionManager,
    layerManager: XRLayerManager,
    cameraRig: XRCameraRig,
    options: XRFrameLoopOptions,
  ) {
    this.ctx = ctx;
    this.sessionManager = sessionManager;
    this.layerManager = layerManager;
    this.cameraRig = cameraRig;
    this.inputState = options.inputState ?? null;
    this.inputMapper = options.inputMapper ?? null;
    this.canvas = options.canvas;
    this.targetProvider = new XRRenderTargetProvider(layerManager);
  }

  start(): void {
    if (this.active) return;
    const session = this.sessionManager.getSession();
    if (!session) throw new Error("No active XR session");

    this.active = true;

    // Install XR rAF source
    this.ctx.setRAFSource(
      (cb: (time: number) => void) => session.requestAnimationFrame((time: number, frame: XRFrame) => {
        this.onXRFrame(time, frame);
        cb(time);
      }),
      (id: number) => session.cancelAnimationFrame(id),
    );

    // Install XR render target provider
    this.ctx.setRenderTargetProvider(this.targetProvider);

    // Set viewport count to 2 for stereo
    this.ctx.setViewportCount(2);

    // Install per-eye viewport camera provider (takes priority over the
    // game's onViewport callback)
    this.ctx.setViewportCameraProvider((viewportIdx, _dt, _elapsedTime) => {
      const eye = viewportIdx === 0 ? "left" : "right";
      const [left, right] = this.cameraRig.computeEyeCameras(
        this.canvas.width,
        this.canvas.height,
      );
      const cam = eye === "left" ? left : right;
      if (!cam) return null;
      return cam as CameraViewportInfo;
    });

    // Install beforeFrame hook for XR input mapping
    this.unsubBeforeFrame = this.ctx.onFrame("beforeFrame", (_dt, _elapsedTime) => {
      const refSpace = this.sessionManager.getReferenceSpace();
      if (refSpace && this.currentFrame && this.inputMapper && this.inputState) {
        this.inputMapper.update(this.currentFrame, refSpace, this.inputState);
      }
    });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.currentFrame = null;

    // Restore desktop rAF
    this.ctx.setRAFSource(null, null);

    // Remove XR render target provider
    this.ctx.setRenderTargetProvider(null);

    // Restore viewport count to 1
    this.ctx.setViewportCount(1);

    // Remove viewport camera provider
    this.ctx.setViewportCameraProvider(null);

    // Remove beforeFrame hook
    this.unsubBeforeFrame?.();
    this.unsubBeforeFrame = null;

    // Clear XR controller state from input
    if (this.inputState) {
      this.inputState.xrControllers = [];
    }
  }

  private onXRFrame(_time: number, frame: XRFrame): void {
    this.currentFrame = frame;

    const refSpace = this.sessionManager.getReferenceSpace();
    if (!refSpace) return;

    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    // Update layer views from the pose
    this.layerManager.beginFrame(frame, refSpace);

    // Update head pose for game logic
    this.cameraRig.updateHeadPose(pose, refSpace);
  }

  isActive(): boolean {
    return this.active;
  }
}
