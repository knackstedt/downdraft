// Factory wrapper for the ProfilerScene — the pixi-ui worker expects a
// factory function (called without `new`), not a class constructor.
import type { PixiUiScene, PixiUiSceneContext } from "@downdraft/library-pixi-ui/scene";
import { ProfilerScene } from "@downdraft/library-profiler/profiler-scene";

export default function createProfilerScene(ctx: PixiUiSceneContext): PixiUiScene {
  return new ProfilerScene(ctx);
}
