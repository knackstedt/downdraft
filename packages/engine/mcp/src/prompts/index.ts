import type { PromptRegistration } from "../types";
import { createCreateScenePrompt } from "./create-scene";
import { createAddEntityPrompt } from "./add-entity";
import { createDebugFramePrompt } from "./debug-frame";

export function createPrompts(): PromptRegistration[] {
  return [
    ...createCreateScenePrompt(),
    ...createAddEntityPrompt(),
    ...createDebugFramePrompt(),
  ];
}
