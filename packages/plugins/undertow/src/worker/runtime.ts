// ============================================================================
// WorkerRuntime — worker-side counterpart to MainThreadHost. Owns the SAB
// views, encodes op requests into the request ring, awaits replies from the
// reply ring, and exposes a low-level `call()` API that the worker DOM
// classes (WorkerElement etc.) build on.
//
// Default call mode is async (Promise) via Atomics.waitAsync on the reply
// ring seq. A sync mode (Atomics.wait) is available for non-raf-phase calls
// but must not be used while the main thread is blocked on the worker.
// ============================================================================

import { growDomSab, readRegions, validateDomSab } from "../sab/dom-sab";
import { EventRing } from "../sab/event-ring";
import { PayloadHeap } from "../sab/payload-heap";
import { ReplyRing } from "../sab/reply-ring";
import { RequestRing } from "../sab/request-ring";
import { StringPool } from "../sab/string-pool";
import * as ids from "../shared/op-ids";
import type { ArgValue } from "../shared/op-table";
import { decodePayload, encodePayload } from "../shared/payload-codec";
import {
    ArgKind,
    CONTROL_BYTES,
    CTL_DIRECTION_IDX,
    CTL_POINTER_LOCKED_IDX,
    f64ToLoHi,
    loHiToF64,
    OP_ARG0_OFF,
    OP_ARG1_OFF,
    OP_ARGCOUNT_OFF,
    OP_ARGKIND0_OFF,
    OP_ARGKIND1_OFF,
    OP_HANDLE_OFF,
    OP_MAX_INLINE_ARGS,
    OP_OPID_OFF,
    OP_REQID_OFF,
    REPLY_PAYLOADLEN_OFF,
    REPLY_PAYLOADOFF_OFF,
    REPLY_REQID_OFF,
    REPLY_RESULT_OFF,
    REPLY_RESULTKIND_OFF
} from "../shared/protocol";
import { EventPump } from "./event-pump";

export type CallMode = "async" | "sync";

export interface CallResult {
  kind: number;
  value: ArgValue; // decoded JS value (number, boolean, string, null, handle id, payload)
  error?: string;
}

export class WorkerRuntime {
  readonly sab: SharedArrayBuffer;
  private readonly regions: ReturnType<typeof readRegions>;
  private readonly reqRing: RequestRing;
  private readonly replyRing: ReplyRing;
  readonly eventRing: EventRing;
  private readonly heap: PayloadHeap;
  readonly pool: StringPool;
  private readonly controlI32: Int32Array;
  private reqId = 0;
  private readonly pending: Map<number, { resolve: (r: CallResult) => void; reject: (e: Error) => void }> = new Map();
  readonly eventPump: EventPump;
  /** Set by installPolyfill — the worker-side document proxy. */
  document: any = null;
  /** Set by installPolyfill — the worker-side window proxy. */
  window: any = null;
  /** Re-entrancy guard for event pump draining inside callSync. */
  private drainingEvents = false;
  private rafIdCounter = 0;
  private readonly rafCallbacks: Map<number, (time: number) => void> = new Map();
  /** Per-runtime handle cache — ensures the same handle always returns the same
   *  JS object. Must be per-runtime (not module-level) so that re-creating the
   *  runtime (e.g. hot-reload, test isolation) doesn't return stale objects. */
  readonly handleCache: Map<number, any> = new Map();
  /** Per-runtime node type cache — avoids a callSync round-trip for nodeType. */
  readonly nodeTypeCache: Map<number, number> = new Map();

  constructor(sab: SharedArrayBuffer) {
    if (!validateDomSab(sab)) {
      throw new Error("[worker-dom] WorkerRuntime: SAB failed validation");
    }
    this.sab = sab;
    this.regions = readRegions(sab);
    this.reqRing = new RequestRing(sab, this.regions);
    this.replyRing = new ReplyRing(sab, this.regions);
    this.eventRing = new EventRing(sab, this.regions);
    this.heap = new PayloadHeap(sab, this.regions);
    this.pool = new StringPool(sab, this.regions);
    this.controlI32 = new Int32Array(sab, 0, CONTROL_BYTES / 4);
    this.eventPump = new EventPump(this);
  }

  /**
   * Issue an op call. Default mode is async (returns a Promise). Sync mode
   * blocks the worker via Atomics.wait until the reply arrives — only safe
   * when the main thread is not waiting on the worker.
   */
  call(opId: number, handle: number, args: ArgValue[] = [], mode: CallMode = "async"): Promise<CallResult> {
    const id = ++this.reqId;
    // Encode args into the request record.
    this.encodeRequest(id, opId, handle, args);

    if (mode === "sync") {
      // Block until the reply arrives. Only call from a non-raf phase.
      const result = this.waitSyncForReply(id);
      return Promise.resolve(result);
    }

    // Async: register pending, then waitAsync on the reply ring seq.
    return new Promise<CallResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Kick the waiter: poll the reply ring once now, then waitAsync for more.
      this.drainReplies();
      if (this.pending.has(id)) {
        // Not yet resolved — arm the async wait.
        const seq = this.replyRing.getSeq();
        this.replyRing.waitAsync(seq, 5000).then((woke) => {
          if (this.pending.has(id)) this.drainReplies();
        });
      }
    });
  }

  /**
   * Synchronous op call — blocks the worker via Atomics.wait until the main
   * thread drains and writes a reply. Returns the result directly (not a Promise).
   * Use this for DOM operations that React calls synchronously.
   *
   * WARNING: The main thread must be running its event loop (not blocked) or
   * this will deadlock.
   */
  callSync(opId: number, handle: number, args: ArgValue[] = []): CallResult {
    const id = ++this.reqId;
    this.encodeRequest(id, opId, handle, args);
    const t0 = performance.now();
    const result = this.waitSyncForReply(id);
    const waitMs = performance.now() - t0;
    // Log slow sync calls (>10ms) to diagnose latency
    if (waitMs > 10 && this._syncDiag) {
      this._syncDiag.count++;
      this._syncDiag.totalMs += waitMs;
      if (this._syncDiag.count <= 10 || this._syncDiag.count % 100 === 0) {
        console.log(`[runtime] SLOW sync #${this._syncDiag.count}: ${waitMs.toFixed(1)}ms opId=${opId} handle=${handle} (total=${this._syncDiag.totalMs.toFixed(0)}ms)`);
      }
    }
    // Check the pointer lock flag in the SAB — the main thread writes this
    // directly (postMessage would be stuck while we're blocked on Atomics.wait).
    this.checkPointerLockFlag();
    // Drain pending events periodically (every 32nd call) rather than after
    // every callSync. With event coalescing on the main thread, events arrive
    // at most once per rAF, so we don't need to drain as aggressively. Draining
    // after every call adds significant overhead during React render bursts.
    if ((id & 31) === 0 && !this.drainingEvents) {
      this.drainingEvents = true;
      try { this.eventPump.drain(); } catch { /* ignore */ }
      this.drainingEvents = false;
    }
    return result;
  }

  /** Sync call diagnostics — enabled by default, disable to skip timing overhead. */
  private _syncDiag: { count: number; totalMs: number } | null = { count: 0, totalMs: 0 };

  /**
   * Fire-and-forget op call. Pushes the request but doesn't block for the reply.
   * The main thread will process it and write a void reply, which we drain later.
   * Use this for ops that return void and don't need synchronous completion
   * (e.g., addEventListener, removeEventListener).
   */
  callFireAndForget(opId: number, handle: number, args: ArgValue[] = []): void {
    const id = ++this.reqId;
    this.encodeRequest(id, opId, handle, args);
    // Drain any pending replies to keep the reply ring clear.
    this.drainReplies();
  }

  /** Release a handle (GC). Fire-and-forget; no reply expected by callers. */
  release(handle: number): void {
    // Encode as an OP_RELEASE with the handle as arg0. The host intercepts it.
    const id = ++this.reqId;
    const slot = this.reqRing.tryPush();
    if (slot === null) {
      // Ring full — skip release (handle leaks on main until next release batch).
      return;
    }
    const u32 = this.reqRing.slotU32(slot);
    u32[OP_OPID_OFF / 4] = 0; // OP_RELEASE
    u32[OP_HANDLE_OFF / 4] = 0;
    u32[OP_ARGCOUNT_OFF / 4] = 1;
    u32[OP_ARGKIND0_OFF / 4] = ArgKind.Handle;
    u32[OP_ARG0_OFF / 4] = handle;
    u32[OP_REQID_OFF / 4] = id;
    this.reqRing.publish(slot);
    // We still drain the (void) reply to keep the reply ring clear.
    this.drainReplies();
  }

  // --- requestAnimationFrame ---
  // The worker's rAF is proxied to the main thread. To avoid flooding the
  // SAB IPC bridge with one round-trip per rAF callback (8+ Solid components
  // each have their own rAF loop), we coalesce ALL pending rAF requests into
  // a single main-thread rAF. Only one OP_WINDOW_REQUEST_ANIMATION_FRAME is
  // sent per frame; when the reply arrives, all pending callbacks fire.
  private rafPending = false;
  requestAnimationFrame(callback: (time: number) => void): number {
    const rafId = ++this.rafIdCounter;
    this.rafCallbacks.set(rafId, callback);
    // If we already have a pending main-thread rAF request, don't send another.
    // The callback will fire when the existing request's reply arrives.
    if (this.rafPending) return rafId;
    this.rafPending = true;
    this.call(ids.OP_WINDOW_REQUEST_ANIMATION_FRAME, 4 /* HANDLE_WINDOW */, []).then(() => {
      // Main thread rAF fired — fire ALL pending callbacks, not just this one.
      this.rafPending = false;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      // Snapshot the callbacks and clear the map first, so callbacks that
      // call requestAnimationFrame again during the fire are queued for the
      // NEXT frame, not the current one.
      const callbacks = Array.from(this.rafCallbacks.values());
      this.rafCallbacks.clear();
      for (const cb of callbacks) {
        try { cb(now); } catch (e) { console.error("[runtime] rAF callback error:", e); }
      }
    }).catch(() => {
      this.rafPending = false;
      this.rafCallbacks.clear();
    });
    return rafId;
  }

  cancelAnimationFrame(rafId: number): void {
    this.rafCallbacks.delete(rafId);
    // No need to send a cancel OP to the main thread — the coalesced
    // approach means we just don't fire this callback when the reply arrives.
  }

  private encodeRequest(reqId: number, opId: number, handle: number, args: ArgValue[]): void {
    // Try to push; if full, the host should be draining. Spin briefly.
    let slot = this.reqRing.tryPush();
    if (slot === null) {
      for (let i = 0; i < 1000 && slot === null; i++) slot = this.reqRing.tryPush();
      if (slot === null) {
        throw new Error(`[worker-dom] request ring full; opId=${opId}`);
      }
    }
    const u32 = this.reqRing.slotU32(slot);
    u32[OP_OPID_OFF / 4] = opId;
    u32[OP_HANDLE_OFF / 4] = handle;

    if (args.length <= OP_MAX_INLINE_ARGS) {
      u32[OP_ARGCOUNT_OFF / 4] = args.length;
      for (let i = 0; i < args.length; i++) {
        const kindOff = i === 0 ? OP_ARGKIND0_OFF / 4 : OP_ARGKIND1_OFF / 4;
        const valOff = i === 0 ? OP_ARG0_OFF / 4 : OP_ARG1_OFF / 4;
        this.encodeInlineArg(u32, kindOff, valOff, args[i]);
      }
    } else {
      // Spill: encode all args as a single array blob in the payload heap.
      const blob = encodePayload(args as ArgValue[]);
      let off = 0;
      try {
        off = this.heap.writeBytes(blob);
      } catch {
        growDomSab(this.sab, this.sab.byteLength + blob.length + 4096);
        off = this.heap.writeBytes(blob);
      }
      u32[OP_ARGCOUNT_OFF / 4] = args.length;
      u32[OP_ARGKIND0_OFF / 4] = ArgKind.PayloadRef;
      u32[OP_ARG0_OFF / 4] = off;
      u32[OP_ARGKIND1_OFF / 4] = ArgKind.U32;
      u32[OP_ARG1_OFF / 4] = blob.length;
    }

    u32[OP_REQID_OFF / 4] = reqId;
    this.reqRing.publish(slot);
  }

  private encodeInlineArg(u32: Uint32Array, kindIdx: number, valIdx: number, v: ArgValue): void {
    if (v === null || v === undefined) {
      u32[kindIdx] = ArgKind.Null;
    } else if (v === true) {
      u32[kindIdx] = ArgKind.Bool;
      u32[valIdx] = 1;
    } else if (v === false) {
      u32[kindIdx] = ArgKind.Bool;
      u32[valIdx] = 0;
    } else if (typeof v === "number") {
      if (Number.isInteger(v) && v >= -0x80000000 && v <= 0xffffffff) {
        u32[kindIdx] = ArgKind.I32;
        u32[valIdx] = v | 0;
      } else {
        // f64 — spans two slots (lo in valIdx, hi in valIdx+2 skipping next kind).
        u32[kindIdx] = ArgKind.F64;
        const [lo, hi] = f64ToLoHi(v);
        u32[valIdx] = lo;
        u32[valIdx + 2] = hi;
      }
    } else if (typeof v === "string") {
      u32[kindIdx] = ArgKind.StringAtom;
      u32[valIdx] = this.pool.intern(v);
    } else {
      // Complex value — spill to payload, reference inline.
      const blob = encodePayload(v);
      let off = 0;
      try {
        off = this.heap.writeBytes(blob);
      } catch {
        growDomSab(this.sab, this.sab.byteLength + blob.length + 4096);
        off = this.heap.writeBytes(blob);
      }
      u32[kindIdx] = ArgKind.PayloadRef;
      u32[valIdx] = off;
      u32[valIdx + 2] = blob.length;
    }
  }

  /** Drain any replies that have arrived, resolving pending promises. */
  drainReplies(): void {
    let slot = this.replyRing.tryPop();
    while (slot !== null) {
      const u32 = this.replyRing.slotU32(slot);
      const reqId = u32[REPLY_REQID_OFF / 4];
      const result = this.decodeReply(u32);
      this.replyRing.release(slot);
      const p = this.pending.get(reqId);
      if (p) {
        this.pending.delete(reqId);
        if (result.kind === ArgKind.Error) p.reject(new Error(result.error ?? "unknown error"));
        else p.resolve(result);
      }
      slot = this.replyRing.tryPop();
    }
  }

  private decodeReply(u32: Uint32Array): CallResult {
    const kind = u32[REPLY_RESULTKIND_OFF / 4] as number;
    const raw = u32[REPLY_RESULT_OFF / 4];
    const payloadOff = u32[REPLY_PAYLOADOFF_OFF / 4];
    const payloadLen = u32[REPLY_PAYLOADLEN_OFF / 4];

    switch (kind) {
      case ArgKind.Void:
        return { kind, value: null };
      case ArgKind.Bool:
        return { kind, value: raw !== 0 };
      case ArgKind.I32:
        return { kind, value: raw | 0 };
      case ArgKind.U32:
        return { kind, value: raw >>> 0 };
      case ArgKind.F32: {
        const f32buf = new Uint32Array(1);
        f32buf[0] = raw;
        return { kind, value: new Float32Array(f32buf.buffer)[0] };
      }
      case ArgKind.F64: {
        const hi = payloadOff; // hi bits stored in payloadOff slot
        return { kind, value: loHiToF64(raw, hi) };
      }
      case ArgKind.Handle:
        return { kind, value: raw };
      case ArgKind.StringAtom:
        return { kind, value: this.pool.resolve(raw) ?? "" };
      case ArgKind.PayloadRef: {
        const bytes = new Uint8Array(this.sab, payloadOff, payloadLen);
        return { kind, value: decodePayload(bytes) };
      }
      case ArgKind.Error: {
        const bytes = new Uint8Array(this.sab, payloadOff, payloadLen);
        const msg = decodePayload(bytes);
        return { kind, value: null, error: typeof msg === "string" ? msg : String(msg) };
      }
      default:
        return { kind: ArgKind.Void, value: null };
    }
  }

  private waitSyncForReply(reqId: number): CallResult {
    // Spin + Atomics.wait on the reply ring seq until our reply arrives.
    // Only safe when the main thread is not blocked on the worker.
    while (true) {
      let slot = this.replyRing.tryPop();
      while (slot !== null) {
        const u32 = this.replyRing.slotU32(slot);
        const id = u32[REPLY_REQID_OFF / 4];
        const result = this.decodeReply(u32);
        this.replyRing.release(slot);
        if (id === reqId) return result;
        // Not ours — resolve any other pending.
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (result.kind === ArgKind.Error) p.reject(new Error(result.error ?? "unknown error"));
          else p.resolve(result);
        }
        slot = this.replyRing.tryPop();
      }
      // Block briefly waiting for more replies.
      const seq = this.replyRing.getSeq();
      this.replyRing.wait(seq, 1000);
    }
  }

  /** Direction flag access (for deadlock guards). */
  setDirection(v: number): void { Atomics.store(this.controlI32, CTL_DIRECTION_IDX, v); }
  getDirection(): number { return Atomics.load(this.controlI32, CTL_DIRECTION_IDX); }

  /**
   * Check the pointer lock flag in the SAB and update the worker's state if it
   * changed. The main thread writes this flag directly (bypassing postMessage,
   * which would be stuck while the worker is blocked on Atomics.wait).
   */
  private lastPointerLocked: boolean = false;
  /** Check the SAB pointer lock flag and update state if changed. Public for setInterval. */
  checkPointerLockFlag(): void {
    const locked = Atomics.load(this.controlI32, CTL_POINTER_LOCKED_IDX) !== 0;
    if (locked !== this.lastPointerLocked) {
      this.lastPointerLocked = locked;
      const doc = this.document;
      if (doc?._setPointerLocked) doc._setPointerLocked(locked);
      if (this._onPointerLockChange) this._onPointerLockChange(locked);
    }
  }
  /** Callback set by the store bridge when pointer lock changes via SAB flag. */
  _onPointerLockChange: ((locked: boolean) => void) | null = null;
}
