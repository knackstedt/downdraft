// ============================================================================
// OSR Manager — Renderer-side coordinator for all OSR rendering
// ============================================================================

import type {
    AtlasLayout,
    OSRIPC,
    OSRPanelConfig,
    OSRRendererConfig,
    OSRRendererEvent,
    OSRRendererStatus,
    OSRSharedTexturePixelFormat,
    WorldSpaceUIElement,
} from "../types.ts";
import { OSRInputRouter, type MouseState } from "./input-router.ts";
import { OSRTextureReceiverManager } from "./texture-receiver-manager.ts";
import { WorldSpaceUIPass, type CameraState } from "./world-space-ui-pass.ts";

export class OSRManager {
  private device: GPUDevice;
  private ipc: OSRIPC | null = null;
  private textureManager: OSRTextureReceiverManager;
  private renderPass: WorldSpaceUIPass;
  private inputRouter: OSRInputRouter | null = null;
  private elements = new Map<string, WorldSpaceUIElement>();
  private rendererIds: string[] = [];
  private rendererStatuses = new Map<string, OSRRendererStatus>();
  private atlasLayouts = new Map<string, AtlasLayout>();
  private errorTextureIndices = new Set<number>();

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat = "bgra8unorm", depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.textureManager = new OSRTextureReceiverManager(device);
    this.renderPass = new WorldSpaceUIPass(device, surfaceFormat, depthFormat);
  }

  init(ipc: OSRIPC): void {
    this.ipc = ipc;

    this.renderPass.prepare();

    // Register IPC callbacks
    ipc.onPanelLayout((rendererId, layout) => {
      this.atlasLayouts.set(rendererId, layout);
      this.updateInputRouterConfig();
    });

    ipc.onRendererEvent((event: OSRRendererEvent) => {
      this.handleRendererEvent(event);
    });
  }

  createRenderer(config: OSRRendererConfig): void {
    if (!this.ipc) return;

    const pixelFormat: OSRSharedTexturePixelFormat = config.sharedTexturePixelFormat ?? "rgba";
    this.textureManager.createReceiver(config.id, config.width, config.height, pixelFormat);

    this.rendererIds.push(config.id);
    this.rendererStatuses.set(config.id, "running");

    // Update texture bindings
    this.updateTextureBindings();

    // Update input router config
    this.updateInputRouterConfig();

    // Send to main process
    this.ipc.createRenderer(config);
  }

  destroyRenderer(id: string): void {
    if (!this.ipc) return;

    this.textureManager.destroyReceiver(id);
    this.rendererIds = this.rendererIds.filter((r) => r !== id);
    this.rendererStatuses.delete(id);
    this.atlasLayouts.delete(id);

    // Update texture indices
    this.updateTextureBindings();
    this.updateInputRouterConfig();

    // Remove elements referencing this renderer
    const texIdx = this.rendererIds.indexOf(id);
    for (const [elId, el] of this.elements) {
      if (el.textureIndex === texIdx) {
        this.elements.delete(elId);
      }
    }

    this.ipc.destroyRenderer(id);
  }

  addPanel(config: OSRPanelConfig): void {
    this.ipc?.addPanel(config);
  }

  removePanel(rendererId: string, panelId: string): void {
    this.ipc?.removePanel(rendererId, panelId);
  }

  updatePanel(rendererId: string, panelId: string, html: string): void {
    this.ipc?.updatePanel(rendererId, panelId, html);
  }

  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void {
    this.ipc?.updateData(rendererId, panelId, values);
  }

  setContent(rendererId: string, html: string): void {
    this.ipc?.setContent(rendererId, html);
  }

  addElement(element: WorldSpaceUIElement): void {
    this.elements.set(element.id, element);
  }

  removeElement(id: string): void {
    this.elements.delete(id);
  }

  updateElements(elements: WorldSpaceUIElement[]): void {
    this.elements.clear();
    for (const el of elements) {
      this.elements.set(el.id, el);
    }
  }

  render(camera: CameraState, passEncoder: GPURenderPassEncoder): void {
    if (this.elements.size === 0) return;

    this.renderPass.updateCamera(camera);
    this.renderPass.setTextures(
      this.textureManager.getTextureList().map((t) => ({ textureView: t.textureView })),
    );

    const elementArray = Array.from(this.elements.values());
    this.renderPass.execute(passEncoder, elementArray, this.errorTextureIndices);
  }

  handleInput(camera: CameraState, mouseState: MouseState): void {
    if (!this.inputRouter) return;
    const elementArray = Array.from(this.elements.values());
    this.inputRouter.handleMouse(camera, mouseState, elementArray);
  }

  handleKey(type: "keyDown" | "keyUp", keyCode: string): void {
    this.inputRouter?.handleKey(type, keyCode);
  }

  destroy(): void {
    this.renderPass.destroy();
    this.textureManager.destroy();
    this.elements.clear();
    this.rendererIds = [];
    this.rendererStatuses.clear();
    this.atlasLayouts.clear();
  }

  private handleRendererEvent(event: OSRRendererEvent): void {
    this.rendererStatuses.set(event.rendererId, event.status);

    const texIdx = this.rendererIds.indexOf(event.rendererId);
    if (texIdx === -1) return;

    if (event.status === "failed") {
      this.errorTextureIndices.add(texIdx);
    } else if (event.status === "running") {
      this.errorTextureIndices.delete(texIdx);
    }

    this.updateInputRouterConfig();
  }

  private updateTextureBindings(): void {
    const textures = this.textureManager.getTextureList();
    this.renderPass.setTextures(textures.map((t) => ({ textureView: t.textureView })));
  }

  private updateInputRouterConfig(): void {
    const textureIndexToRendererId = new Map<number, string>();
    for (let i = 0; i < this.rendererIds.length; i++) {
      textureIndexToRendererId.set(i, this.rendererIds[i]);
    }

    const rendererDimensions = new Map<string, { width: number; height: number }>();
    for (const id of this.rendererIds) {
      const dims = this.textureManager.getReceiverDimensions(id);
      if (dims) rendererDimensions.set(id, dims);
    }

    const config = {
      textureIndexToRendererId,
      atlasLayouts: this.atlasLayouts,
      rendererStatuses: this.rendererStatuses,
      rendererDimensions,
    };

    if (!this.inputRouter && this.ipc) {
      this.inputRouter = new OSRInputRouter(
        config,
        (rendererId, event) => this.ipc?.sendInputEvent(rendererId, event),
      );
    } else if (this.inputRouter) {
      this.inputRouter.updateConfig(config);
    }
  }
}
