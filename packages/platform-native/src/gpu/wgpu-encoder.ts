// ============================================================================
// wgpu-encoder.ts — WgpuCommandEncoder / WgpuRenderPassEncoder /
//   WgpuComputePassEncoder
// ============================================================================

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
  readonly ptr: number;
  label = "";
  private finished = false;

  constructor(ptr: number) {
    this.ptr = ptr;
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
        const viewPtr = BigInt((att.view as unknown as WgpuTextureView).ptr);
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

    // Depth-stencil attachment: 10 u32 (see wgpu_shim.c)
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
    return new WgpuRenderPassEncoder(passPtr);
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
    return new WgpuComputePassEncoder(passPtr);
  }

  copyBufferToBuffer(source: WgpuBuffer, sourceOffset: number, destination: WgpuBuffer, destinationOffset: number, size: number): void {
    wgpu.wgpu_shim_copy_buffer_to_buffer(this.ptr, source.ptr, BigInt(sourceOffset), destination.ptr, BigInt(destinationOffset), BigInt(size));
  }

  copyBufferToTexture(source: GPUTexelCopyBufferInfo, destination: GPUTexelCopyTextureInfo, copySize: GPUExtent3D): void {
    const srcBuffer = source.buffer as unknown as WgpuBuffer;
    const dstTexture = destination.texture as unknown as WgpuTexture;
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
    const cmdPtr = wgpu.wgpu_shim_command_encoder_finish(this.ptr) as unknown as number;
    if (!cmdPtr) throw new Error("Failed to finish command encoder");
    // The encoder is consumed by finish — release it now.
    untrack(this);
    wgpu.wgpu_shim_release_command_encoder(this.ptr);
    const cmd = new WgpuCommandBuffer(cmdPtr);
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
  readonly ptr: number;
  label = "";
  private ended = false;

  constructor(ptr: number) {
    this.ptr = ptr;
    trackForRelease(this, () => wgpu.wgpu_shim_release_render_pass(ptr));
  }

  setPipeline(pipeline: WgpuRenderPipeline): void {
    wgpu.wgpu_shim_render_pass_set_pipeline(this.ptr, pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, dynamicOffsets?: Iterable<number>): void {
    if (bindGroup) {
      const offs = dynamicOffsetsArray(dynamicOffsets);
      wgpu.wgpu_shim_render_pass_set_bind_group(
        this.ptr, index, bindGroup.ptr,
        (offs ?? 0) as unknown as ptr,
        offs?.length ?? 0,
      );
    }
  }

  setVertexBuffer(slot: number, buffer: WgpuBuffer | null, offset?: number, size?: number): void {
    if (buffer) {
      const off = offset ?? 0;
      wgpu.wgpu_shim_render_pass_set_vertex_buffer(this.ptr, slot, buffer.ptr, BigInt(off), BigInt(size ?? (buffer.size - off)));
    }
  }

  setIndexBuffer(buffer: WgpuBuffer | null, format: GPUIndexFormat, offset?: number, size?: number): void {
    if (buffer) {
      const off = offset ?? 0;
      wgpu.wgpu_shim_render_pass_set_index_buffer(this.ptr, buffer.ptr, parseIndexFormat(format), BigInt(off), BigInt(size ?? (buffer.size - off)));
    }
  }

  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void {
    wgpu.wgpu_shim_render_pass_draw(this.ptr, vertexCount, instanceCount ?? 1, firstVertex ?? 0, firstInstance ?? 0);
  }

  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void {
    wgpu.wgpu_shim_render_pass_draw_indexed(this.ptr, indexCount, instanceCount ?? 1, firstIndex ?? 0, baseVertex ?? 0, firstInstance ?? 0);
  }

  drawIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    wgpu.wgpu_shim_render_pass_draw_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  drawIndexedIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    wgpu.wgpu_shim_render_pass_draw_indexed_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    wgpu.wgpu_shim_render_pass_set_viewport(this.ptr, x, y, width, height, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    wgpu.wgpu_shim_render_pass_set_scissor_rect(this.ptr, x, y, width, height);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    wgpu.wgpu_shim_render_pass_end(this.ptr);
    untrack(this);
    wgpu.wgpu_shim_release_render_pass(this.ptr);
  }

  setBlendConstant(color: GPUColor): void {
    const c = color as any;
    wgpu.wgpu_shim_render_pass_set_blend_constant(this.ptr, c.r ?? 0, c.g ?? 0, c.b ?? 0, c.a ?? 0);
  }
  setStencilReference(reference: number): void {
    wgpu.wgpu_shim_render_pass_set_stencil_reference(this.ptr, reference);
  }
  pushDebugGroup(groupLabel: string): void {
    wgpu.wgpu_shim_render_pass_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    wgpu.wgpu_shim_render_pass_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    wgpu.wgpu_shim_render_pass_insert_debug_marker(this.ptr, markerLabel);
  }
  beginOcclusionQuery(queryIndex: number): void {
    wgpu.wgpu_shim_render_pass_begin_occlusion_query(this.ptr, queryIndex);
  }
  endOcclusionQuery(): void {
    wgpu.wgpu_shim_render_pass_end_occlusion_query(this.ptr);
  }
  executeBundles(_bundles: Iterable<unknown>): void {
    throw new Error("executeBundles is not implemented on the native wgpu wrapper");
  }
}

// ============================================================================
// WgpuComputePassEncoder
// ============================================================================

export class WgpuComputePassEncoder {
  readonly ptr: number;
  label = "";
  private ended = false;

  constructor(ptr: number) {
    this.ptr = ptr;
    trackForRelease(this, () => wgpu.wgpu_shim_release_compute_pass(ptr));
  }

  setPipeline(pipeline: WgpuComputePipeline): void {
    wgpu.wgpu_shim_compute_pass_set_pipeline(this.ptr, pipeline.ptr);
  }

  setBindGroup(index: number, bindGroup: WgpuBindGroup | null, dynamicOffsets?: Iterable<number>): void {
    if (bindGroup) {
      const offs = dynamicOffsetsArray(dynamicOffsets);
      wgpu.wgpu_shim_compute_pass_set_bind_group(
        this.ptr, index, bindGroup.ptr,
        (offs ?? 0) as unknown as ptr,
        offs?.length ?? 0,
      );
    }
  }

  dispatchWorkgroups(x: number, y?: number, z?: number): void {
    wgpu.wgpu_shim_compute_pass_dispatch(this.ptr, x, y ?? 1, z ?? 1);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: WgpuBuffer, indirectOffset: number): void {
    wgpu.wgpu_shim_compute_pass_dispatch_indirect(this.ptr, indirectBuffer.ptr, BigInt(indirectOffset));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    wgpu.wgpu_shim_compute_pass_end(this.ptr);
    untrack(this);
    wgpu.wgpu_shim_release_compute_pass(this.ptr);
  }

  pushDebugGroup(groupLabel: string): void {
    wgpu.wgpu_shim_compute_pass_push_debug_group(this.ptr, groupLabel);
  }
  popDebugGroup(): void {
    wgpu.wgpu_shim_compute_pass_pop_debug_group(this.ptr);
  }
  insertDebugMarker(markerLabel: string): void {
    wgpu.wgpu_shim_compute_pass_insert_debug_marker(this.ptr, markerLabel);
  }
}
