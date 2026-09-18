// ============================================================================
// XRModule — Renderer-thread plugin for WebXR VR sessions
//
// Implements `RendererModule`. The sim-side `xrModule` in `./plugin.ts`
// registers `XRSessionManager`/`XRInputMapper` as sim resources; this
// renderer plugin owns the XR frame loop, per-eye cameras, and rAF/render
// target provider swaps. XR spans both threads, so it ships two objects
// (the sim `Module` + this `RendererModule`) — see
// docs/site/src/content/docs/guides/plugins.md.
// ============================================================================

import type { InputState, RendererModule, RendererModuleContext } from "@downdraft/engine";
import { XRCameraRig } from "./camera-rig";
import { XRFrameLoop, type XRFrameLoopOptions } from "./frame-loop";
import { XRInputMapper } from "./input";
import { XRLayerManager } from "./layer";
import { XRSessionManager, isVRSupported, isXRGPUBindingAvailable } from "./session";
import type { XRSessionConfig, XRWorldOrigin } from "./types";
import { DEFAULT_XR_CONFIG } from "./types";

export interface XRModuleOptions {
  device: GPUDevice;
  inputState?: InputState | null;
  worldOrigin?: () => XRWorldOrigin;
  colorFormat?: GPUTextureFormat;
  depthFormat?: GPUTextureFormat;
}

export class XRModule implements RendererModule {
  readonly name = "@downdraft/engine/modules/xr:renderer";
  readonly version = "0.1.0";

  private sessionManager: XRSessionManager;
  private layerManager: XRLayerManager;
  private cameraRig: XRCameraRig;
  private inputMapper: XRInputMapper;
  private frameLoop: XRFrameLoop | null = null;

  private device: GPUDevice;
  private worldOriginFn: () => XRWorldOrigin;
  private colorFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private inputState: InputState | null;

  private ctx: RendererModuleContext | null = null;
  private initialized = false;

  constructor(options: XRModuleOptions) {
    this.device = options.device;
    this.inputState = options.inputState ?? null;
    this.worldOriginFn = options.worldOrigin ?? (() => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }));
    this.colorFormat = options.colorFormat ?? "bgra8unorm";
    this.depthFormat = options.depthFormat ?? "depth32float";

    this.sessionManager = new XRSessionManager();
    this.layerManager = new XRLayerManager();
    this.inputMapper = new XRInputMapper();
    this.cameraRig = new XRCameraRig(this.layerManager, this.worldOriginFn);
  }

  // ── RendererModule implementation ──

  register(ctx: RendererModuleContext): void {
    this.ctx = ctx;

    const frameLoopOptions: XRFrameLoopOptions = {
      inputState: this.inputState,
      inputMapper: this.inputMapper,
      canvas: ctx.getCanvas(),
    };
    this.frameLoop = new XRFrameLoop(
      ctx,
      this.sessionManager,
      this.layerManager,
      this.cameraRig,
      frameLoopOptions,
    );

    ctx.onDispose(() => {
      if (this.frameLoop?.isActive()) {
        this.frameLoop.stop();
      }
      this.layerManager.destroy();
      this.initialized = false;
    });
  }

  // ── Public API (called by the game after registration) ──

  async isSupported(): Promise<boolean> {
    return await isVRSupported();
  }

  isAvailable(): boolean {
    return isXRGPUBindingAvailable();
  }

  async enterVR(config?: XRSessionConfig): Promise<void> {
    if (!isXRGPUBindingAvailable()) {
      throw new Error("XRGPUBinding not available — enable chrome://flags/#webxr-incubations");
    }
    if (!this.ctx || !this.frameLoop) {
      throw new Error("XRModule not registered — call useRendererModule() first");
    }

    const sessionConfig = config ?? DEFAULT_XR_CONFIG;

    // Request XR session
    const session = await this.sessionManager.requestSession("immersive-vr", sessionConfig);

    // Set reference space
    await this.sessionManager.setReferenceSpace("local-floor");

    // Initialize layer manager with GPU device
    this.layerManager.init(this.device, session);

    // Create projection layer
    const refSpace = this.sessionManager.getReferenceSpace();
    if (!refSpace) throw new Error("Failed to get reference space");
    this.layerManager.createLayer(session, refSpace, this.colorFormat, this.depthFormat);

    this.initialized = true;

    // Start XR frame loop (installs XR rAF, render target provider, viewport
    // camera provider, and stereo viewport count via the RendererModuleContext)
    this.frameLoop.start();

    // Handle session end
    this.sessionManager.onSessionEnd(() => {
      this.frameLoop?.stop();
      this.layerManager.destroy();
      this.initialized = false;
    });
  }

  async exitVR(): Promise<void> {
    if (!this.initialized) return;
    this.frameLoop?.stop();
    // Ensure all session GPU resources are destroyed even if session.end() fails.
    try {
      await this.sessionManager.endSession();
    } finally {
      this.layerManager.destroy();
      this.initialized = false;
    }
  }

  getSessionManager(): XRSessionManager {
    return this.sessionManager;
  }

  getLayerManager(): XRLayerManager {
    return this.layerManager;
  }

  getCameraRig(): XRCameraRig {
    return this.cameraRig;
  }

  getInputMapper(): XRInputMapper {
    return this.inputMapper;
  }

  getFrameLoop(): XRFrameLoop | null {
    return this.frameLoop;
  }

  isActive(): boolean {
    return this.frameLoop?.isActive() ?? false;
  }

  getHeadPose(): { position: [number, number, number]; quaternion: [number, number, number, number] } {
    return this.cameraRig.getHeadPose();
  }

  setWorldOrigin(fn: () => XRWorldOrigin): void {
    this.worldOriginFn = fn;
  }
}
