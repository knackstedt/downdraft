// ============================================================================
// @downdraft/engine/libraries/asset-browser — tabbed, thumbnail-grid asset
// browser for pixi-ui surfaces.
//
// Shared by games that need a GMod-style "browse → preview → activate"
// content picker: pack tabs, category chips, live-search, a virtualized card
// grid with spinning 3D model thumbnails, keyboard navigation, and a
// pluggable right-hand panel (spawn settings, model details, ...).
//
// Rendering backends:
//   - ThumbnailRenderer: WebGL2 OffscreenCanvas (pixi-ui worker / Electron)
//   - SoftwareThumbnailRenderer: CPU rasterizer (native — no WebGL2)
// Both are injected via PixiUiSceneContext.sceneConfig.createThumbnailRenderer
// or the scene config's `thumbnailBackend`.
//
// Usage (native, in-process):
//   const pixi = new NativePixiUiHost({ device, adapter, targetFormat, ... });
//   const scene = createAssetBrowserScene(sceneCtx, config, handlers);
//   // per frame: scene.update({...}); pixi.render(); blitPass.execute(...);
// ============================================================================

export { createAssetBrowserScene } from "./scene";
export { createSidePanelUi } from "./side-panel";
export { SoftwareThumbnailRenderer, type SoftwareThumbnailOptions } from "./software-thumbnails";
export { ThumbnailRenderer, type ThumbnailRendererOptions } from "./thumbnail-renderer";
export { PixiEventForwarder, eventModifiers, type PixiInputHost } from "./native-input";
export type {
  AssetBrowserConfig,
  AssetBrowserHandlers,
  AssetBrowserItem,
  AssetBrowserScene,
  SidePanelContext,
  SidePanelUi,
  ThumbnailBackend,
  ThumbKind,
} from "./types";
