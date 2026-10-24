import { createStore } from "zustand/vanilla";

// ============================================================================
// Central app store (zustand vanilla — `zustand` entry imports react, which
// is not installed).
// ============================================================================

export type TargetKind = "downdraft" | "cdp";
export type ChannelName = "mirror" | "cdp" | "mcp" | "feed" | "procfs";

export interface TargetInfo {
  /** Stable id: `pid-<pid>` for local targets. */
  id: string;
  pid: number;
  kind: TargetKind;
  /** Display name — process binary/script (or hello payload). */
  name: string;
  /** Secondary label — runtime binary + cwd basename (from /proc). */
  detail?: string;
  /** The session points at this process (embedded devtools surface). */
  isSelf?: boolean;
  status: "connecting" | "attached" | "degraded" | "lost";
  /** Which channels are live right now. */
  channels: Partial<Record<ChannelName, boolean>>;
  /** Channel-provided capability strings (eval, profile, heap, network, panels, plugins…). */
  caps: string[];
  /** MCP tool names exposed by the target (empty without an mcp channel). */
  mcpTools: string[];
  /** Mirror hello.panels provider list. */
  panels: { slot: number; name: string }[];
  /** Mirror hello.inspector method names. */
  inspectorMethods: string[];
  /** Thread list from mirror/CDP. */
  threads: { id: string; name: string; kind: number }[];
  /** Per-channel endpoint details for status UI. */
  endpoints: { label: string; url: string }[];
}

export type DockId = "bottom" | "right";

export interface DockState {
  /** Ordered tab ids currently docked here. */
  tabs: string[];
  active: string | null;
  /** Dock extent in px (bottom = height, right = width). */
  size: number;
  collapsed: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Main-area (top strip) fixed tabs. */
export const MAIN_TABS = ["console", "profiler", "threads", "sources", "world", "gpu", "plugins"] as const;

/** Provider names that roll up into the World tab — a downdraft game with a
 *  world/scene exposes at least one of these (or the get_world_state MCP tool). */
const WORLD_PANEL_NAMES = new Set(["sim", "scene", "target-state", "game", "world"]);

/** Does this target have anything the World tab can show? */
export function targetHasWorld(t: TargetInfo | null | undefined): boolean {
  if (!t) return false;
  return t.panels.some((p) => WORLD_PANEL_NAMES.has(p.name)) || t.mcpTools.includes("get_world_state");
}

/** MAIN_TABS minus tabs with nothing to show for the given target. */
export function mainTabsFor(t: TargetInfo | null | undefined): string[] {
  return MAIN_TABS.filter((id) => id !== "world" || targetHasWorld(t));
}

export interface AppState {
  running: boolean;
  /** Master visibility gate — the standalone viewer keeps this pinned true;
   *  an embedded overlay toggles it (F12). Hidden ⇒ no panel instances, no
   *  compositor output, no devtools input handling. */
  overlayVisible: boolean;
  windowW: number;
  windowH: number;
  dpr: number;

  sidebarWidth: number;
  /** Whether the targets sidebar doc is mounted/allocates width — embedded
   *  single-target mode hides it (self is pinned active; there's nothing
   *  to pick). */
  sidebarVisible: boolean;
  topbarHeight: number;
  /** Rect the main content occupies (right of sidebar, below tab strip,
   *  above bottom dock, left of right dock). */
  mainRect: Rect;
  /** Rect of the bottom dock body. */
  bottomRect: Rect;
  /** Rect of the right dock body. */
  rightRect: Rect;

  targets: TargetInfo[];
  activeTargetId: string | null;
  /** Bumped whenever target/channel/thread state changes — surfaces repaint. */
  targetsVersion: number;

  /** Active tab in the main strip. */
  mainTab: string;
  docks: Record<DockId, DockState>;

  /** Global UI zoom for GPU surfaces (Ctrl+= / Ctrl+-). */
  uiZoom: number;

  /** Sidebar manual-attach input row is open. */
  attachOpen: boolean;

  theme: "dark" | "light";

  /** Console surface → source viewer: jump to a file:line. */
  sourceRequest?: { url: string; line: number; col: number } | null;
  /** Threads surface → console: which thread the REPL targets. */
  consoleThread: string;

  /** Bumped to force surface repaints (entries, series, models updated in place). */
  consoleVersion: number;
  metricsVersion: number;
  eventsVersion: number;

  /** MCP/read-only accessors installed by subsystems. */
  uiState?: () => unknown;
  setTestState?: (params: Record<string, unknown>) => void | Promise<void>;
  worldState?: () => unknown;
}

export const store = createStore<AppState>(() => ({
  running: true,
  overlayVisible: true,
  windowW: 1600,
  windowH: 1000,
  dpr: 1,

  sidebarWidth: 230,
  sidebarVisible: true,
  topbarHeight: 30,
  mainRect: { x: 230, y: 30, w: 1370, h: 700 },
  bottomRect: { x: 230, y: 730, w: 1370, h: 270 },
  rightRect: { x: 0, y: 0, w: 0, h: 0 },

  targets: [],
  activeTargetId: null,
  targetsVersion: 0,

  mainTab: "console",
  docks: {
    bottom: { tabs: ["perfmon", "events", "network"], active: "perfmon", size: 250, collapsed: false },
    right: { tabs: ["source"], active: null, size: 420, collapsed: true },
  },
  uiZoom: 1,
  attachOpen: false,

  theme: "dark",
  consoleThread: "main",

  consoleVersion: 0,
  metricsVersion: 0,
  eventsVersion: 0,
}));

export function bumpTargets() {
  store.setState((s) => ({ targetsVersion: s.targetsVersion + 1 }));
}
export function bumpConsole() {
  store.setState((s) => ({ consoleVersion: s.consoleVersion + 1 }));
}
export function bumpMetrics() {
  store.setState((s) => ({ metricsVersion: s.metricsVersion + 1 }));
}
export function bumpEvents() {
  store.setState((s) => ({ eventsVersion: s.eventsVersion + 1 }));
}
