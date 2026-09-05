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
    "propCount",
    "showBrowser",
    "showToolWheel",
    "showPaintPalette",
    "paintColorR",
    "paintColorG",
    "paintColorB",
    "paintSize",
    "paintHardness",
  ],
};

// ── Actions (worker→main side effects) ──
export type SandboxAction =
  | { kind: "toggleContentBrowser" }
  | { kind: "toggleToolWheel" }
  | { kind: "setTool"; tool: ToolType }
  | { kind: "setFunMode"; mode: FunMode }
  | { kind: "spawn"; contentId: string }
  | { kind: "setPaintColor"; color: string }
  | { kind: "setPaintSize"; size: number }
  | { kind: "setPaintHardness"; hardness: number }
  | { kind: "saveGame" }
  | { kind: "loadGame" }
  | { kind: "clearProps" };

// ── Events (main→worker data updates) ──
export type SandboxEvent =
  | { type: "contentList"; items: ContentListItem[] }
  | { type: "toolChanged"; tool: ToolType }
  | { type: "funModeChanged"; mode: FunMode };

