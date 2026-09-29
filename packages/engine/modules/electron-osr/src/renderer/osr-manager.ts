// ============================================================================
// OSR Manager — Renderer-side coordinator for all OSR rendering
// ============================================================================

import { createLogger } from "@downdraft/engine";
import type {
  AtlasLayout,
  OSRHostBridge,
  OSRPanelConfig,
  OSRRendererConfig,
  OSRRendererEvent,
  OSRRendererStatus,
  OSRSharedTexturePixelFormat,
  WorldSpaceUIElement,
} from "../types";
import { OSRInputRouter, type MouseState } from "./input-router";
import { OSRTextureReceiverManager } from "./texture-receiver-manager";
import { WorldSpaceUIPass, type CameraState } from "./world-space-ui-pass";

const log = createLogger();

export class OSRManager {
  private device: GPUDevice;
  private ipc: OSRHostBridge | null = null;
  private textureManager: OSRTextureReceiverManager;
  private renderPass: WorldSpaceUIPass;
  private inputRouter: OSRInputRouter | null = null;
  private elements = new Map<string, WorldSpaceUIElement>();
  private _warnedNoTextures = false;
  private _loggedFirstRender = false;
  private rendererIds: string[] = [];
  private rendererStatuses = new Map<string, OSRRendererStatus>();
  private atlasLayouts = new Map<string, AtlasLayout>();
  private errorTextureIndices = new Set<number>();
  private cursorStyle: string = "default";
  private onCursorStyleCb: ((cursor: string) => void) | null = null;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat = "bgra8unorm", depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.textureManager = new OSRTextureReceiverManager(device);
    this.renderPass = new WorldSpaceUIPass(device, surfaceFormat, depthFormat);
  }

  init(ipc: OSRHostBridge): void {
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

    // Cursor style callback — optional, may not exist in older preload builds
    if (typeof ipc.onCursorStyle === "function") {
      ipc.onCursorStyle((_rendererId, cursor) => {
        this.handleCursorStyle(cursor);
      });
    }
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
    for (const [elId, el] of this.elements.entries()) {
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
    elements.forEach((el) => {
      this.elements.set(el.id, el);
    });
  }

  render(camera: CameraState, passEncoder: GPURenderPassEncoder): void {
    if (this.elements.size === 0) return;

    const texList = this.textureManager.getTextureList();
    if (texList.length === 0) {
      if (!this._warnedNoTextures) {
        log.warn("OSR", `No textures available for rendering — texture receivers may not have received frames yet`);
        this._warnedNoTextures = true;
      }
      return;
    }
    if (!this._loggedFirstRender) {
      log.info("OSR", `First render with ${texList.length} texture(s), ${this.elements.size} element(s)`);
      this._loggedFirstRender = true;
    }

    this.renderPass.updateCamera(camera);
    this.renderPass.setTextures(
      texList.map((t) => ({ textureView: t.textureView })),
    );

    const elementArray = Array.from(this.elements.values());
    this.renderPass.execute(passEncoder, elementArray, this.errorTextureIndices);
  }

  handleInput(camera: CameraState, mouseState: MouseState): void {
    if (!this.inputRouter) return;
    const elementArray = Array.from(this.elements.values());
    this.inputRouter.handleMouse(camera, mouseState, elementArray);
  }

  handleKey(type: "keyDown" | "keyUp", keyCode: string, modifiers?: string[]): void {
    this.inputRouter?.handleKey(type, keyCode, modifiers);
  }

  focusBillboard(canvasWidth?: number, canvasHeight?: number): string | null {
    const id = this.inputRouter?.focusBillboard() ?? null;
    if (id && canvasWidth && canvasHeight) {
      this.inputRouter?.setForcedFocusCanvasSize(canvasWidth, canvasHeight);
    }
    return id;
  }

  unfocusBillboard(): void {
    this.inputRouter?.unfocusBillboard();
  }

  isForcedFocus(): boolean {
    return this.inputRouter?.isForcedFocus() ?? false;
  }

  isHoveringBillboard(): boolean {
    return this.inputRouter?.isHoveringBillboard() ?? false;
  }

  getCursorStyle(): string {
    return this.cursorStyle;
  }

  onCursorStyleChange(cb: ((cursor: string) => void) | null): void {
    this.onCursorStyleCb = cb;
  }

  setSoftwareCursorEnabled(enabled: boolean): void {
    if (!this.ipc || typeof this.ipc.setSoftwareCursor !== "function") return;
    for (let _i6602 = 0, _it6602 = this.rendererIds, _n6602 = _it6602.length; _i6602 < _n6602; _i6602++) { const id = _it6602[_i6602];
      this.ipc.setSoftwareCursor(id, enabled);
    };
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

  private handleCursorStyle(cursor: string): void {
    if (this.cursorStyle !== cursor) {
      this.cursorStyle = cursor;
      log.info("OSR", `Cursor style changed: ${cursor}`);
      this.onCursorStyleCb?.(cursor);
    }
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
    this.rendererIds.forEach((id) => {
      const dims = this.textureManager.getReceiverDimensions(id);
      if (dims) rendererDimensions.set(id, dims);
    });

    const config = {
      textureIndexToRendererId,
      atlasLayouts: this.atlasLayouts,
      rendererStatuses: this.rendererStatuses,
      rendererDimensions,
    };

    if (!this.inputRouter && this.ipc) {
      this.inputRouter = new OSRInputRouter(
        config,
        (rendererId, event) => {
          this.ipc?.sendInputEvent(rendererId, event);
        },
      );
    } else if (this.inputRouter) {
      this.inputRouter.updateConfig(config);
    }
  }
}
