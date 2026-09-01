// @downdraft/library-postfx — unified chainable WebGPU postprocessing
//
// Exports the PostProcessStack (21+ effects), the PostfxLib engine-library
// descriptor for declarative wiring in GameModule.libraries[], and the
// PostProcessStackTok typed DI token.
//
// Games import either declaratively:
//   import { PostfxLib } from "@downdraft/library-postfx";
//   startGame({ libraries: [PostfxLib], ... });
// or directly (escape hatch):
//   import { PostProcessStack } from "@downdraft/library-postfx";

export { PostProcessStack } from "./post-process-stack";
export type { EffectId, PostProcessStackOptions, ViewportRect } from "./post-process-stack";

// Engine library descriptor + typed DI token
export { PostfxLib, PostProcessStackTok } from "./library";
export type { PostfxLibConfig } from "./library";
