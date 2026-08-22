// ============================================================================
// MainThreadHost — owns the dom-sab, handle table, op-map, string pool, and
// payload heap on the main thread. Drains the request ring, dispatches each
// op via the op-table, and writes replies into the reply ring.
//
// The host is driven by a `drain()` call, typically invoked on raf (or on
// Atomics.notify from the worker). One drain processes all currently-queued
// requests. Async exec results are written when they resolve.
// ============================================================================

import { allocateDomSab, growDomSab, readRegions, validateDomSab, type DomSabOptions } from "../sab/dom-sab";
import { EventRing } from "../sab/event-ring";
import { PayloadHeap } from "../sab/payload-heap";
import { ReplyRing } from "../sab/reply-ring";
import { RequestRing } from "../sab/request-ring";
import { StringPool } from "../sab/string-pool";
import * as ids from "../shared/op-ids";
import {
    buildOpMap,
    type ArgValue,
    type DecodedArgs,
    type MainExecCtx,
    type OpEntry,
    type Result,
} from "../shared/op-table";
import "../shared/ops"; // register op entries as a side effect
import { decodePayload, encodePayload } from "../shared/payload-codec";
import {
    ArgKind,
    CONTROL_BYTES,
    CTL_DIRECTION_IDX,
    EVENT_FLAGS_OFF,
    EVENT_HANDLE_OFF,
    EVENT_PAYLOADLEN_OFF,
    EVENT_PAYLOADOFF_OFF,
    EVENT_SEQ_OFF,
    EVENT_TYPEATOM_OFF,
    f64ToLoHi,
    HANDLE_WINDOW,
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
    REPLY_RESULTKIND_OFF,
} from "../shared/protocol";
import { EventDispatcher } from "./event-dispatcher";
import { HandleTable } from "./handle-table";

export interface MainThreadHostOptions extends DomSabOptions {
  document?: Document;
  window?: Window;
}

export class MainThreadHost {
  readonly sab: SharedArrayBuffer;
  private readonly regions: ReturnType<typeof readRegions>;
  private readonly reqRing: RequestRing;
  private readonly replyRing: ReplyRing;
  readonly eventRing: EventRing;
  private readonly heap: PayloadHeap;
  private readonly pool: StringPool;
  private readonly handles: HandleTable;
  private readonly events: EventDispatcher;
  /** Exposed for user-gesture callbacks (pointer lock, etc.) */
  readonly eventDispatcher: EventDispatcher;
  private readonly opMap: Map<number, OpEntry>;
  private readonly ctx: MainExecCtx;
  private readonly controlI32: Int32Array;
  private draining = false;
  private rafCounter = 0;
  private readonly pendingRaf: Map<number, number> = new Map();
  private readonly cancelledRaf: Set<number> = new Set();
  private rafScheduled = false; // coalesced rAF: only one real rAF pending at a time
  private readonly layoutTracked: Set<number> = new Set();
  private layoutWriter: { track(h: number): unknown; untrack(h: number): unknown } | null = null;
  private readonly win: Window;
  private readonly doc: Document;
  /** High-frequency drain interval — ensures the request ring is drained every
   *  4ms regardless of rAF or waitAsync timing. This is the reliable fallback
   *  that prevents 1000ms callSync stalls when waitAsync+MessageChannel is
   *  starved by main-thread work. */
  private drainIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: MainThreadHostOptions = {}) {
    this.sab = allocateDomSab(options);
    if (!validateDomSab(this.sab)) {
      throw new Error("[worker-dom] MainThreadHost: allocated SAB failed validation");
    }
    this.regions = readRegions(this.sab);

    this.reqRing = new RequestRing(this.sab, this.regions);
    this.replyRing = new ReplyRing(this.sab, this.regions);
    this.eventRing = new EventRing(this.sab, this.regions);
    this.heap = new PayloadHeap(this.sab, this.regions);
    this.pool = new StringPool(this.sab, this.regions);
    this.handles = new HandleTable();
    this.events = new EventDispatcher(this);
    this.opMap = buildOpMap();
    // Expose the event dispatcher for user-gesture callbacks (pointer lock, etc.)
    this.eventDispatcher = this.events;
    this.controlI32 = new Int32Array(this.sab, 0, CONTROL_BYTES / 4);

    // Init ring headers + pool + heap.
    this.reqRing.init();
    this.replyRing.init();
    this.eventRing.init();
    this.heap.init();
    this.pool.init();

    const doc = options.document ?? (typeof document !== "undefined" ? document : (undefined as unknown as Document));
    const win = options.window ?? (typeof window !== "undefined" ? window : (undefined as unknown as Window));
    this.win = win;
    this.doc = doc;
    if (doc) this.handles.initReserved(doc, win);

    this.ctx = {
      document: doc,
      window: win,
      allocHandle: (node: Node) => this.handles.alloc(node),
      resolveHandle: (h: number) => this.handles.resolve(h),
      internString: (s: string) => this.pool.intern(s),
      resolveString: (a: number) => this.pool.resolve(a),
      writePayload: (bytes: Uint8Array) => this.heap.writeBytes(bytes),
    };

    // Arm the initial async wait so we drain immediately on the first request.
    this.armRequestWait();

    // High-frequency drain interval — a reliable fallback that doesn't depend
    // on rAF (which can be starved by GPU work) or waitAsync+MessageChannel
    // (which is a macrotask that can be delayed by other event loop work).
    // 4ms ensures any callSync from the worker gets a reply within ~4ms,
    // preventing the 1000ms Atomics.wait timeout.
    this.drainIntervalId = setInterval(() => this.drain(), 4);
  }

  /** Stop the drain interval and clean up. Call when the host is no longer needed. */
  dispose(): void {
    if (this.drainIntervalId !== null) {
      clearInterval(this.drainIntervalId);
      this.drainIntervalId = null;
    }
  }

  /** Drain all queued requests, dispatch, write replies. Call on raf/notify.
   *  Yields after processing a batch (max 50 requests or 4ms) to ensure the
   *  render loop (rAF) gets a chance to run between drains. Without this yield,
   *  the waitAsync + MessageChannel mechanism can continuously drain requests,
   *  preempting rAF and causing 0 FPS. */
  drain(): void {
    if (this.draining) return; // re-entrancy guard
    this.draining = true;
    const t0 = performance.now();
    let count = 0;
    const MAX_BATCH = 50;
    const MAX_BATCH_MS = 4;
    try {
      // Mark direction: main is processing worker requests (not main→worker).
      Atomics.store(this.controlI32, CTL_DIRECTION_IDX, 0);
      let slot = this.reqRing.tryPop();
      while (slot !== null) {
        this.processRequest(slot);
        this.reqRing.release(slot);
        slot = this.reqRing.tryPop();
        count++;
        // Yield to rAF after processing a batch — remaining requests will be
        // processed on the next drain (rAF or setInterval or waitAsync).
        if (count >= MAX_BATCH || performance.now() - t0 > MAX_BATCH_MS) {
          break;
        }
      }
      // After draining, arm waitAsync so we're notified immediately when the
      // worker pushes a new request — no need to wait for the next setInterval tick.
      this.armRequestWait();
    } finally {
      this.draining = false;
    }
  }

  /** Arm an async wait on the request ring so we drain immediately on new requests.
   *  Uses MessageChannel to ensure the drain runs as a high-priority macrotask.
   *  The batch limit in drain() (max 50 requests or 4ms) ensures rAF gets a
   *  chance to run between drains, preventing 0 FPS when the worker pushes
   *  many fire-and-forget requests continuously. */
  private requestWaitArmed = false;
  private drainChannel: MessageChannel | null = null;
  private armRequestWait(): void {
    if (this.requestWaitArmed) return;
    this.requestWaitArmed = true;
    if (!this.drainChannel) {
      this.drainChannel = new MessageChannel();
      this.drainChannel.port1.onmessage = () => {
        this.drain();
      };
    }
    // Check if there are already pending requests in the ring (pushed during
    // drain() after the last tryPop, or during the batch-limit yield). If so,
    // don't wait — immediately schedule a drain. Without this check, the seq
    // has already been bumped by the pending request's publish(), so waitAsync
    // would wait for the NEXT change (missing the already-queued request).
    // This was the root cause of 1000ms callSync stalls: the worker's
    // Atomics.notify fires before armRequestWait is armed, the seq is already
    // at the new value, and waitAsync(newSeq) doesn't resolve until timeout.
    if (this.reqRing.tryPop() !== null) {
      this.requestWaitArmed = false;
      this.drainChannel.port2.postMessage(null);
      return;
    }
    const seq = this.reqRing.getSeq();
    this.reqRing.waitAsync(seq, 5000).then((changed) => {
      this.requestWaitArmed = false;
      if (changed) {
        // Post to the MessageChannel — this schedules drain() as a macrotask.
        // The batch limit in drain() ensures rAF runs between batches.
        this.drainChannel!.port2.postMessage(null);
      }
    }).catch(() => { this.requestWaitArmed = false; });
  }

  private processRequest(slot: number): void {
    const u32 = this.reqRing.slotU32(slot);
    const opId = u32[OP_OPID_OFF / 4];
    const handle = u32[OP_HANDLE_OFF / 4];
    const argCount = u32[OP_ARGCOUNT_OFF / 4];
    const reqId = u32[OP_REQID_OFF / 4];

    // OP_RELEASE is intercepted (frees the handle, no exec).
    if (opId === ids.OP_RELEASE) {
      const toRelease = argCount > 0 ? u32[OP_ARG0_OFF / 4] : 0;
      this.handles.release(toRelease);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    // Event listener ops are intercepted (delegate to EventDispatcher).
    if (opId === ids.OP_ADD_EVENT_LISTENER) {
      const typeAtom = u32[OP_ARG0_OFF / 4];
      const type = this.pool.resolve(typeAtom) ?? "";
      this.events.add(handle, type);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }
    if (opId === ids.OP_REMOVE_EVENT_LISTENER) {
      const typeAtom = u32[OP_ARG0_OFF / 4];
      const type = this.pool.resolve(typeAtom) ?? "";
      this.events.remove(handle, type);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    // Window event listener ops — delegate to EventDispatcher with window handle.
    if (opId === ids.OP_WINDOW_ADD_EVENT_LISTENER) {
      const typeAtom = u32[OP_ARG0_OFF / 4];
      const type = this.pool.resolve(typeAtom) ?? "";
      this.events.add(HANDLE_WINDOW, type);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }
    if (opId === ids.OP_WINDOW_REMOVE_EVENT_LISTENER) {
      const typeAtom = u32[OP_ARG0_OFF / 4];
      const type = this.pool.resolve(typeAtom) ?? "";
      this.events.remove(HANDLE_WINDOW, type);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    // rAF — coalesced: the host uses a single shared rAF to reply to ALL
    // pending worker rAF requests at once. This prevents a busy loop where
    // the worker requests rAF → host registers real rAF → rAF fires →
    // worker callback runs → worker requests another rAF → repeat at
    // hundreds of fps when Electron's rAF isn't vsync-throttled.
    if (opId === ids.OP_WINDOW_REQUEST_ANIMATION_FRAME) {
      const rafId = ++this.rafCounter;
      this.pendingRaf.set(reqId, rafId);
      // Only register a real rAF if one isn't already pending.
      if (!this.rafScheduled) {
        this.rafScheduled = true;
        this.win.requestAnimationFrame(() => {
          this.rafScheduled = false;
          // Reply to ALL pending rAF requests at once.
          for (const [pendingReqId, pendingRafId] of this.pendingRaf) {
            this.writeReply(pendingReqId, { kind: ArgKind.I32, value: pendingRafId });
          }
          this.pendingRaf.clear();
        });
      }
      return;
    }
    if (opId === ids.OP_WINDOW_CANCEL_ANIMATION_FRAME) {
      // We can't truly cancel a rAF that's already scheduled, but we can
      // mark it as cancelled so the reply is a no-op.
      const rafId = u32[OP_ARG0_OFF / 4];
      this.cancelledRaf.add(rafId);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    // Document exitPointerLock — delegate to the real document.
    if (opId === ids.OP_DOCUMENT_EXIT_POINTER_LOCK) {
      try { this.doc.exitPointerLock(); } catch { /* ignore */ }
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    // Layout subscription ops.
    if (opId === ids.OP_TRACK_LAYOUT) {
      const h = u32[OP_ARG0_OFF / 4];
      this.layoutTracked.add(h);
      if (this.layoutWriter) this.layoutWriter.track(h);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }
    if (opId === ids.OP_UNTRACK_LAYOUT) {
      const h = u32[OP_ARG0_OFF / 4];
      this.layoutTracked.delete(h);
      if (this.layoutWriter) this.layoutWriter.untrack(h);
      this.writeReply(reqId, { kind: ArgKind.Void });
      return;
    }

    const entry = this.opMap.get(opId);
    if (!entry) {
      this.writeReply(reqId, { kind: ArgKind.Error, message: `Unknown op id: ${opId}` });
      return;
    }

    const node = this.handles.resolve(handle);
    const args = this.decodeArgs(u32, argCount);

    try {
      const result = entry.exec(this.ctx, node, args);
      if (result && typeof (result as Promise<Result>).then === "function") {
        // Async exec — write reply when it resolves.
        (result as Promise<Result>).then(
          (r) => this.writeReply(reqId, r),
          (e) => this.writeReply(reqId, { kind: ArgKind.Error, message: (e as Error).message }),
        );
      } else {
        this.writeReply(reqId, result as Result);
      }
    } catch (e) {
      this.writeReply(reqId, { kind: ArgKind.Error, message: (e as Error).message });
    }
  }

  private decodeArgs(u32: Uint32Array, argCount: number): DecodedArgs {
    const values: ArgValue[] = [];
    // Inline args 0 and 1 are in fixed slots; further args spill to payload.
    // For v1 simplicity, if argCount > 2, the payload holds ALL args as a
    // single encoded array (the worker packs them). Inline slots 0/1 are
    // still used for the common 0-2 arg case.
    if (argCount <= OP_MAX_INLINE_ARGS) {
      for (let i = 0; i < argCount; i++) {
        const kindOff = i === 0 ? OP_ARGKIND0_OFF : OP_ARGKIND1_OFF;
        const valOff = i === 0 ? OP_ARG0_OFF : OP_ARG1_OFF;
        values.push(this.decodeInlineArg(u32, kindOff / 4, valOff / 4));
      }
    } else {
      // Spilled: payload offset is in arg0 slot, length in arg1 slot.
      const payloadOff = u32[OP_ARG0_OFF / 4];
      const payloadLen = u32[OP_ARG1_OFF / 4];
      const bytes = new Uint8Array(this.sab, payloadOff, payloadLen);
      const decoded = decodePayload(bytes);
      if (Array.isArray(decoded)) {
        values.push(...decoded);
      } else {
        values.push(decoded);
      }
    }
    return { values };
  }

  private decodeInlineArg(u32: Uint32Array, kindIdx: number, valIdx: number): ArgValue {
    const kind = u32[kindIdx] as number;
    switch (kind) {
      case ArgKind.Null:
        return null;
      case ArgKind.Bool:
        return u32[valIdx] !== 0;
      case ArgKind.I32:
        return new Int32Array(u32.buffer, u32.byteOffset + valIdx * 4, 1)[0];
      case ArgKind.U32:
        return u32[valIdx];
      case ArgKind.F32:
        return new Float32Array(u32.buffer, u32.byteOffset + valIdx * 4, 1)[0];
      case ArgKind.F64: {
        // f64 occupies this slot + the next inline slot (lo, hi).
        const lo = u32[valIdx];
        const hi = u32[valIdx + 2]; // skip the next arg's kind slot
        return loHiToF64(lo, hi);
      }
      case ArgKind.Handle:
        return u32[valIdx]; // handles flow as raw integers
      case ArgKind.StringAtom:
        return this.pool.resolve(u32[valIdx]) ?? "";
      case ArgKind.PayloadRef: {
        const off = u32[valIdx];
        const len = u32[valIdx + 2]; // next slot
        const bytes = new Uint8Array(this.sab, off, len);
        return decodePayload(bytes);
      }
      default:
        return null;
    }
  }

  private writeReply(reqId: number, result: Result): void {
    // Retry on full ring (the worker should be draining, but guard anyway).
    let slot = this.replyRing.tryPush();
    if (slot === null) {
      // Ring full — grow is not wired to rings in v1; spin briefly.
      for (let i = 0; i < 1000 && slot === null; i++) slot = this.replyRing.tryPush();
      if (slot === null) {
        console.error("[worker-dom] reply ring full; dropping reply for reqId", reqId);
        return;
      }
    }
    const u32 = this.replyRing.slotU32(slot);
    u32[REPLY_REQID_OFF / 4] = reqId;
    u32[REPLY_RESULTKIND_OFF / 4] = result.kind;
    switch (result.kind) {
      case ArgKind.Void:
        u32[REPLY_RESULT_OFF / 4] = 0;
        u32[REPLY_PAYLOADOFF_OFF / 4] = 0;
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
        break;
      case ArgKind.Bool:
        u32[REPLY_RESULT_OFF / 4] = result.value ? 1 : 0;
        u32[REPLY_PAYLOADOFF_OFF / 4] = 0;
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
        break;
      case ArgKind.I32:
      case ArgKind.U32:
      case ArgKind.Handle:
      case ArgKind.StringAtom:
        // Raw u32 bits. Handle uses .handle, StringAtom uses .atom, others .value.
        u32[REPLY_RESULT_OFF / 4] =
          result.kind === ArgKind.Handle ? (result as any).handle
          : result.kind === ArgKind.StringAtom ? (result as any).atom
          : (result as any).value;
        u32[REPLY_PAYLOADOFF_OFF / 4] = 0;
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
        break;
      case ArgKind.F32: {
        // Write f32 bits into the u32 result slot.
        const f32buf = new Float32Array(1);
        f32buf[0] = result.value as number;
        u32[REPLY_RESULT_OFF / 4] = new Uint32Array(f32buf.buffer)[0];
        u32[REPLY_PAYLOADOFF_OFF / 4] = 0;
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
        break;
      }
      case ArgKind.F64: {
        const [lo, hi] = f64ToLoHi(result.value as number);
        u32[REPLY_RESULT_OFF / 4] = lo;
        u32[REPLY_PAYLOADOFF_OFF / 4] = hi; // reuse payloadOff slot for hi bits
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
        break;
      }
      case ArgKind.PayloadRef: {
        const bytes = (result as any).bytes as Uint8Array;
        let off = 0;
        try {
          off = this.heap.writeBytes(bytes);
        } catch (e) {
          // Heap full — try grow, then retry.
          growDomSab(this.sab, this.sab.byteLength + bytes.length + 4096);
          // Re-create heap view (it reads region offset from control header).
          off = this.heap.writeBytes(bytes);
        }
        u32[REPLY_RESULT_OFF / 4] = 0;
        u32[REPLY_PAYLOADOFF_OFF / 4] = off;
        u32[REPLY_PAYLOADLEN_OFF / 4] = bytes.length;
        break;
      }
      case ArgKind.Error: {
        const msg = (result as any).message as string;
        const bytes = encodePayload(msg);
        const off = this.heap.writeBytes(bytes);
        u32[REPLY_RESULT_OFF / 4] = (result as any).code ?? 0;
        u32[REPLY_PAYLOADOFF_OFF / 4] = off;
        u32[REPLY_PAYLOADLEN_OFF / 4] = bytes.length;
        break;
      }
      default:
        u32[REPLY_RESULT_OFF / 4] = 0;
        u32[REPLY_PAYLOADOFF_OFF / 4] = 0;
        u32[REPLY_PAYLOADLEN_OFF / 4] = 0;
    }
    this.replyRing.publish(slot);
  }

  // --- Event emission (used by the event-dispatcher in Phase 4) ---
  /**
   * Enqueue an event onto the event ring. Returns true if queued, false if
   * the ring is full (caller should drop or backpressure).
   */
  enqueueEvent(handle: number, typeAtom: number, payloadBytes: Uint8Array): boolean {
    let slot = this.eventRing.tryPush();
    if (slot === null) return false;
    let off = 0;
    if (payloadBytes.length > 0) {
      try {
        off = this.heap.writeBytes(payloadBytes);
      } catch {
        growDomSab(this.sab, this.sab.byteLength + payloadBytes.length + 4096);
        off = this.heap.writeBytes(payloadBytes);
      }
    }
    const u32 = this.eventRing.slotU32(slot);
    u32[EVENT_HANDLE_OFF / 4] = handle;
    u32[EVENT_TYPEATOM_OFF / 4] = typeAtom;
    u32[EVENT_PAYLOADOFF_OFF / 4] = off;
    u32[EVENT_PAYLOADLEN_OFF / 4] = payloadBytes.length;
    u32[EVENT_SEQ_OFF / 4] = 0;
    u32[EVENT_FLAGS_OFF / 4] = 0;
    this.eventRing.publish(slot);
    return true;
  }

  /** Expose internals the event-dispatcher / layout-writer need. */
  get stringPool(): StringPool { return this.pool; }
  get handleTable(): HandleTable { return this.handles; }
  get payloadHeap(): PayloadHeap { return this.heap; }
}

