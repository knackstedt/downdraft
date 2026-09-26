// ============================================================================
// protocol.ts — message contract between the html-ui host (main thread) and
// the doc backend (ui worker, or in-process fallback). All panel-local
// coordinates are CSS px; the backend multiplies by the doc's scale.
// ============================================================================

import type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";

export type DocMutation =
  | { op: "text"; node?: number; sel?: string; text: string }
  | { op: "attr"; node?: number; sel?: string; name: string; value: string }
  | { op: "rattr"; node?: number; sel?: string; name: string }
  | { op: "style"; node?: number; sel?: string; prop: string; value: string }
  | { op: "innerHtml"; node?: number; sel?: string; html: string }
  | { op: "focus"; node?: number; sel?: string };

export type DocInputMsg =
  | { kind: "move"; x: number; y: number; mods?: string[] }
  | { kind: "down"; x: number; y: number; button?: "left" | "middle" | "right"; mods?: string[] }
  | { kind: "up"; x: number; y: number; button?: "left" | "middle" | "right"; mods?: string[] }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; mods?: string[] }
  | { kind: "key"; down: boolean; key: string; code?: string; text?: string; mods?: string[] };

/** Host → backend */
export type UiToWorker =
  | { type: "create"; id: string; cssW: number; cssH: number; scale: number; html: string; maxFps?: number }
  | { type: "fps"; id: string; maxFps: number }
  | { type: "setHtml"; id: string; html: string }
  | { type: "resize"; id: string; cssW: number; cssH: number; scale: number }
  | { type: "destroy"; id: string }
  | { type: "input"; id: string; msg: DocInputMsg }
  | { type: "mutate"; id: string; ops: DocMutation[] }
  | { type: "resource"; url: string; bytes: ArrayBuffer }
  | { type: "getAttr"; reqId: number; id: string; sel?: string; node?: number; name: string };

/** Backend → host */
export type WorkerToUi =
  | { type: "ready" }
  | { type: "frame"; id: string; x: number; y: number; w: number; h: number; pw: number; ph: number; pixels: ArrayBuffer }
  | { type: "events"; id: string; events: OsrDomEvent[] }
  | { type: "attr"; reqId: number; value: string | null }
  | { type: "error"; id?: string; message: string };
