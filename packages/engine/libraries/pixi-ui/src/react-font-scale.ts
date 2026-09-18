// ============================================================================
// react-font-scale — pre-bound font-scale helpers for @pixi/react scenes.
//
// Games previously kept an identical 9-line font-scale-context.ts that called
// createFontScaleHelpers(React) and re-exported the pieces. This module does
// it once — inside the UI worker bundle, the game's React and this module's
// React resolve to the same instance, so the context is shared.
//
// Usage (inside the worker scene module / components):
//
//   import { FontScaleContext, useFontScale, ScaledText } from "@downdraft/engine/libraries/pixi-ui/react-font-scale";
//
// ============================================================================

import React from "react";
import { createFontScaleHelpers } from "./react";

const helpers = createFontScaleHelpers(React);

export const FontScaleContext = helpers.FontScaleContext;
export const useFontScale = helpers.useFontScale;
export const ScaledText = helpers.ScaledText;
