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
  | { op: "focus"; node?: number; sel?: string }
  | { op: "scrollIntoView"; node?: number; sel?: string; smooth?: boolean; vertical?: "start" | "center" | "end" | "nearest"; horizontal?: "start" | "center" | "end" | "nearest" }
  /** Absolute scroll offsets on a scroll container — reaches nested
   *  scrollports (scrollIntoView only moves the root viewport). */
  | { op: "scrollTo"; node?: number; sel?: string; x: number; y: number; smooth?: boolean }
  /** Synthetic click at the node's rect center — drives the real
   *  pointer/click event pipeline (data-action handlers included). */
  | { op: "click"; node?: number; sel?: string };

export type DocInputMsg =
  | { kind: "move"; x: number; y: number; mods?: string[] }
  | { kind: "down"; x: number; y: number; button?: "left" | "middle" | "right"; mods?: string[] }
  | { kind: "up"; x: number; y: number; button?: "left" | "middle" | "right"; mods?: string[] }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; mods?: string[] }
  | { kind: "key"; down: boolean; key: string; code?: string; text?: string; mods?: string[] };

/** Pointer subset of DocInputMsg — what UiPanelHandle.sendPointer accepts. */
export type UiPointerMsg = Extract<DocInputMsg, { kind: "move" | "down" | "up" | "wheel" }>;

/** One focusable node's nav metadata (navSnapshot reply). */
export interface NavNodeInfo {
  node: number;
  /** Panel-local CSS px; null = not laid out / display:none. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Enclosing `data-nav-zone` value, or null. */
  zone: string | null;
  disabled: boolean;
  /** True for <input>/<textarea> (drives OSK / typing behavior). */
  editable: boolean;
}

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
  | { type: "getAttr"; reqId: number; id: string; sel?: string; node?: number; name: string }
  | { type: "getRect"; reqId: number; id: string; sel?: string; node?: number }
  /** Selector → all matching node handles (for spatial nav enumeration). */
  | { type: "queryAll"; reqId: number; id: string; sel: string }
  /** Batched rect lookup — one roundtrip for a node set. */
  | { type: "getRects"; reqId: number; id: string; nodes: number[] }
  /** Currently-focused node handle (0 = none). */
  | { type: "getFocused"; reqId: number; id: string }
  /** One-shot nav snapshot: for every node matching `sel`, return rect,
   *  enclosing data-nav-zone id, disabled and editable state. */
  | { type: "navSnapshot"; reqId: number; id: string; sel: string }
  /** Host detected a torn SAB frame read — re-emit the current pixels. */
  | { type: "refresh"; id: string }
  /** Attach the engine ProfilingSAB — the worker claims a metrics slot so the
   *  devtools perf tab can see it. Best-effort; ignored when profiling is off. */
  | { type: "profilingAttach"; sab: SharedArrayBuffer; workerTag: string; layout?: { maxSlots: number; iopsRingCap: number; warningRingCap: number; stringTableCap: number } }
  /**
   * Attach to the host's shared wgpu device (native only). `gpu` is the
   * GpuDeviceHandle from the host's GpuShareBroker — declared structurally
   * here because platform-native is an optional peer. Once attached, the
   * worker uploads panel frames straight into bound textures via
   * queue.writeTexture instead of emitting pixels/SAB headers.
   */
  | { type: "gpuAttach"; gpu: { devicePtr: number | bigint; instancePtr: number | bigint; queuePtr: number | bigint; generation: number }; cells: SharedArrayBuffer }
  /** Detach the shared-device view — sent before the host terminates the
   *  worker so the broker's retire() doesn't stall on a stuck attach count. */
  | { type: "gpuDetach" }
  /**
   * Bind a doc's upload target. The host owns the texture (created on the
   * main thread); the worker wraps `texPtr` non-owningly (borrowGpuTexture)
   * and queue.writeTextures dirty rects into it. Sent at mount, again after
   * every resize (rebind), and never on the SAB fallback path.
   */
  | { type: "texBind"; id: string; texPtr: number | bigint; w: number; h: number; format: string };

/** Backend → host */
export type WorkerToUi =
  | { type: "ready" }
  /**
   * A frame is ready. Three shapes:
   *  - pixel-carrying (`pixels` present): `w*h*4` tightly-packed RGBA bytes to
   *    upload at (x, y). Used when no SharedArrayBuffer channel is bound.
   *  - SAB (`seq` present): the backend wrote the dirty rect into the bound
   *    buffer at `stride`-aligned rows — the host reads pixels itself.
   *  - GPU-direct (`gpu: true`): the worker already queue.writeTextured the
   *    dirty rect into the bound panel texture — stats/bookkeeping only.
   */
  | { type: "frame"; id: string; x: number; y: number; w: number; h: number; pw: number; ph: number; pixels?: ArrayBuffer; seq?: number; stride?: number; gpu?: boolean }
  /** Bind/rebind the per-doc SAB frame staging buffer (sent before first frame). */
  | { type: "bind"; id: string; buf: SharedArrayBuffer }
  /** Result of a gpuAttach attempt — ok:false keeps the SAB path. */
  | { type: "gpuReady"; ok: boolean }
  /** Ack of gpuDetach — the host may now terminate the worker. */
  | { type: "gpuDetached" }
  /**
   * The worker dropped its borrowed wrapper for `texPtr` — sent when a
   * texBind replaces the previous target or a doc is destroyed. The host
   * defers destroying a bound texture until this ack (or a fallback timer)
   * so a writeTexture can't be in flight on the freed handle.
   */
  | { type: "texAck"; id: string; texPtr: number | bigint }
  | { type: "events"; id: string; events: OsrDomEvent[] }
  | { type: "attr"; reqId: number; value: string | null }
  | { type: "rect"; reqId: number; rect: { x: number; y: number; w: number; h: number } | null }
  | { type: "nodes"; reqId: number; nodes: number[] }
  | { type: "rects"; reqId: number; rects: ({ x: number; y: number; w: number; h: number } | null)[] }
  | { type: "focused"; reqId: number; node: number }
  | { type: "navNodes"; reqId: number; nodes: NavNodeInfo[] }
  | { type: "stats"; id: string; frames: number; resolveMs: number; paintMs: number; diffMs: number; bytes: number }
  | { type: "error"; id?: string; message: string };
