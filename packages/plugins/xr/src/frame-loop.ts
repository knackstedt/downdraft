import { type CameraViewportInfo, type FrameCallbacks, type GameRenderer, type InputState, type RenderTargetProvider, type ViewportRect } from "@downdraft/core";
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
}

export class XRFrameLoop {
  private renderer: GameRenderer;
  private sessionManager: XRSessionManager;
  private layerManager: XRLayerManager;
  private cameraRig: XRCameraRig;
  private inputState: InputState | null;
  private inputMapper: XRInputMapper | null;

  private targetProvider: XRRenderTargetProvider;
  private originalViewportCount: number = 1;
  private originalCallbacks: FrameCallbacks = {};
  private xrCallbacks: FrameCallbacks;
  private active = false;

  private currentFrame: XRFrame | null = null;

  constructor(
    renderer: GameRenderer,
    sessionManager: XRSessionManager,
    layerManager: XRLayerManager,
    cameraRig: XRCameraRig,
    options: XRFrameLoopOptions = {},
  ) {
    this.renderer = renderer;
    this.sessionManager = sessionManager;
    this.layerManager = layerManager;
    this.cameraRig = cameraRig;
    this.inputState = options.inputState ?? null;
    this.inputMapper = options.inputMapper ?? null;
    this.targetProvider = new XRRenderTargetProvider(layerManager);

    const self = this;

    this.xrCallbacks = {
      beforeFrame: (dt: number, elapsedTime: number) => {
        const refSpace = self.sessionManager.getReferenceSpace();
        if (refSpace && self.currentFrame && self.inputMapper && self.inputState) {
          self.inputMapper.update(self.currentFrame, refSpace, self.inputState);
        }
        self.originalCallbacks.beforeFrame?.(dt, elapsedTime);
      },
      beforeViewports: (dt: number, elapsedTime: number) => {
        self.originalCallbacks.beforeViewports?.(dt, elapsedTime);
      },
      onViewport: (viewportIdx: number, dt: number, elapsedTime: number): CameraViewportInfo | null => {
        // Return the XR eye camera for this viewport
        const eye = viewportIdx === 0 ? "left" : "right";
        const [left, right] = self.cameraRig.computeEyeCameras(
          self.renderer.getCanvasWidth(),
          self.renderer.getCanvasHeight(),
        );
        const cam = eye === "left" ? left : right;
        if (!cam) return null;

        // Allow game to augment (e.g. update per-eye uniforms) via original onViewport
        const gameCam = self.originalCallbacks.onViewport?.(viewportIdx, dt, elapsedTime);
        // Use XR camera — game callback is called for side effects but we override the camera
        void gameCam;
        return cam;
      },
      afterViewports: (dt: number, elapsedTime: number) => {
        self.originalCallbacks.afterViewports?.(dt, elapsedTime);
      },
      afterFrame: (dt: number, elapsedTime: number) => {
        self.originalCallbacks.afterFrame?.(dt, elapsedTime);
      },
      onResize: self.originalCallbacks.onResize,
      getPostProcessInfo: self.originalCallbacks.getPostProcessInfo,
    };
  }

  start(originalCallbacks?: FrameCallbacks): void {
    if (this.active) return;
    const session = this.sessionManager.getSession();
    if (!session) throw new Error("No active XR session");

    this.active = true;

    // Save original state
    this.originalViewportCount = 1;
    this.originalCallbacks = originalCallbacks ?? {};

    // Install XR rAF source
    this.renderer.setRAFSource(
      (cb: (time: number) => void) => session.requestAnimationFrame((time: number, frame: XRFrame) => {
        this.onXRFrame(time, frame);
        cb(time);
      }),
      (id: number) => session.cancelAnimationFrame(id),
    );

    // Install XR render target provider
    this.renderer.setRenderTargetProvider(this.targetProvider);

    // Set viewport count to 2 for stereo
    this.renderer.setViewportCount(2);

    // Install XR callbacks (wrapping original callbacks)
    this.xrCallbacks.onResize = this.originalCallbacks.onResize;
    this.xrCallbacks.getPostProcessInfo = this.originalCallbacks.getPostProcessInfo;
    this.renderer.setCallbacks(this.xrCallbacks);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    // Restore desktop rAF
    this.renderer.clearRAFSource();

    // Remove XR render target provider
    this.renderer.setRenderTargetProvider(null);

    // Restore viewport count
    this.renderer.setViewportCount(this.originalViewportCount);

    // Restore original callbacks
    this.renderer.setCallbacks(this.originalCallbacks);

    this.currentFrame = null;

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
