// ============================================================================
// borrow.ts — symmetric resource handoff for shared-device GPU work
//
// shared-device.ts covers the device view + command-buffer direction. This
// file covers the RESOURCE direction — the two patterns games actually need:
//
//   borrow* — worker side. The OWNER thread created the texture/buffer and
//     keeps its lifetime; the worker wraps the raw ptr non-owningly so it can
//     write through it (queue.writeTexture / writeBuffer / encoder targets).
//     markTransferred() disarms the wrapper's release path — destroy() here
//     is a local no-op and never frees the owner's handle.
//
//   import* — owner side. A worker created the resource and posted its ptr
//     after exportGpuResource() (which disarmed the worker's finalizer). The
//     owner wraps it OWNING — destroy()/GC releases the native handle on this
//     thread. Use this instead of `new WgpuTexture(ptr, ...)`: a bare wrap is
//     never registered with the finalizer, so a dropped wrapper leaks.
//
// Deferred-destroy convention (borrow direction): the owner must not destroy
// a resource a worker may still be writing through. Since writes happen on
// the worker thread, the owner only knows the worker swapped targets when it
// acks the new binding (or enough time passes that an in-flight FFI call is
// impossible). Consumers implement their own ack/timeout — see the html-ui
// texBind/texAck protocol for a reference implementation.
// ============================================================================

import type { ptr } from "../ffi/ffi-adapter";
import { markTransferred, trackForRelease } from "./registry";
import type { WgpuQueue } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";
import { WgpuBuffer, WgpuTexture } from "./wgpu-resources";

/** Metadata needed to reconstruct a WgpuTexture wrapper on another thread.
 *  Must match the creating thread's GPUTextureDescriptor — the wrapper only
 *  reads these fields, it does not re-create the resource. */
export interface BorrowedTextureMeta {
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  format: GPUTextureFormat;
  /** Metadata only — the native texture already exists with its real usage.
   *  Defaults to TEXTURE_BINDING | COPY_DST (the upload-target shape). */
  usage?: number;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: GPUTextureDimension;
  label?: string;
}

function textureDesc(meta: BorrowedTextureMeta): GPUTextureDescriptor {
  return {
    size: {
      width: meta.width,
      height: meta.height,
      depthOrArrayLayers: meta.depthOrArrayLayers ?? 1,
    },
    format: meta.format,
    mipLevelCount: meta.mipLevelCount ?? 1,
    sampleCount: meta.sampleCount ?? 1,
    dimension: meta.dimension ?? "2d",
    usage: meta.usage ?? (0x04 | 0x02), // TEXTURE_BINDING | COPY_DST
    label: meta.label,
  } as GPUTextureDescriptor;
}

/**
 * Worker-side: wrap an owner-created texture handle non-owningly. The owner
 * retains lifetime — destroy() on this wrapper releases nothing natively.
 * The owner must keep the handle alive until the borrower has dropped its
 * wrap (deferred-destroy convention above).
 */
export function borrowGpuTexture(texPtr: ptr, meta: BorrowedTextureMeta): WgpuTexture {
  if (!texPtr) throw new Error("borrowGpuTexture: null texture handle");
  const tex = new WgpuTexture(texPtr, textureDesc(meta));
  markTransferred(tex);
  return tex;
}

/**
 * Worker-side: wrap an owner-created buffer handle non-owningly. `queue` is
 * the worker's own attached-view queue — WgpuBuffer retains it only for
 * unmap write-flushes; writeBuffer targets go through queue.writeBuffer's
 * destination arg anyway.
 */
export function borrowGpuBuffer(bufPtr: ptr, size: number, queue: WgpuQueue): WgpuBuffer {
  if (!bufPtr) throw new Error("borrowGpuBuffer: null buffer handle");
  const buf = new WgpuBuffer(bufPtr, size, queue);
  markTransferred(buf);
  return buf;
}

/**
 * Owner-side: take ownership of a worker-exported texture handle. The worker
 * must have called exportGpuResource() before posting the ptr — otherwise
 * BOTH threads believe they own the handle and release it twice.
 */
export function importGpuTexture(texPtr: ptr, meta: BorrowedTextureMeta): WgpuTexture {
  if (!texPtr) throw new Error("importGpuTexture: null texture handle");
  const tex = new WgpuTexture(texPtr, textureDesc(meta));
  trackForRelease(tex, () => wgpu.wgpu_shim_release_texture(texPtr));
  return tex;
}

/**
 * Owner-side: take ownership of a worker-exported buffer handle. Same
 * export-then-post contract as importGpuTexture.
 */
export function importGpuBuffer(bufPtr: ptr, size: number, queue: WgpuQueue): WgpuBuffer {
  if (!bufPtr) throw new Error("importGpuBuffer: null buffer handle");
  const buf = new WgpuBuffer(bufPtr, size, queue);
  trackForRelease(buf, () => wgpu.wgpu_shim_release_buffer(bufPtr));
  return buf;
}
