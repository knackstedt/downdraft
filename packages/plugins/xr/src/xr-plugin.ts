import { type FrameCallbacks, type GameRenderer, type InputState } from "@downdraft/core";
import { XRCameraRig } from "./camera-rig";
import { XRFrameLoop, type XRFrameLoopOptions } from "./frame-loop";
import { XRInputMapper } from "./input";
import { XRLayerManager } from "./layer";
import { XRSessionManager, isVRSupported, isXRGPUBindingAvailable } from "./session";
import type { XRSessionConfig, XRWorldOrigin } from "./types";
import { DEFAULT_XR_CONFIG } from "./types";

export interface XRPluginOptions {
  renderer: GameRenderer;
  device: GPUDevice;
  inputState?: InputState | null;
  worldOrigin?: () => XRWorldOrigin;
  colorFormat?: GPUTextureFormat;
  depthFormat?: GPUTextureFormat;
}

export class XRPlugin {
  private sessionManager: XRSessionManager;
  private layerManager: XRLayerManager;
  private cameraRig: XRCameraRig;
  private inputMapper: XRInputMapper;
  private frameLoop: XRFrameLoop;

  private renderer: GameRenderer;
  private device: GPUDevice;
  private worldOriginFn: () => XRWorldOrigin;
  private colorFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;

  private initialized = false;

  constructor(options: XRPluginOptions) {
    this.renderer = options.renderer;
    this.device = options.device;
    this.worldOriginFn = options.worldOrigin ?? (() => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }));
    this.colorFormat = options.colorFormat ?? "bgra8unorm";
    this.depthFormat = options.depthFormat ?? "depth32float";

    this.sessionManager = new XRSessionManager();
    this.layerManager = new XRLayerManager();
    this.inputMapper = new XRInputMapper();
    this.cameraRig = new XRCameraRig(this.layerManager, this.worldOriginFn);

    const frameLoopOptions: XRFrameLoopOptions = {
      inputState: options.inputState ?? null,
      inputMapper: this.inputMapper,
    };
    this.frameLoop = new XRFrameLoop(
      this.renderer,
      this.sessionManager,
      this.layerManager,
      this.cameraRig,
      frameLoopOptions,
    );
  }

  async isSupported(): Promise<boolean> {
    return await isVRSupported();
  }

  isAvailable(): boolean {
    return isXRGPUBindingAvailable();
  }

  async enterVR(
    originalCallbacks?: FrameCallbacks,
    config?: XRSessionConfig,
  ): Promise<void> {
    if (!isXRGPUBindingAvailable()) {
      throw new Error("XRGPUBinding not available — enable chrome://flags/#webxr-incubations");
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

    // Start XR frame loop
    this.frameLoop.start(originalCallbacks);

    // Handle session end
    this.sessionManager.onSessionEnd(() => {
      this.frameLoop.stop();
      this.layerManager.destroy();
      this.initialized = false;
    });
  }

  async exitVR(): Promise<void> {
    if (!this.initialized) return;
    this.frameLoop.stop();
    await this.sessionManager.endSession();
    this.layerManager.destroy();
    this.initialized = false;
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

  getFrameLoop(): XRFrameLoop {
    return this.frameLoop;
  }

  isActive(): boolean {
    return this.frameLoop.isActive();
  }

  getHeadPose(): { position: [number, number, number]; quaternion: [number, number, number, number] } {
    return this.cameraRig.getHeadPose();
  }

  setWorldOrigin(fn: () => XRWorldOrigin): void {
    this.worldOriginFn = fn;
  }
}
