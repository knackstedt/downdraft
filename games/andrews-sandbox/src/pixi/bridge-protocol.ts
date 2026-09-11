// ============================================================================
// Bridge Protocol — UI stats layout + action/event types for pixi-ui overlay
// ============================================================================

import type { ContentListItem } from "@andrews-sandbox/library-content";
import type { UiStatsLayout } from "@downdraft/library-pixi-ui";
import { FunMode, ToolType } from "@sandbox/shared/types";

export type { ContentListItem };

// ── UiStatsSAB layout — per-frame scalar slot names written by the renderer, read by UI ──
export const SANDBOX_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    "activeTool",
    "funMode",
    "pose",
    "propCount",
    "showBrowser",
    "showToolWheel",
    "showPaintPalette",
    "paintColorR",
    "paintColorG",
    "paintColorB",
    "paintSize",
    "paintHardness",
    // Graphics settings state (read by the UI panel)
    "showGraphics",
    "bloomEnabled",
    "bloomStrength",
    "bloomThreshold",
    "fxaaEnabled",
    "tonemapEnabled",
    "exposure",
    "vignetteEnabled",
    "vignetteStrength",
    "shadowsEnabled",
    "mipmapsEnabled",
    "pointLightsEnabled",
    "sunColorR",
    "sunColorG",
    "sunColorB",
    "ambientIntensity",
  ],
};

// ── Spawn settings (chosen in the browser's settings panel) ──
export interface SpawnSettings {
  mass: number;        // weight (wired → physics.mass)
  restitution: number; // bounce (wired → physics.restitution)
  friction: number;     // wired → physics.friction
  gravityScale: number; // wired → physics.gravityScale
  scale: number;        // wired → spawn scale
  shape: "box" | "sphere"; // wired → spawn shape
  /** Stub: durability/HP (not yet consumed). */
  strength: number;
  /** Stub: texture-override id (not yet applied). */
  texture: string;
  /** Stub: shader-override id (not yet applied). */
  shader: string;
}

// ── Actions (worker→main side effects) ──
export type SandboxAction =
  | { kind: "toggleContentBrowser" }
  | { kind: "closeBrowser" }
  | { kind: "selectContent"; contentId: string }
  | { kind: "toggleToolWheel" }
  | { kind: "setTool"; tool: ToolType }
  | { kind: "setFunMode"; mode: FunMode }
  | { kind: "spawn"; contentId: string; settings: SpawnSettings; count?: number }
  | { kind: "setPaintColor"; color: string }
  | { kind: "setPaintSize"; size: number }
  | { kind: "setPaintHardness"; hardness: number }
  | { kind: "saveGame" }
  | { kind: "loadGame" }
  | { kind: "clearProps" }
  // Graphics settings actions
  | { kind: "toggleGraphicsPanel" }
  | { kind: "setBloom"; enabled: boolean }
  | { kind: "setBloomStrength"; value: number }
  | { kind: "setBloomThreshold"; value: number }
  | { kind: "setFXAA"; enabled: boolean }
  | { kind: "setTonemap"; enabled: boolean }
  | { kind: "setExposure"; value: number }
  | { kind: "setVignette"; enabled: boolean }
  | { kind: "setVignetteStrength"; value: number }
  | { kind: "setShadows"; enabled: boolean }
  | { kind: "setMipmaps"; enabled: boolean }
  | { kind: "setPointLights"; enabled: boolean }
  | { kind: "setSunColor"; r: number; g: number; b: number }
  | { kind: "setAmbientIntensity"; value: number };

// ── Events (main→worker data updates) ──
// Posted via pixiHost.postEvent() which takes a PixiUiEvent ({ kind: string; ... }).
export type SandboxEvent =
  | { kind: "contentList"; items: ContentListItem[] }
  | { kind: "spawnCounts"; counts: Record<string, number> }
  | { kind: "toolChanged"; tool: ToolType }
  | { kind: "funModeChanged"; mode: FunMode };

