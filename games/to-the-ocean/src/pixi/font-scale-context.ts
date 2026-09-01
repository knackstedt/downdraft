// Shared font-scale helpers for the to-the-ocean @pixi/react scene.
// Initialized by pixi-scene.tsx; components import ScaledText from here.
import React from "react";
import { createFontScaleHelpers } from "@downdraft/library-pixi-ui/react";

const helpers = createFontScaleHelpers(React);
export const FontScaleContext = helpers.FontScaleContext;
export const useFontScale = helpers.useFontScale;
export const ScaledText = helpers.ScaledText;
