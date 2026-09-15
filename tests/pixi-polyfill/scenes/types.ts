// ============================================================================
// types.ts — Shared scene contract for the pixi-polyfill test suite.
//
// A "scene" is a pure function that builds a PixiJS scene tree on a container
// using only PixiJS primitives (Graphics, Text, Container). The SAME scene
// definition is rendered two ways:
//
//   1. Browser  — PixiJS v8 WebGPU in headless Chrome (Playwright). This is
//                 the *reference* rendering.
//   2. Native   — PixiJS v8 WebGPU on wgpu-native via NativePixiUiHost. This
//                 is the *polyfill* rendering under test.
//
// Both render targets are captured as PNGs and compared pixel-by-pixel.
//
// Font note: the native FreeType rasterizer always uses DejaVuSans.ttf and
// ignores fontFamily/weight/italic. To keep the browser reference matching,
// scenes should use fontFamily "DejaVu Sans" (loaded via @font-face in the
// browser harness) and avoid bold/italic unless a matching TTF variant is
// registered for the native side too.
// ============================================================================

import type { Container } from "pixi.js";

export interface SceneContext {
  /** Render-target width in pixels. */
  width: number;
  /** Render-target height in pixels. */
  height: number;
}

export interface PixiScene {
  /** Stable id used in URLs, filenames, and test names. */
  id: string;
  /** Human-readable name shown in test output. */
  name: string;
  /** Category for grouping (text, graphics, components, ...). */
  category: string;
  /** Short description of what the scene exercises. */
  description: string;
  /** Render-target width. Defaults to 512. */
  width?: number;
  /** Render-target height. Defaults to 512. */
  height?: number;
  /**
   * Background color (0xRRGGBB). Both renderers clear to this color so the
   * comparison is not affected by alpha-compositing differences. Defaults
   * to 0x1a1a2e (dark slate).
   */
  background?: number;
  /**
   * Build the scene tree on the given root container. Called once after the
   * renderer is initialized. Must be deterministic (no randomness, no
   * time-dependent animation state).
   */
  build(root: Container, ctx: SceneContext): void;
}

/** Default render-target size. */
export const DEFAULT_WIDTH = 512;
export const DEFAULT_HEIGHT = 512;

/** Default background color (dark slate). */
export const DEFAULT_BACKGROUND = 0x1a1a2e;

/** Font family used by all scenes — matches the native FreeType face. */
export const FONT_FAMILY = "DejaVu Sans";
