// ============================================================================
// gpu-worker-context.ts — worker-side shared-device lifecycle prelude
//
// The conventional protocol, so workers don't hand-roll attach/detach:
//
//   owner:  worker.postMessage({ type: "gpuAttach", ...broker.payload() });
//           // later, before teardown:
//           worker.postMessage({ type: "gpuDetach" });   // worker acks then exits
//
//   worker: const gpu = createGpuWorkerContext(postMessage.bind(self));
//           self.onmessage = (e) => { if (gpu.handleMessage(e.data)) return; ... };
//           // per frame: if (gpu.isValid()) gpu.view.queue.writeTexture(...)
//
// Attach/detach acks (gpuReady / gpuDetached) go through the `post` callback,
// so hosts that wrap the message stream (RPC proxies, DocBackend) can route
// them however they like. Workers with bespoke protocols (e.g. an RPC init
// that already carries targets) can still call attachSharedDevice directly —
// this prelude is convenience, not a requirement.
// ============================================================================

import { borrowGpuBuffer, borrowGpuTexture, type BorrowedTextureMeta } from "./borrow";
import {
    attachSharedDevice,
    type GpuDeviceHandle,
    type SharedDeviceView,
} from "./shared-device";
import type { ptr } from "../ffi/ffi-adapter";
import type { WgpuBuffer, WgpuTexture } from "./wgpu-resources";

/** Owner → worker: attach to the shared device. `gpu`/`cells` come from
 *  GpuShareBroker.payload(). */
export interface GpuAttachMsg {
    type: "gpuAttach";
    gpu: GpuDeviceHandle;
    cells: SharedArrayBuffer;
}

/** Owner → worker: detach before terminate. */
export interface GpuDetachMsg {
    type: "gpuDetach";
}

/** Worker → owner: attach attempt result. */
export interface GpuReadyMsg {
    type: "gpuReady";
    ok: boolean;
}

/** Worker → owner: detach ack — the owner may terminate the worker. */
export interface GpuDetachedMsg {
    type: "gpuDetached";
}

export interface GpuWorkerContext {
    /** The attached non-owning device view, or null before gpuAttach /
     *  after failure / detach. */
    readonly view: SharedDeviceView | null;
    /** True while the view exists and the owner device is live. Poll before
     *  encoding — every FFI call on the view throws once it goes false. */
    isValid(): boolean;
    /** Wrap an owner-created texture ptr non-owningly (see borrow.ts). */
    borrowTexture(texPtr: ptr, meta: BorrowedTextureMeta): WgpuTexture;
    /** Wrap an owner-created buffer ptr non-owningly (see borrow.ts). */
    borrowBuffer(bufPtr: ptr, size: number): WgpuBuffer;
    /** Feed an incoming message. Returns true when the context consumed it
     *  (gpuAttach / gpuDetach). Route through this from the worker's message
     *  dispatcher before its own handlers. */
    handleMessage(msg: unknown): boolean;
    /** Detach the view if attached — also emitted by handleMessage on
     *  gpuDetach. Safe to call on worker shutdown. */
    detach(): void;
    /** Fired when the view transitions to attached or detached/lost —
     *  consumers use it to (re)bind borrowed resources or flip fallbacks. */
    onAttach?: (view: SharedDeviceView) => void;
    onDetach?: () => void;
}

export function createGpuWorkerContext(
    post: (msg: GpuReadyMsg | GpuDetachedMsg) => void,
): GpuWorkerContext {
    let view: SharedDeviceView | null = null;

    const ctx: GpuWorkerContext = {
        get view() {
            return view;
        },
        isValid() {
            return view?.isValid() === true;
        },
        borrowTexture(texPtr, meta) {
            if (!view) throw new Error("borrowTexture: no attached GPU view");
            return borrowGpuTexture(texPtr, meta);
        },
        borrowBuffer(bufPtr, size) {
            if (!view) throw new Error("borrowBuffer: no attached GPU view");
            return borrowGpuBuffer(bufPtr, size, view.queue);
        },
        handleMessage(msg: unknown): boolean {
            const m = msg as { type?: string; gpu?: GpuDeviceHandle; cells?: SharedArrayBuffer };
            if (m?.type === "gpuAttach" && m.gpu && m.cells) {
                try {
                    const v = attachSharedDevice(m.gpu, m.cells);
                    view = v;
                    post({ type: "gpuReady", ok: true });
                    ctx.onAttach?.(v);
                } catch {
                    view = null;
                    post({ type: "gpuReady", ok: false });
                }
                return true;
            }
            if (m?.type === "gpuDetach") {
                ctx.detach();
                post({ type: "gpuDetached" });
                return true;
            }
            return false;
        },
        detach() {
            if (!view) return;
            const v = view;
            view = null;
            ctx.onDetach?.();
            try {
                v.detach();
            } catch {
                /* best-effort */
            }
        },
    };
    return ctx;
}
