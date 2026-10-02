// ============================================================================
// @downdraft/engine/libraries/asset-browser — thumbnail rasterization for
// asset/content browsers.
//
// Games render their own asset-browser UI via html-ui panels (see
// andrews-sandbox's browser-ui.ts and the model viewer's
// native-browser-html.tsx); this library provides the off-thread model
// thumbnail rasterizer those UIs use to fill `ui://` image resources.
// ============================================================================

export { SoftwareThumbnailRenderer, type SoftwareThumbnailOptions } from "./software-thumbnails";
