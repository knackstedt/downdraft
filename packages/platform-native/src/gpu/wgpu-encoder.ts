// ============================================================================
// wgpu-encoder.ts — WgpuCommandEncoder / WgpuRenderPassEncoder /
//   WgpuComputePassEncoder
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import { parseAspect, parseExtent3D, parseOrigin3D } from "./enums";
import { trackForRelease, untrack } from "./registry";
import { wgpu } from "./wgpu-ffi";
import {
    WgpuBindGroup,
    WgpuBuffer,
    WgpuCommandBuffer,
    WgpuComputePipeline,
    WgpuQuerySet,
    WgpuRenderPipeline,
    WgpuTexture,
    WgpuTextureView,
} from "./wgpu-resources";

const log = createLogger("info");

// Shared scratch for finish_checked — reused across all encoders instead
// of a fresh 4KB buffer (+ TextDecoder) per command buffer.
const encoderFinishErr = new Uint32Array(1);
const encoderFinishMsg = new Uint8Array(4096);
const encoderFinishDecoder = new TextDecoder();

// ============================================================================
// Pass-op recording — every void pass op is serialized into a flat u32
// stream and replayed with ONE FFI call at end() instead of a crossing per
// op (the dominant FFI cost on Node/Deno). Wire layout must match
// pass_op::* in native-rs/src/gpu/mod.rs: handles are lo/hi u32 pairs, f32
// args are bit patterns, cstrings are [byteLen, bytes… padded to u32].
// ============================================================================

const PO = {
  SET_PIPELINE: 1, SET_BIND_GROUP: 2, SET_VERTEX_BUFFER: 3, SET_INDEX_BUFFER: 4,
  DRAW: 5, DRAW_INDEXED: 6, DRAW_INDIRECT: 7, DRAW_INDEXED_INDIRECT: 8,
  SET_VIEWPORT: 9, SET_SCISSOR: 10, WRITE_TIMESTAMP: 11,
  PUSH_DEBUG_GROUP: 12, POP_DEBUG_GROUP: 13, INSERT_DEBUG_MARKER: 14,
  SET_BLEND_CONSTANT: 15, SET_STENCIL_REFERENCE: 16,
  BEGIN_OCCLUSION_QUERY: 17, END_OCCLUSION_QUERY: 18,
  DISPATCH: 19, DISPATCH_INDIRECT: 20,
} as const;

const passLabelEncoder = new TextEncoder();

class PassStream {
  buf = new Uint32Array(4096);
  private f32v = new Float32Array(this.buf.buffer);
  private u8v = new Uint8Array(this.buf.buffer);
  w = 0;

  reset(): void { this.w = 0; }

  private grow(n: number): void {
    if (this.w + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (this.w + n > cap) cap *= 2;
    const nb = new Uint32Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.f32v = new Float32Array(nb.buffer);
    this.u8v = new Uint8Array(nb.buffer);
  }

  op(code: number): void { this.grow(1); this.buf[this.w++] = code; }
  u(v: number): void { this.grow(1); this.buf[this.w++] = v >>> 0; }
  u64(v: ptr | number | bigint): void {
    this.grow(2);
    const b = BigInt(v);
    this.buf[this.w++] = Number(b & 0xFFFFFFFFn);
    this.buf[this.w++] = Number(b >> 32n);
  }
  f(v: number): void { this.grow(1); this.f32v[this.w++] = v; }
  u32s(vals: Uint32Array): void { this.grow(vals.length); this.buf.set(vals, this.w); this.w += vals.length; }
  str(s: string): void {
    const bytes = passLabelEncoder.encode(s);
    const words = (bytes.length + 3) >> 2;
    this.grow(1 + words);
    this.buf[this.w++] = bytes.length;
    const byteOff = this.w * 4;
    this.u8v.fill(0, byteOff, byteOff + words * 4);
    this.u8v.set(bytes, byteOff);
    this.w += words;
  }
}

// Passes are strictly non-overlapping per encoder, and pools keep the
// 16KB scratch buffers alive across frames instead of reallocating per
// pass.
const passStreamPool: PassStream[] = [];
function acquirePassStream(): PassStream {
  return passStreamPool.pop() ?? new PassStream();
}
function releasePassStream(s: PassStream): void {
  s.reset();
  if (passStreamPool.length < 8) passStreamPool.push(s);
}

// Lazily resolved replay symbols — null when the loaded platform lib
// predates them (recorded ops then replay through the JS decoder below).
let renderPassReplay: ((pass: ptr, stream: ptr, wordCount: number) => number) | null | undefined;
function getRenderPassReplay() {
  if (renderPassReplay === undefined) {
    try { renderPassReplay = wgpu.wgpu_shim_render_pass_replay ?? null; } catch { renderPassReplay = null; }
  }
  return renderPassReplay;
}
let computePassReplay: ((pass: ptr, stream: ptr, wordCount: number) => number) | null | undefined;
function getComputePassReplay() {
  if (computePassReplay === undefined) {
    try { computePassReplay = wgpu.wgpu_shim_compute_pass_replay ?? null; } catch { computePassReplay = null; }
  }
  return computePassReplay;
}

function streamHandle(s: PassStream, i: number): ptr {
  return (BigInt(s.buf[i + 1]) << 32n) | BigInt(s.buf[i]);
}

const labelDecoder = new TextDecoder();

/** Decode a recorded op stream against the per-op FFI fns — compat path
 *  for platform libs that predate wgpu_shim_*_pass_replay. */
function replayRenderPassJS(passPtr: ptr, s: PassStream): void {
  let i = 0;
  const w = s.w;
  const rdStr = (): string => {
    const len = s.buf[i++];
    const bytes = new Uint8Array(s.buf.buffer, i * 4, len);
    i += (len + 3) >> 2;
    return labelDecoder.decode(bytes);
  };
  while (i < w) {
    switch (s.buf[i++]) {
      case PO.SET_PIPELINE:
        wgpu.wgpu_shim_render_pass_set_pipeline(passPtr, streamHandle(s, i)); i += 2; break;
      case PO.SET_BIND_GROUP: {
        const idx = s.buf[i]; const h = streamHandle(s, i + 1); const n = s.buf[i + 3];
        const offs = n > 0 ? s.buf.subarray(i + 4, i + 4 + n) : (0 as unknown as ptr);
        wgpu.wgpu_shim_render_pass_set_bind_group(passPtr, idx, h, offs as ptr, n);
        i += 4 + n; break;
      }
      case PO.SET_VERTEX_BUFFER:
        wgpu.wgpu_shim_render_pass_set_vertex_buffer(passPtr, s.buf[i], streamHandle(s, i + 1), BigInt(streamHandle(s, i + 3)), BigInt(streamHandle(s, i + 5)));
        i += 7; break;
      case PO.SET_INDEX_BUFFER:
        wgpu.wgpu_shim_render_pass_set_index_buffer(passPtr, streamHandle(s, i), s.buf[i + 2], BigInt(streamHandle(s, i + 3)), BigInt(streamHandle(s, i + 5)));
        i += 7; break;
      case PO.DRAW:
        wgpu.wgpu_shim_render_pass_draw(passPtr, s.buf[i], s.buf[i + 1], s.buf[i + 2], s.buf[i + 3]); i += 4; break;
      case PO.DRAW_INDEXED:
        wgpu.wgpu_shim_render_pass_draw_indexed(passPtr, s.buf[i], s.buf[i + 1], s.buf[i + 2], s.buf[i + 3] | 0, s.buf[i + 4]); i += 5; break;
      case PO.DRAW_INDIRECT:
        wgpu.wgpu_shim_render_pass_draw_indirect(passPtr, streamHandle(s, i), BigInt(streamHandle(s, i + 2))); i += 4; break;
      case PO.DRAW_INDEXED_INDIRECT:
        wgpu.wgpu_shim_render_pass_draw_indexed_indirect(passPtr, streamHandle(s, i), BigInt(streamHandle(s, i + 2))); i += 4; break;
      case PO.SET_VIEWPORT: {
        const f = new Float32Array(s.buf.buffer);
        wgpu.wgpu_shim_render_pass_set_viewport(passPtr, f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]);
        i += 6; break;
      }
      case PO.SET_SCISSOR:
        wgpu.wgpu_shim_render_pass_set_scissor_rect(passPtr, s.buf[i], s.buf[i + 1], s.buf[i + 2], s.buf[i + 3]); i += 4; break;
      case PO.WRITE_TIMESTAMP:
        wgpu.wgpu_shim_render_pass_write_timestamp(passPtr, streamHandle(s, i), s.buf[i + 2]); i += 3; break;
      case PO.PUSH_DEBUG_GROUP: wgpu.wgpu_shim_render_pass_push_debug_group(passPtr, rdStr()); break;
      case PO.POP_DEBUG_GROUP: wgpu.wgpu_shim_render_pass_pop_debug_group(passPtr); break;
      case PO.INSERT_DEBUG_MARKER: wgpu.wgpu_shim_render_pass_insert_debug_marker(passPtr, rdStr()); break;
      case PO.SET_BLEND_CONSTANT: {
        const f = new Float32Array(s.buf.buffer);
        wgpu.wgpu_shim_render_pass_set_blend_constant(passPtr, f[i], f[i + 1], f[i + 2], f[i + 3]);
        i += 4; break;
      }
      case PO.SET_STENCIL_REFERENCE:
        wgpu.wgpu_shim_render_pass_set_stencil_reference(passPtr, s.buf[i]); i += 1; break;
      case PO.BEGIN_OCCLUSION_QUERY:
        wgpu.wgpu_shim_render_pass_begin_occlusion_query(passPtr, s.buf[i]); i += 1; break;
      case PO.END_OCCLUSION_QUERY:
        wgpu.wgpu_shim_render_pass_end_occlusion_query(passPtr); break;
      default:
        log.error("wgpu", `render pass replay: unknown opcode ${s.buf[i - 1]} — dropping remaining ops`);
        return;
    }
  }
}

function replayComputePassJS(passPtr: ptr, s: PassStream): void {
  let i = 0;
  const w = s.w;
  const rdStr = (): string => {
    const len = s.buf[i++];
    const bytes = new Uint8Array(s.buf.buffer, i * 4, len);
    i += (len + 3) >> 2;
    return labelDecoder.decode(bytes);
  };
  while (i < w) {
    switch (s.buf[i++]) {
      case PO.SET_PIPELINE:
        wgpu.wgpu_shim_compute_pass_set_pipeline(passPtr, streamHandle(s, i)); i += 2; break;
      case PO.SET_BIND_GROUP: {
        const idx = s.buf[i]; const h = streamHandle(s, i + 1); const n = s.buf[i + 3];
        const offs = n > 0 ? s.buf.subarray(i + 4, i + 4 + n) : (0 as unknown as ptr);
        wgpu.wgpu_shim_compute_pass_set_bind_group(passPtr, idx, h, offs as ptr, n);
        i += 4 + n; break;
      }
      case PO.DISPATCH:
        wgpu.wgpu_shim_compute_pass_dispatch(passPtr, s.buf[i], s.buf[i + 1], s.buf[i + 2]); i += 3; break;
      case PO.DISPATCH_INDIRECT:
        wgpu.wgpu_shim_compute_pass_dispatch_indirect(passPtr, streamHandle(s, i), BigInt(streamHandle(s, i + 2))); i += 4; break;
      case PO.WRITE_TIMESTAMP:
        wgpu.wgpu_shim_compute_pass_write_timestamp(passPtr, streamHandle(s, i), s.buf[i + 2]); i += 3; break;
      case PO.PUSH_DEBUG_GROUP: wgpu.wgpu_shim_compute_pass_push_debug_group(passPtr, rdStr()); break;
      case PO.POP_DEBUG_GROUP: wgpu.wgpu_shim_compute_pass_pop_debug_group(passPtr); break;
      case PO.INSERT_DEBUG_MARKER: wgpu.wgpu_shim_compute_pass_insert_debug_marker(passPtr, rdStr()); break;
      default:
        log.error("wgpu", `compute pass replay: unknown opcode ${s.buf[i - 1]} — dropping remaining ops`);
        return;
    }
  }
}

function parseIndexFormat(format: string): number {
  return format === "uint16" ? 1 : format === "uint32" ? 2 : 0;
}

function dynamicOffsetsArray(dynamicOffsets?: Iterable<number>): Uint32Array | null {
  if (!dynamicOffsets) return null;
  const arr = Array.from(dynamicOffsets);
  return arr.length > 0 ? new Uint32Array(arr) : null;
}

// ============================================================================
// WgpuCommandEncoder
// ============================================================================

export class WgpuCommandEncoder {
  readonly ptr: ptr;
  label = "";
  private finished = false;
  private devicePtr: ptr;

  constructor(ptr: ptr, devicePtr: ptr = 0) {
    this.ptr = ptr;
    this.devicePtr = devicePtr;
    trackForRelease(this, () => wgpu.wgpu_shim_release_command_encoder(ptr));
  }

  beginRenderPass(descriptor: GPURenderPassDescriptor): WgpuRenderPassEncoder {
    const colorAttachments = descriptor.colorAttachments ? Array.from(descriptor.colorAttachments) : [];
    const colorCount = colorAttachments.length;
    // Flat: 11 u32 per attachment — [viewLo, viewHi, depthSlice,
    //   resolveLo, resolveHi, loadOp, storeOp, clearR, clearG, clearB, clearA]
    let colorFlat: Uint32Array | null = null;
    if (colorCount > 0) {
      colorFlat = new Uint32Array(colorCount * 11);
      const f32 = new Float32Array(4);
      const u32 = new Uint32Array(f32.buffer);
      for (let i = 0; i < colorCount; i++) {
        const att = colorAttachments[i] as any;
        const base = i * 11;
        const view = att.view as unknown as WgpuTextureView;
        // Track writes so the surface context can skip presenting an
        // acquired-but-untouched swapchain texture (dirty-skip frames).
        if (att.storeOp !== "discard" && view.sourceTexture) view.sourceTexture.__ddWritten = true;
        if (att.resolveTarget?.sourceTexture) (att.resolveTarget as WgpuTextureView).sourceTexture!.__ddWritten = true;
        const viewPtr = BigInt(view.ptr);
        colorFlat[base + 0] = Number(viewPtr & 0xFFFFFFFFn);
        colorFlat[base + 1] = Number(viewPtr >> 32n);
        colorFlat[base + 2] = att.depthSlice ?? 0xFFFFFFFF; // WGPU_DEPTH_SLICE_UNDEFINED
        const rt = att.resolveTarget ? BigInt((att.resolveTarget as unknown as WgpuTextureView).ptr) : 0n;
        colorFlat[base + 3] = Number(rt & 0xFFFFFFFFn);
        colorFlat[base + 4] = Number(rt >> 32n);
        colorFlat[base + 5] = att.loadOp === "load" ? 1 : att.loadOp === "clear" ? 2 : 0;
        colorFlat[base + 6] = att.storeOp === "discard" ? 2 : att.storeOp === "store" ? 1 : 0;
        const cv = att.clearValue;
        let cr = 0, cg = 0, cb = 0, ca = 0;
        if (Array.isArray(cv)) { cr = cv[0] ?? 0; cg = cv[1] ?? 0; cb = cv[2] ?? 0; ca = cv[3] ?? 0; }
        else if (cv) { cr = cv.r ?? 0; cg = cv.g ?? 0; cb = cv.b ?? 0; ca = cv.a ?? 0; }
        f32[0] = cr; f32[1] = cg; f32[2] = cb; f32[3] = ca;
        colorFlat[base + 7] = u32[0];
        colorFlat[base + 8] = u32[1];
        colorFlat[base + 9] = u32[2];
        colorFlat[base + 10] = u32[3];
      }
    }

    // Depth-stencil attachment: 10 u32 (see native-rs/src/gpu/mod.rs)
    let depthFlat: Uint32Array | null = null;
    const da = descriptor.depthStencilAttachment;
    if (da) {
      const dv = da.view as unknown as WgpuTextureView;
      if (dv) {
        depthFlat = new Uint32Array(10);
        const dvPtr = BigInt(dv.ptr);
        depthFlat[0] = Number(dvPtr & 0xFFFFFFFFn);
        depthFlat[1] = Number(dvPtr >> 32n);
        depthFlat[2] = da.depthLoadOp === "load" ? 1 : da.depthLoadOp === "clear" ? 2 : 0;
        depthFlat[3] = da.depthStoreOp === "discard" ? 2 : da.depthStoreOp === "store" ? 1 : 0;
        const dcv = new Float32Array(1); dcv[0] = da.depthClearValue ?? 1;
        depthFlat[4] = new Uint32Array(dcv.buffer)[0];
        depthFlat[5] = da.depthReadOnly ? 1 : 0;
        depthFlat[6] = da.stencilLoadOp === "load" ? 1 : da.stencilLoadOp === "clear" ? 2 : 0;
        depthFlat[7] = da.stencilStoreOp === "discard" ? 2 : da.stencilStoreOp === "store" ? 1 : 0;
        depthFlat[8] = da.stencilClearValue ?? 0;
        depthFlat[9] = da.stencilReadOnly ? 1 : 0;
      }
    }

    const oqs = descriptor.occlusionQuerySet as unknown as WgpuQuerySet | undefined;

    // Pass timestamp writes: [qsLo, qsHi, beginIdx, endIdx]
    let tsFlat: Uint32Array | null = null;
    const tw = descriptor.timestampWrites as any;
    if (tw) {
      const qs = tw.querySet as unknown as WgpuQuerySet;
      if (qs) {
        tsFlat = new Uint32Array(4);
        const qsPtr = BigInt(qs.ptr);
        tsFlat[0] = Number(qsPtr & 0xFFFFFFFFn);
        tsFlat[1] = Number(qsPtr >> 32n);
        tsFlat[2] = tw.beginningOfPassWriteIndex ?? 0xFFFFFFFF;
        tsFlat[3] = tw.endOfPassWriteIndex ?? 0xFFFFFFFF;
      }
    }

    const passPtr = wgpu.wgpu_shim_begin_render_pass(
      this.ptr,
      colorCount,
      (colorFlat ?? 0) as unknown as ptr,
      (depthFlat ?? 0) as unknown as ptr,
      (oqs?.ptr ?? 0) as unknown as ptr,
      (tsFlat ?? 0) as unknown as ptr,
    ) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin render pass");
    return new WgpuRenderPassEncoder(passPtr, acquirePassStream());
  }

  beginComputePass(descriptor?: GPUComputePassDescriptor): WgpuComputePassEncoder {
    let tsFlat: Uint32Array | null = null;
    const tw = descriptor?.timestampWrites as any;
    if (tw) {
      const qs = tw.querySet as unknown as WgpuQuerySet;
      if (qs) {
        tsFlat = new Uint32Array(4);
        const qsPtr = BigInt(qs.ptr);
        tsFlat[0] = Number(qsPtr & 0xFFFFFFFFn);
        tsFlat[1] = Number(qsPtr >> 32n);
        tsFlat[2] = tw.beginningOfPassWriteIndex ?? 0xFFFFFFFF;
        tsFlat[3] = tw.endOfPassWriteIndex ?? 0xFFFFFFFF;
      }
    }
    const passPtr = wgpu.wgpu_shim_begin_compute_pass(this.ptr, (tsFlat ?? 0) as unknown as ptr) as unknown as number;
    if (!passPtr) throw new Error("Failed to begin compute pass");
    return new WgpuComputePassEncoder(passPtr, acquirePassStream());
  }

  copyBufferToBuffer(source: WgpuBuffer, sourceOffset: number, destination: WgpuBuffer, destinationOffset: number, size: number): void {
    wgpu.wgpu_shim_copy_buffer_to_buffer(this.ptr, source.ptr, BigInt(sourceOffset), destination.ptr, BigInt(destinationOffset), BigInt(size));
  }

  copyBufferToTexture(source: GPUTexelCopyBufferInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3D): void {
    const srcBuffer = source.buffer as unknown as WgpuBuffer;
    const dstTexture = destination.texture as unknown as WgpuTexture;
    dstTexture.__ddWritten = true;
    const { width, height, depthOrArrayLayers } = parseExtent3D(copySize);
    const origin = parseOrigin3D(destination.origin);
    wgpu.wgpu_shim_copy_buffer_to_texture(
      this.ptr,
      srcBuffer.ptr,
      BigInt(source.offset ?? 0),
      source.bytesPerRow ?? 0,
      source.rowsPerImage ?? height,
      dstTexture.ptr,
      destination.mipLevel ?? 0,
      origin.x, origin.y, origin.z,
      parseAspect(destination.aspect),
      width, height, depthOrArrayLayers,
    );
  }

  copyTextureToBuffer(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyBufferInfo, copySize: GPUExtent3D): void {
    const srcTexture = source.texture as unknown as WgpuTexture;
    const dstBuffer = destination.buffer as unknown as WgpuBuffer;
    const { width, height, depthOrArrayLayers } = parseExtent3D(copySize);
    const origin = parseOrigin3D(source.origin);
    wgpu.wgpu_shim_copy_texture_to_buffer(
      this.ptr,
      srcTexture.ptr,
      source.mipLevel ?? 0,
      origin.x, origin.y, origin.z,
      parseAspect(source.aspect),
      dstBuffer.ptr,
      BigInt(destination.offset ?? 0),
      destination.bytesPerRow ?? 0,
      destination.rowsPerImage ?? height,
      width, height, depthOrArrayLayers,
    );
  }

  copyTextureToTexture(source: GPUTexelCopyTextureInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3D): void {
    const srcTexture = source.texture as unknown as WgpuTexture;
    const dstTexture = destination.texture as unknown as WgpuTexture;
    dstTexture.__ddWritten = true;
    const { width, height, depthOrArrayLayers } = parseExtent3D(copySize);
    const sOrigin = parseOrigin3D(source.origin);
    const dOrigin = parseOrigin3D(destination.origin);
    wgpu.wgpu_shim_copy_texture_to_texture(
      this.ptr,
      srcTexture.ptr, source.mipLevel ?? 0, sOrigin.x, sOrigin.y, sOrigin.z, parseAspect(source.aspect),
      dstTexture.ptr, destination.mipLevel ?? 0, dOrigin.x, dOrigin.y, dOrigin.z, parseAspect(destination.aspect),
      width, height, depthOrArrayLayers,
    );
  }

  finish(_descriptor?: GPUCommandBufferDescriptor): WgpuCommandBuffer {
    if (this.finished) throw new Error("Command encoder already finished");
    this.finished = true;
    // Catch validation errors generated while finishing (e.g. a bad
    // set_pipeline in a recorded pass): wgpu-native still returns a buffer
    // handle, but it is invalid, and submitting it aborts the process. The
    // checked finish does the scope push/pop inside the shim — one FFI
    // crossing and shared scratch buffers instead of three calls + a 4KB
    // alloc per command buffer.
    let cmdPtr: ptr | undefined;
    let invalid = false;
    let finishChecked: ((...a: any[]) => ptr) | undefined;
    try {
      finishChecked = (wgpu as any).wgpu_shim_command_encoder_finish_checked;
    } catch {
      finishChecked = undefined; // loaded lib predates the symbol
    }
    if (this.devicePtr && typeof finishChecked === "function") {
      encoderFinishErr[0] = 0;
      cmdPtr = finishChecked(
        this.ptr,
        this.devicePtr,
        encoderFinishErr as any,
        encoderFinishMsg as any,
        encoderFinishMsg.length,
      );
      const errType = encoderFinishErr[0];
      if (errType !== 0 && errType !== 1) {
        invalid = true;
        const msg = encoderFinishDecoder.decode(encoderFinishMsg).replace(/\0+$/, "");
        log.error("wgpu", `validation error during command encoder finish: ${msg}`);
      }
    } else {
      if (this.devicePtr) wgpu.wgpu_shim_device_push_error_scope(this.devicePtr, 1);
      cmdPtr = wgpu.wgpu_shim_command_encoder_finish(this.ptr) as unknown as number;
      if (this.devicePtr) {
        const msgBuf = new Uint8Array(4096);
        const errType = wgpu.wgpu_shim_device_pop_error_scope(this.devicePtr, msgBuf as any, msgBuf.length);
        if (errType !== 0 && errType !== 1) {
          invalid = true;
          const msg = new TextDecoder().decode(msgBuf).replace(/\0+$/, "");
          log.error("wgpu", `validation error during command encoder finish: ${msg}`);
        }
      }
    }
    if (!cmdPtr) throw new Error("Failed to finish command encoder");
    // The encoder is consumed by finish — release it now.
    untrack(this);
    wgpu.wgpu_shim_release_command_encoder(this.ptr);
    const cmd = new WgpuCommandBuffer(cmdPtr);
    cmd.invalid = invalid;
    trackForRelease(cmd, () => wgpu.wgpu_shim_release_command_buffer(cmdPtr));
    return cmd;
  }

  clearBuffer(buffer: WgpuBuffer, offset?: number, size?: number): void {
    wgpu.wgpu_shim_command_encoder_clear_buffer(this.ptr, buffer.ptr, BigInt(offset ?? 0), BigInt(size ?? 0));
  }

  pushDebugGroup(groupLabel: string): void {
    wgpu.wgpu_shim_command_encoder_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    wgpu.wgpu_shim_command_encoder_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    wgpu.wgpu_shim_command_encoder_insert_debug_marker(this.ptr, markerLabel);
  }
  writeTimestamp(querySet: WgpuQuerySet, queryIndex: number): void {
    wgpu.wgpu_shim_command_encoder_write_timestamp(this.ptr, querySet.ptr, queryIndex);
  }
  resolveQuerySet(querySet: WgpuQuerySet, firstQuery: number, queryCount: number, destination: WgpuBuffer, destinationOffset: number): void {
    wgpu.wgpu_shim_resolve_query_set(this.ptr, querySet.ptr, firstQuery, queryCount, destination.ptr, BigInt(destinationOffset));
  }
}

// ============================================================================
// WgpuRenderPassEncoder
// ============================================================================

export class WgpuRenderPassEncoder {
  readonly ptr: ptr;
  label = "";
  private ended = false;
  /** Recorded op stream — replayed in one FFI call at end(). Ops called
   *  after end() are dropped (they'd be a validation error anyway). */
  private rec: PassStream | null;

  constructor(ptr: ptr, stream?: PassStream) {
    this.ptr = ptr;
    this.rec = stream ?? acquirePassStream();
    trackForRelease(this, () => wgpu.wgpu_shim_release_render_pass(ptr));
  }

  setPipeline(pipeline: WgpuRenderPipeline): void {
    const r = this.rec; if (!r) return;
    r.op(PO.SET_PIPELINE); r.u64(pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, dynamicOffsets?: Iterable<number>): void {
    const r = this.rec; if (!r || !bindGroup) return;
    const offs = dynamicOffsetsArray(dynamicOffsets);
    r.op(PO.SET_BIND_GROUP); r.u(index); r.u64(bindGroup.ptr); r.u(offs?.length ?? 0);
    if (offs) r.u32s(offs);
  }

  setVertexBuffer(slot: number, buffer: WgpuBuffer | null, offset?: number, size?: number): void {
    const r = this.rec; if (!r || !buffer) return;
    const off = offset ?? 0;
    r.op(PO.SET_VERTEX_BUFFER); r.u(slot); r.u64(buffer.ptr); r.u64(off); r.u64(size ?? (buffer.size - off));
  }

  setIndexBuffer(buffer: WgpuBuffer | null, format: GPUIndexFormat, offset?: number, size?: number): void {
    const r = this.rec; if (!r || !buffer) return;
    const off = offset ?? 0;
    const sz = size ?? (buffer.size - off);
    // Binding an empty index range is meaningless — and wgpu-native panics
    // on it ("invalid size"), which aborts the process since the panic
    // crosses the FFI boundary. Skip instead.
    if (sz <= 0) return;
    r.op(PO.SET_INDEX_BUFFER); r.u64(buffer.ptr); r.u(parseIndexFormat(format)); r.u64(off); r.u64(sz);
  }

  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DRAW); r.u(vertexCount); r.u(instanceCount ?? 1); r.u(firstVertex ?? 0); r.u(firstInstance ?? 0);
  }

  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DRAW_INDEXED); r.u(indexCount); r.u(instanceCount ?? 1); r.u(firstIndex ?? 0); r.u(baseVertex ?? 0); r.u(firstInstance ?? 0);
  }

  drawIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DRAW_INDIRECT); r.u64(indirectBuffer.ptr); r.u64(indirectOffset);
  }

  drawIndexedIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DRAW_INDEXED_INDIRECT); r.u64(indirectBuffer.ptr); r.u64(indirectOffset);
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.SET_VIEWPORT); r.f(x); r.f(y); r.f(width); r.f(height); r.f(minDepth); r.f(maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.SET_SCISSOR); r.u(x); r.u(y); r.u(width); r.u(height);
  }

  /** Inside-pass timestamp write — requires the "timestamp-query-inside-passes" feature. */
  writeTimestamp(querySet: WgpuQuerySet, queryIndex: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.WRITE_TIMESTAMP); r.u64(querySet.ptr); r.u(queryIndex);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const rec = this.rec;
    this.rec = null;
    if (rec && rec.w > 0) {
      const replay = getRenderPassReplay();
      if (replay) {
        const st = replay(this.ptr, rec.buf as unknown as ptr, rec.w);
        if (st !== 0) log.error("wgpu", `render pass replay failed (${st}) — ops dropped`);
      } else {
        replayRenderPassJS(this.ptr, rec);
      }
      releasePassStream(rec);
    }
    wgpu.wgpu_shim_render_pass_end(this.ptr);
    untrack(this);
    wgpu.wgpu_shim_release_render_pass(this.ptr);
  }

  setBlendConstant(color: GPUColor): void {
    const r = this.rec; if (!r) return;
    const c = color as any;
    r.op(PO.SET_BLEND_CONSTANT); r.f(c.r ?? 0); r.f(c.g ?? 0); r.f(c.b ?? 0); r.f(c.a ?? 0);
  }
  setStencilReference(reference: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.SET_STENCIL_REFERENCE); r.u(reference);
  }
  pushDebugGroup(groupLabel: string): void {
    const r = this.rec; if (!r) return;
    r.op(PO.PUSH_DEBUG_GROUP); r.str(groupLabel);
  }
  popDebugGroup(): void {
    const r = this.rec; if (!r) return;
    r.op(PO.POP_DEBUG_GROUP);
  }
  insertDebugMarker(markerLabel: string): void {
    const r = this.rec; if (!r) return;
    r.op(PO.INSERT_DEBUG_MARKER); r.str(markerLabel);
  }
  beginOcclusionQuery(queryIndex: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.BEGIN_OCCLUSION_QUERY); r.u(queryIndex);
  }
  endOcclusionQuery(): void {
    const r = this.rec; if (!r) return;
    r.op(PO.END_OCCLUSION_QUERY);
  }
  executeBundles(_bundles: Iterable<unknown>): void {
    throw new Error("executeBundles is not implemented on the native wgpu wrapper");
  }
}

// ============================================================================
// WgpuComputePassEncoder
// ============================================================================

export class WgpuComputePassEncoder {
  readonly ptr: ptr;
  label = "";
  private ended = false;
  private rec: PassStream | null;

  constructor(ptr: ptr, stream?: PassStream) {
    this.ptr = ptr;
    this.rec = stream ?? acquirePassStream();
    trackForRelease(this, () => wgpu.wgpu_shim_release_compute_pass(ptr));
  }

  setPipeline(pipeline: WgpuComputePipeline): void {
    const r = this.rec; if (!r) return;
    r.op(PO.SET_PIPELINE); r.u64(pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, dynamicOffsets?: Iterable<number>): void {
    const r = this.rec; if (!r || !bindGroup) return;
    const offs = dynamicOffsetsArray(dynamicOffsets);
    r.op(PO.SET_BIND_GROUP); r.u(index); r.u64(bindGroup.ptr); r.u(offs?.length ?? 0);
    if (offs) r.u32s(offs);
  }

  dispatchWorkgroups(x: number, y?: number, z?: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DISPATCH); r.u(x); r.u(y ?? 1); r.u(z ?? 1);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.DISPATCH_INDIRECT); r.u64(indirectBuffer.ptr); r.u64(indirectOffset);
  }

  /** Inside-pass timestamp write — requires the "timestamp-query-inside-passes" feature. */
  writeTimestamp(querySet: WgpuQuerySet, queryIndex: number): void {
    const r = this.rec; if (!r) return;
    r.op(PO.WRITE_TIMESTAMP); r.u64(querySet.ptr); r.u(queryIndex);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const rec = this.rec;
    this.rec = null;
    if (rec && rec.w > 0) {
      const replay = getComputePassReplay();
      if (replay) {
        const st = replay(this.ptr, rec.buf as unknown as ptr, rec.w);
        if (st !== 0) log.error("wgpu", `compute pass replay failed (${st}) — ops dropped`);
      } else {
        replayComputePassJS(this.ptr, rec);
      }
      releasePassStream(rec);
    }
    wgpu.wgpu_shim_compute_pass_end(this.ptr);
    untrack(this);
    wgpu.wgpu_shim_release_compute_pass(this.ptr);
  }

  pushDebugGroup(groupLabel: string): void {
    const r = this.rec; if (!r) return;
    r.op(PO.PUSH_DEBUG_GROUP); r.str(groupLabel);
  }
  popDebugGroup(): void {
    const r = this.rec; if (!r) return;
    r.op(PO.POP_DEBUG_GROUP);
  }
  insertDebugMarker(markerLabel: string): void {
    const r = this.rec; if (!r) return;
    r.op(PO.INSERT_DEBUG_MARKER); r.str(markerLabel);
  }
}
