import { isXRGPUBindingAvailable } from "./session.ts";

export type XREye = "left" | "right";

export interface XRViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface XRGPULayerView {
  projectionMatrix: Float32Array;
  transform: { matrix: Float32Array };
  subImage: {
    colorTexture: GPUTexture;
    depthTexture?: GPUTexture;
    viewport: XRViewportRect;
  };
}

interface XRGPULayerLike {
  getView(view: XRView): XRGPULayerView | null;
  destroy(): void;
}

interface XRGPUBindingLike {
  createProjectionLayer(init: {
    space: XRReferenceSpace;
    format: GPUTextureFormat;
    depthFormat: GPUTextureFormat;
  }): XRGPULayerLike;
  getSubImage(layer: XRGPULayerLike, frame: XRFrame, eye?: XREye): { colorTexture: GPUTexture; depthTexture?: GPUTexture; viewport: XRViewportRect } | null;
}

export class XRLayerManager {
  private binding: XRGPUBindingLike | null = null;
  private layer: XRGPULayerLike | null = null;
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private depthFormat: GPUTextureFormat = "depth32float";

  private currentViews: Map<XREye, XRGPULayerView | null> = new Map([
    ["left", null],
    ["right", null],
  ]);

  init(device: GPUDevice, session: XRSession): void {
    this.device = device;
    if (!isXRGPUBindingAvailable()) {
      throw new Error("XRGPUBinding not available — enable chrome://flags/#webxr-incubations");
    }
    const BindingCtor = (globalThis as { XRGPUBinding?: new (device: GPUDevice, session: XRSession) => XRGPUBindingLike }).XRGPUBinding;
    if (!BindingCtor) {
      throw new Error("XRGPUBinding constructor not found");
    }
    this.binding = new BindingCtor(device, session);
  }

  createLayer(session: XRSession, referenceSpace: XRReferenceSpace, format: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    if (!this.binding) throw new Error("XRLayerManager not initialized — call init() first");
    this.format = format;
    this.depthFormat = depthFormat;
    this.layer = this.binding.createProjectionLayer({
      space: referenceSpace,
      format,
      depthFormat,
    });
    session.updateRenderState({ layers: [this.layer as unknown as XRLayer] });
  }

  beginFrame(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    if (!this.layer || !this.binding) return;

    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) {
      this.currentViews.set("left", null);
      this.currentViews.set("right", null);
      return;
    }

    for (const view of pose.views) {
      const eye = view.eye as XREye;
      if (eye !== "left" && eye !== "right") continue;
      const layerView = this.layer.getView(view);
      this.currentViews.set(eye, layerView);
    }
  }

  getColorTextureView(eye: XREye): GPUTextureView {
    const view = this.currentViews.get(eye);
    if (!view) throw new Error(`No layer view for eye: ${eye}`);
    return view.subImage.colorTexture.createView();
  }

  getDepthTextureView(eye: XREye): GPUTextureView {
    const view = this.currentViews.get(eye);
    if (!view || !view.subImage.depthTexture) {
      throw new Error(`No depth texture for eye: ${eye}`);
    }
    return view.subImage.depthTexture.createView();
  }

  getViewport(eye: XREye): XRViewportRect | null {
    const view = this.currentViews.get(eye);
    if (!view) return null;
    return view.subImage.viewport;
  }

  getProjectionMatrix(eye: XREye): Float32Array | null {
    const view = this.currentViews.get(eye);
    if (!view) return null;
    return view.projectionMatrix;
  }

  getViewMatrix(eye: XREye): Float32Array | null {
    const view = this.currentViews.get(eye);
    if (!view) return null;
    return view.transform.matrix;
  }

  hasView(eye: XREye): boolean {
    return this.currentViews.get(eye) !== null;
  }

  getLayer(): XRGPULayerLike | null {
    return this.layer;
  }

  destroy(): void {
    if (this.layer) {
      this.layer.destroy();
      this.layer = null;
    }
    this.binding = null;
    this.device = null;
    this.currentViews.set("left", null);
    this.currentViews.set("right", null);
  }
}
