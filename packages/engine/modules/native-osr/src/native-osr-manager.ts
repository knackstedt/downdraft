// ============================================================================
// NativeOSRManager — Renderer-side coordinator for Blitz-backed OSR
//
// Coordinates panel renderers (createRenderer, addElement, render,
// handleInput, focusBillboard, …). Textures come from in-process `pullFrame`
// + writeTexture, and the host object is the native bridge's osr sub-API.
// ============================================================================

import { OSRInputRouter, type MouseState } from "./input-router";
import { NativeOsrTextureSource, type NativeOsrFrameSource } from "./native-texture-source";
import type {
    AtlasLayout,
    OSRHostBridge,
    OSRPanelConfig,
    OSRRendererConfig,
    OSRRendererEvent,
    OSRRendererStatus,
    WorldSpaceUIElement,
} from "./types";
import { WorldSpaceUIPass, type CameraState } from "./world-space-ui-pass";



/** The native bridge surface consumed by the manager — OSRHostBridge plus the
 *  in-process frame-pull extension installed by NativeOsrHost. */
export type NativeOsrHostBridge = OSRHostBridge & NativeOsrFrameSource & {
  getDimensions?(rendererId: string): { width: number; height: number } | null;
  hitTest?(rendererId: string, x: number, y: number): boolean;
};

export class NativeOSRManager {
  private device: GPUDevice;
  private host: NativeOsrHostBridge | null = null;
  private sources = new Map<string, NativeOsrTextureSource>();
  private renderPass: WorldSpaceUIPass;
  private inputRouter: OSRInputRouter | null = null;
  private elements = new Map<string, WorldSpaceUIElement>();
  private rendererIds: string[] = [];
  private rendererStatuses = new Map<string, OSRRendererStatus>();
  private atlasLayouts = new Map<string, AtlasLayout>();
  private errorTextureIndices = new Set<number>();
  private cursorStyle: string = "default";
  private onCursorStyleCb: ((cursor: string) => void) | null = null;

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat = "bgra8unorm", depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.renderPass = new WorldSpaceUIPass(device, surfaceFormat, depthFormat);
  }

  init(host: NativeOsrHostBridge): void {
    this.host = host;
    this.renderPass.prepare();

    host.onPanelLayout((rendererId, layout) => {
      this.atlasLayouts.set(rendererId, layout);
      this.updateInputRouterConfig();
    });

    host.onRendererEvent((event: OSRRendererEvent) => {
      this.rendererStatuses.set(event.rendererId, event.status);
      const texIdx = this.rendererIds.indexOf(event.rendererId);
      if (texIdx >= 0) {
        if (event.status === "failed") this.errorTextureIndices.add(texIdx);
        else if (event.status === "running") this.errorTextureIndices.delete(texIdx);
      }
      this.updateInputRouterConfig();
    });

    if (typeof host.onCursorStyle === "function") {
      host.onCursorStyle((_id, cursor) => {
        if (this.cursorStyle !== cursor) {
          this.cursorStyle = cursor;
          this.onCursorStyleCb?.(cursor);
        }
      });
    }
  }

  createRenderer(config: OSRRendererConfig): void {
    if (!this.host) return;
    this.sources.set(
      config.id,
      new NativeOsrTextureSource(this.device, config.id, config.width, config.height, config.pixelFormat ?? "rgba"),
    );
    this.rendererIds.push(config.id);
    this.rendererStatuses.set(config.id, "running");
    this.updateTextureBindings();
    this.updateInputRouterConfig();
    void this.host.createRenderer(config);
  }

  destroyRenderer(id: string): void {
    if (!this.host) return;
    const texIdx = this.rendererIds.indexOf(id);
    this.sources.get(id)?.destroy();
    this.sources.delete(id);
    this.rendererIds = this.rendererIds.filter((r) => r !== id);
    this.rendererStatuses.delete(id);
    this.atlasLayouts.delete(id);
    this.errorTextureIndices.delete(texIdx);
    for (const [elId, el] of this.elements.entries()) {
      if (el.textureIndex === texIdx) this.elements.delete(elId);
    }
    this.updateTextureBindings();
    this.updateInputRouterConfig();
    void this.host.destroyRenderer(id);
  }

  addPanel(config: OSRPanelConfig): void {
    void this.host?.addPanel(config);
  }

  removePanel(rendererId: string, panelId: string): void {
    void this.host?.removePanel(rendererId, panelId);
  }

  updatePanel(rendererId: string, panelId: string, html: string): void {
    void this.host?.updatePanel(rendererId, panelId, html);
  }

  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void {
    this.host?.updateData(rendererId, panelId, values);
  }

  setContent(rendererId: string, html: string): void {
    void this.host?.setContent(rendererId, html);
  }

  addElement(element: WorldSpaceUIElement): void {
    this.elements.set(element.id, element);
  }

  removeElement(id: string): void {
    this.elements.delete(id);
  }

  updateElements(elements: WorldSpaceUIElement[]): void {
    this.elements.clear();
    elements.forEach((el) => { this.elements.set(el.id, el);; });
  }

  /** Pull dirty frames from the host and upload — call once per frame before
   *  render(). Cheap when clean (the cdylib returns null without rasterizing). */
  update(): void {
    if (!this.host) return;
    for (const source of this.sources.values()) {
      source.update(this.host);
    }
  }

  render(camera: CameraState, passEncoder: GPURenderPassEncoder): void {
    if (this.elements.size === 0) return;
    this.update();
    const texList = this.getTextureList();
    if (texList.length === 0) return;
    this.renderPass.updateCamera(camera);
    this.renderPass.setTextures(texList.map((t) => ({ textureView: t.textureView })));
    this.renderPass.execute(passEncoder, Array.from(this.elements.values()), this.errorTextureIndices);
  }

  handleInput(camera: CameraState, mouseState: MouseState): void {
    this.inputRouter?.handleMouse(camera, mouseState, Array.from(this.elements.values()));
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
    if (!this.host || typeof this.host.setSoftwareCursor !== "function") return;
    for (let _i7044 = 0, _it7044 = this.rendererIds, _n7044 = _it7044.length; _i7044 < _n7044; _i7044++) { const id = _it7044[_i7044]; this.host.setSoftwareCursor(id, enabled);; };
  }

  destroy(): void {
    this.renderPass.destroy();
    for (const s of this.sources.values()) s.destroy();
    this.sources.clear();
    this.elements.clear();
    this.rendererIds = [];
    this.rendererStatuses.clear();
    this.atlasLayouts.clear();
  }

  private getTextureList(): { rendererId: string; textureView: GPUTextureView }[] {
    const list: { rendererId: string; textureView: GPUTextureView }[] = [];
    for (const [id, s] of this.sources.entries()) list.push({ rendererId: id, textureView: s.getTextureView() });
    return list;
  }

  private updateTextureBindings(): void {
    this.renderPass.setTextures(this.getTextureList().map((t) => ({ textureView: t.textureView })));
  }

  private updateInputRouterConfig(): void {
    const textureIndexToRendererId = new Map<number, string>();
    for (let i = 0; i < this.rendererIds.length; i++) textureIndexToRendererId.set(i, this.rendererIds[i]);

    const rendererDimensions = new Map<string, { width: number; height: number }>();
    this.rendererIds.forEach((id) => {
      const s = this.sources.get(id);
      if (s) rendererDimensions.set(id, { width: s.width, height: s.height });
    });

    const config = {
      textureIndexToRendererId,
      atlasLayouts: this.atlasLayouts,
      rendererStatuses: this.rendererStatuses,
      rendererDimensions,
    };

    if (!this.inputRouter && this.host) {
      this.inputRouter = new OSRInputRouter(config, (rendererId, event) => {
        this.host?.sendInputEvent(rendererId, event);
      });
    } else {
      this.inputRouter?.updateConfig(config);
    }
  }
}
