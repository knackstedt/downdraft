// ============================================================================
// pass-channel.ts — worker-produced command buffers into owner submit batches
//
// For offscreen pass producers that need their work ordered relative to the
// owner's submissions (a UI overlay pass that must land before composite, a
// shadow atlas that must complete before the scene samples it — next frame).
//
//   worker (each produce):
//     const cb = view.device.createCommandEncoder();
//     ...encode the pass...
//     postPass(cb.finish(), "preSubmit");
//
//   owner (GameRenderer does this — or drain manually):
//     mailbox.watch(worker);                      // once, after spawn
//     const cbs = mailbox.drain("preSubmit");     // → push into queue.submit batch
//
// Semantics: refs arriving after a drain land in the NEXT drain — passes are
// stale-tolerant, never rendezvous'd. If you need the pass this frame, the
// architecture is wrong (that's the screen-bisect trap); produce earlier or
// consume later.
// ============================================================================

import {
    exportCommandBuffer,
    importCommandBuffer,
    type WorkerCommandRef,
} from "./shared-device";
import type { WgpuCommandBuffer } from "./wgpu-resources";

/** Well-known slots the GameRenderer drains into its submit batches. */
export const GPU_PASS_PRE_SUBMIT = "preSubmit" as const;
export const GPU_PASS_PRE_UI = "preUi" as const;

/** Worker → owner message shape for a finished pass. */
export interface GpuPassMsg {
    type: "gpuPass";
    slot: string;
    ref: WorkerCommandRef;
}

interface MessagePortLike {
    addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
    removeEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
}

/**
 * Worker side: export a finished command buffer and post it to the owner.
 * `post` is the worker's message sink (postMessage, or a DocBackend-style
 * emit). After this call the worker must not touch the command buffer —
 * ownership moved to the owner.
 */
export function postPass(
    post: (msg: GpuPassMsg) => void,
    cb: WgpuCommandBuffer,
    slot: string,
): void {
    post({ type: "gpuPass", slot, ref: exportCommandBuffer(cb) });
}

/**
 * Owner side: collects refs posted by watched workers and imports them into
 * owning WgpuCommandBuffer wrappers at drain time. drain() must happen on
 * the thread that will submit() them — the imported wrapper releases the
 * native handle on submit (single-use) or on GC/destroy.
 */
export class GpuPassMailbox {
    private pending = new Map<string, WorkerCommandRef[]>();

    /** Listen for gpuPass messages on a worker's message stream. Returns an
     *  unwatch function — call it when the worker is torn down. */
    watch(worker: MessagePortLike): () => void {
        const fn = (e: { data: unknown }) => this.feed(e.data);
        worker.addEventListener("message", fn);
        return () => worker.removeEventListener("message", fn);
    }

    /** Feed a raw message — for workers whose stream is owned by an RPC
     *  layer or a DocBackend onMessage fan-in. Returns true when consumed. */
    feed(msg: unknown): boolean {
        const m = msg as GpuPassMsg | null;
        if (m?.type === "gpuPass" && typeof m.slot === "string" && m.ref) {
            const arr = this.pending.get(m.slot) ?? [];
            arr.push(m.ref);
            this.pending.set(m.slot, arr);
            return true;
        }
        return false;
    }

    /** Import every pending ref for `slot` into owning command buffers.
     *  Returns [] when nothing arrived since the last drain. Invalid refs
     *  (worker finish() captured a validation error) are imported too —
     *  WgpuQueue.submit() skips + releases them without aborting. */
    drain(slot: string): WgpuCommandBuffer[] {
        const refs = this.pending.get(slot);
        if (!refs || refs.length === 0) return [];
        this.pending.delete(slot);
        return refs.map((r) => importCommandBuffer(r));
    }

    /** Drop all pending refs (their owner-side wrappers are released on
     *  next drain/GC — a ref dropped here without import leaks one native
     *  command buffer until the producing worker's process ends; call only
     *  on teardown where the leak is moot). */
    clear(): void {
        this.pending.clear();
    }
}
