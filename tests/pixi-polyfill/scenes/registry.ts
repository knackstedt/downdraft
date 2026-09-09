// ============================================================================
// registry.ts — Central scene registry.
//
// Import this module to get the full list of scenes. Add new scenes by
// importing them here and pushing into the array. The browser bundle and
// the native harness both import from here so they always render the same
// set of scenes.
// ============================================================================

import type { PixiScene } from "./types";
import { textScene } from "./text";

export const SCENES: PixiScene[] = [
  textScene,
];

export function getSceneById(id: string): PixiScene | undefined {
  return SCENES.find((s) => s.id === id);
}
