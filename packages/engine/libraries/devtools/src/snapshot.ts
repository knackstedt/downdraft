// ============================================================================
// snapshot.ts — transport-neutral devtools data model.
//
// Provider panels return a `PanelSnapshot` — a status plus sections of
// key/value rows, tables, f32 series, text lines, and interactive controls.
// Both frontends render the same model: WebDevtoolsMirror sends it as JSON
// over the devtools WebSocket; the Blitz devtools renders it into an
// html-ui document. Commands flow back the other way when the user
// activates a control.
// ============================================================================

export const SNAP_STATUS = { ok: 0, loading: 1, unsupported: 2, error: 3 } as const;
export type SnapshotStatus = keyof typeof SNAP_STATUS;

/** Row/line flag bits — header rows, warn/error styling. */
export const SNAP_FLAG = { header: 1, warn: 2, error: 4 } as const;

export interface SnapshotKvRow { key: string; value: string; flags?: number }
export interface SnapshotSeries { name: string; values: number[] | Float32Array }
export interface SnapshotLine { text: string; flags?: number }

export type SnapshotControl =
  | { type: "button"; id: string; label: string; payload?: string }
  | { type: "checkbox"; id: string; label: string; checked: boolean }
  | { type: "slider"; id: string; label: string; value: number; min: number; max: number };

export type SnapshotSection =
  | { kind: "kv"; name: string; rows: SnapshotKvRow[] }
  | { kind: "table"; name: string; cols: string[]; rows: string[][] }
  | { kind: "series"; name: string; series: SnapshotSeries[] }
  | { kind: "lines"; name: string; lines: SnapshotLine[] }
  | { kind: "controls"; name: string; controls: SnapshotControl[] };

export interface PanelSnapshot {
  status?: SnapshotStatus;
  statusMsg?: string;
  sections: SnapshotSection[];
}

/** A control activation routed back to the panel's command handler. */
export interface DevtoolsCommand {
  panel: number;
  action: string;
  payload: string;
}

// ── Panel slot ids ──
// Stable ids shared by every frontend (tab labels, provider registry,
// command routing). New engine panels append at the end; game panels use
// the "game" slot (or numeric slots ≥ 16 for bespoke panels).

export const PANEL = {
  console: 0,
  scene: 1,
  gpu: 2,
  "perf-recorder": 3,
  "perf-metrics": 4,
  "dom-tree": 5,
  sim: 6,
  memory: 7,
  "render-graph": 8,
  materials: 9,
  doctor: 10,
  workers: 11,
  input: 12,
  postfx: 13,
  assets: 14,
  game: 15,
} as const;
export type PanelName = keyof typeof PANEL;

// ── Provider registry surface ──

/** Provider callback — may return a snapshot synchronously or as a promise. */
export type PanelProvider = () => PanelSnapshot | null | undefined | Promise<PanelSnapshot | null | undefined>;
/** Command handler — receives control activations routed back from the UI. */
export type PanelCommandHandler = (cmd: DevtoolsCommand) => void | Promise<void>;
