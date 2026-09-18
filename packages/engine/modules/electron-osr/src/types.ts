// ============================================================================
// Electron OSR Module — Shared Types
// ============================================================================

export type OSRRendererMode = "atlas" | "dedicated";

export type OSRSharedTexturePixelFormat = "rgba" | "bgra";

export interface OSRRendererConfig {
  id: string;
  mode: OSRRendererMode;
  width: number;
  height: number;
  /** Target draw frequency in Hz. Default 60. Clamped to display refresh rate. */
  frameRate: number;
  /** Pixel format of the shared texture. Default 'rgba'. */
  sharedTexturePixelFormat?: OSRSharedTexturePixelFormat;
  /** Max auto-recreate attempts on crash (dedicated mode). Default 3. */
  maxCrashRetries?: number;
  /** Enable GPU zero-copy shared texture path. Default true. Set false to force CPU path. */
  useSharedTexture?: boolean;
}

export interface OSRPanelConfig {
  id: string;
  rendererId: string;
  html: string;
  /** Fixed-size slot width in CSS pixels within the atlas. */
  width: number;
  /** Fixed-size slot height in CSS pixels within the atlas. */
  height: number;
}

export interface OSRDataUpdate {
  rendererId: string;
  panelId: string;
  values: Record<string, string | number | boolean>;
}

export type BillboardMode = 0 | 1 | 2;
export const BillboardMode = {
  ScreenAligned: 0 as BillboardMode,
  AxisAligned: 1 as BillboardMode,
  Fixed: 2 as BillboardMode,
};

export interface WorldSpaceUIElement {
  id: string;
  position: [number, number, number];
  size: [number, number];
  billboardMode: BillboardMode;
  /** Index into OSRManager's texture list. */
  textureIndex: number;
  /** UV offset within the texture (0..1). [0,0] for dedicated. */
  uvOffset: [number, number];
  /** UV scale within the texture (0..1). [1,1] for dedicated. */
  uvScale: [number, number];
}

export interface AtlasPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  panels: Map<string, AtlasPanelRect>;
}

export type OSRRendererStatus = "running" | "crashed" | "recovering" | "failed";

export interface OSRRendererEvent {
  rendererId: string;
  status: OSRRendererStatus;
  crashCount: number;
}

export interface OSRInputEvent {
  rendererId: string;
  type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseWheel" | "keyDown" | "keyUp";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  deltaX?: number;
  deltaY?: number;
  keyCode?: string;
  modifiers?: string[];
}

export interface OSRTextureHandle {
  rendererId: string;
  textureIndex: number;
  textureView: GPUTextureView;
}

/** IPC surface exposed via preload bridge. */
export interface OSRIPC {
  createRenderer(config: OSRRendererConfig): Promise<void>;
  destroyRenderer(id: string): Promise<void>;
  addPanel(config: OSRPanelConfig): Promise<AtlasPanelRect | null>;
  removePanel(rendererId: string, panelId: string): Promise<AtlasLayout | null>;
  updatePanel(rendererId: string, panelId: string, html: string): Promise<void>;
  updateData(rendererId: string, panelId: string, values: Record<string, string | number | boolean>): void;
  setContent(rendererId: string, html: string): Promise<void>;
  loadURL(rendererId: string, url: string): Promise<void>;
  sendInputEvent(rendererId: string, event: Omit<OSRInputEvent, "rendererId">): void;
  setSoftwareCursor(rendererId: string, enabled: boolean): void;
  onPanelLayout(cb: (rendererId: string, layout: AtlasLayout) => void): void;
  onRendererEvent(cb: (event: OSRRendererEvent) => void): void;
  onCursorStyle(cb: (rendererId: string, cursor: string) => void): void;
}
