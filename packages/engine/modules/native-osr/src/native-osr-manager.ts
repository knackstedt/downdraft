// ============================================================================
// NativeOSRManager — Renderer-side coordinator for Blitz-backed OSR
//
// Same public surface as electron-osr's OSRManager (createRenderer, addElement,
// render, handleInput, focusBillboard, …) so games can swap implementations by
// runtime. Differences: textures come from in-process `pullFrame` + writeTexture
// instead of shared-texture receivers, and the ipc object is the native
// bridge's osr sub-API.
// ============================================================================

import type {
  AtlasLayout,
  OSRIPC,
  OSRPanelConfig,
  OSRRendererConfig,
  OSRRendererEvent,
  OSRRendererStatus,
  WorldSpaceUIElement,
} from "./types";
import { OSRInputRouter, type MouseState } from "./input-router";
import { NativeOsrTextureSource, type NativeOsrFrameSource } from "./native-texture-source";
import { WorldSpaceUIPass, type CameraState } from "./world-space-ui-pass";



/** The native bridge surface consumed by the manager — OSRIPC plus the
 *  in-process frame-pull extension installed by NativeOsrHost. */
export type NativeOsrIPC = OSRIPC & NativeOsrFrameSource & {
  getDimensions?(rendererId: string): { width: number; height: number } | null;
  hitTest?(rendererId: string, x: number, y: number): boolean;
};

export class NativeOSRManager {
  private device: GPUDevice;
  private ipc: NativeOsrIPC | null = null;
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

  init(ipc: NativeOsrIPC): void {
    this.ipc = ipc;
    this.renderPass.prepare();

    ipc.onPanelLayout((rendererId, layout) => {
      this.atlasLayouts.set(rendererId, layout);
      this.updateInputRouterConfig();
    });

    ipc.onRendererEvent((event: OSRRendererEvent) => {
      this.rendererStatuses.set(event.rendererId, event.status);
      const texIdx = this.rendererIds.indexOf(event.rendererId);
      if (texIdx >= 0) {
        if (event.status === "failed") this.errorTextureIndices.add(texIdx);
        else if (event.status === "running") this.errorTextureIndices.delete(texIdx);
      }
      this.updateInputRouterConfig();
    });

    if (typeof ipc.onCursorStyle === "function") {
      ipc.onCursorStyle((_id, cursor) => {
        if (this.cursorStyle !== cursor) {
          this.cursorStyle = cursor;
          this.onCursorStyleCb?.(cursor);
        }
      });
    }
  }

  createRenderer(config: OSRRendererConfig): void {
    if (!this.ipc) return;
    this.sources.set(
      config.id,
      new NativeOsrTextureSource(this.device, config.id, config.width, config.height, config.sharedTexturePixelFormat ?? "rgba"),
    );
    this.rendererIds.push(config.id);
    this.rendererStatuses.set(config.id, "running");
    this.updateTextureBindings();
    this.updateInputRouterConfig();
    void this.ipc.createRenderer(config);
  }

  destroyRenderer(id: string): void {
    if (!this.ipc) return;
    const texIdx = this.rendererIds.indexOf(id);
    this.sources.get(id)?.destroy();
    this.sources.delete(id);
    this.rendererIds = this.rendererIds.filter((r) => r !== id);
    this.rendererStatuses.delete(id);
    this.atlasLayouts.delete(id);
    this.errorTextureIndices.delete(texIdx);
    for (const [elId, el] of this.elements) {
      if (el.textureIndex === texIdx) this.elements.delete(elId);
    }
    this.updateTextureBindings();
    this.updateInputRouterConfig();
    void this.ipc.destroyRenderer(id);
  }

  addPanel(config: OSRPanelConfig): void {
    void this.ipc?.addPanel(config);
  }

  removePanel(rendererId: string, panelId: string): void {
    void this.ipc?.removePanel(rendererId, panelId);
  }

  updatePanel(rendererId: string, panelId: string, html: string): void {
    void this.ipc?.updatePanel(rendererId, panelId, html);
  }

  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void {
    this.ipc?.updateData(rendererId, panelId, values);
  }

  setContent(rendererId: string, html: string): void {
    void this.ipc?.setContent(rendererId, html);
  }

  addElement(element: WorldSpaceUIElement): void {
    this.elements.set(element.id, element);
  }

  removeElement(id: string): void {
    this.elements.delete(id);
  }

  updateElements(elements: WorldSpaceUIElement[]): void {
    this.elements.clear();
    for (const el of elements) this.elements.set(el.id, el);
  }

  /** Pull dirty frames from the host and upload — call once per frame before
   *  render(). Cheap when clean (the cdylib returns null without rasterizing). */
  update(): void {
    if (!this.ipc) return;
    for (const source of this.sources.values()) {
      source.update(this.ipc);
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
    if (!this.ipc || typeof this.ipc.setSoftwareCursor !== "function") return;
    for (const id of this.rendererIds) this.ipc.setSoftwareCursor(id, enabled);
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
    for (const [id, s] of this.sources) list.push({ rendererId: id, textureView: s.getTextureView() });
    return list;
  }

  private updateTextureBindings(): void {
    this.renderPass.setTextures(this.getTextureList().map((t) => ({ textureView: t.textureView })));
  }

  private updateInputRouterConfig(): void {
    const textureIndexToRendererId = new Map<number, string>();
    for (let i = 0; i < this.rendererIds.length; i++) textureIndexToRendererId.set(i, this.rendererIds[i]);

    const rendererDimensions = new Map<string, { width: number; height: number }>();
    for (const id of this.rendererIds) {
      const s = this.sources.get(id);
      if (s) rendererDimensions.set(id, { width: s.width, height: s.height });
    }

    const config = {
      textureIndexToRendererId,
      atlasLayouts: this.atlasLayouts,
      rendererStatuses: this.rendererStatuses,
      rendererDimensions,
    };

    if (!this.inputRouter && this.ipc) {
      this.inputRouter = new OSRInputRouter(config, (rendererId, event) => {
        this.ipc?.sendInputEvent(rendererId, event);
      });
    } else {
      this.inputRouter?.updateConfig(config);
    }
  }
}
