import type { PromptRegistration } from "../types.ts";
import { createCreateScenePrompt } from "./create-scene.ts";
import { createAddEntityPrompt } from "./add-entity.ts";
import { createDebugFramePrompt } from "./debug-frame.ts";

export function createPrompts(): PromptRegistration[] {
  return [
    ...createCreateScenePrompt(),
    ...createAddEntityPrompt(),
    ...createDebugFramePrompt(),
  ];
}
