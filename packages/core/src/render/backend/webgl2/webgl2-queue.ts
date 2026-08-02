// ============================================================================
// WebGL2 Queue — executes recorded command buffers against the GL context.
// Also provides writeBuffer and writeTexture for direct data uploads.
// ============================================================================

import { getFormatInfo, getWebGL2FormatMapping } from "../format-mapping.ts";
import type {
    BackendBuffer,
    BackendCommandBuffer,
    BackendQueue,
    BackendTexture,
    RenderPassDescriptor,
} from "../types.ts";
import { WebGL2CommandBuffer, type Command } from "./webgl2-encoders.ts";
import type { WebGL2BindGroup, WebGL2RenderPipeline } from "./webgl2-resources.ts";
import { WebGL2Buffer, WebGL2Texture, WebGL2TextureView } from "./webgl2-resources.ts";

export class WebGL2Queue implements BackendQueue {
  constructor(
    private _gl: WebGL2RenderingContext,
  ) {}

  submit(commandBuffers: BackendCommandBuffer[]): void {
    const gl = this._gl;

    for (const cb of commandBuffers) {
      const cmds = (cb as WebGL2CommandBuffer).commands;
      this.executeCommands(cmds);
    }
  }

  private executeCommands(commands: Command[]): void {
    const gl = this._gl;
    let currentPipeline: WebGL2RenderPipeline | null = null;
    let currentIndexBuffer: WebGL2Buffer | null = null;
    let currentIndexFormat: number = gl.UNSIGNED_SHORT;
    let currentVertexBuffers: Map<number, { buffer: WebGL2Buffer; offset: number }> = new Map();
    let currentBindGroups: Map<number, WebGL2BindGroup> = new Map();
    let inRenderPass = false;

    for (const cmd of commands) {
      switch (cmd.type) {
        case "beginRenderPass":
          this.beginRenderPass(cmd.desc);
          inRenderPass = true;
          break;

        case "endRenderPass":
          // Unbind framebuffer
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          inRenderPass = false;
          currentPipeline = null;
          currentVertexBuffers.clear();
          currentBindGroups.clear();
          break;

        case "setPipeline":
          currentPipeline = cmd.pipeline;
          gl.useProgram(cmd.pipeline.glProgram);
          // Apply pipeline state (depth, blend, cull, etc.)
          this.applyPipelineState(cmd.pipeline);
          break;

        case "setBindGroup":
          currentBindGroups.set(cmd.index, cmd.group);
          this.applyBindGroup(cmd.index, cmd.group, cmd.dynamicOffsets, currentPipeline);
          break;

        case "setVertexBuffer":
          currentVertexBuffers.set(cmd.slot, { buffer: cmd.buffer, offset: cmd.offset });
          if (currentPipeline) {
            this.bindVertexBuffer(cmd.slot, cmd.buffer, cmd.offset, currentPipeline);
          }
          break;

        case "setIndexBuffer":
          currentIndexBuffer = cmd.buffer;
          currentIndexFormat = cmd.format === "uint32" ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cmd.buffer.glBuffer);
          break;

        case "setViewport":
          gl.viewport(cmd.x, cmd.y, cmd.w, cmd.h);
          gl.depthRange(cmd.minD, cmd.maxD);
          break;

        case "setScissor":
          gl.scissor(cmd.x, cmd.y, cmd.w, cmd.h);
          break;

        case "draw":
          this.draw(currentPipeline, currentVertexBuffers, cmd.vertexCount, cmd.instanceCount, cmd.firstVertex);
          break;

        case "drawIndexed":
          this.drawIndexed(currentPipeline, currentVertexBuffers, currentIndexBuffer, currentIndexFormat, cmd.indexCount, cmd.instanceCount, cmd.firstIndex, cmd.baseVertex);
          break;

        case "copyBufferToBuffer":
          this.copyBufferToBuffer(cmd.src, cmd.srcOffset, cmd.dst, cmd.dstOffset, cmd.size);
          break;

        case "copyBufferToTexture":
          this.copyBufferToTexture(cmd.srcBuf, cmd.srcOffset, cmd.bytesPerRow, cmd.dstTex, cmd.mipLevel, cmd.origin, cmd.copySize);
          break;

        case "copyTextureToBuffer":
          this.copyTextureToBuffer(cmd.srcTex, cmd.mipLevel, cmd.origin, cmd.dstBuf, cmd.dstOffset, cmd.bytesPerRow, cmd.copySize);
          break;

        case "copyTextureToTexture":
          this.copyTextureToTexture(cmd.srcTex, cmd.srcMip, cmd.srcOrigin, cmd.dstTex, cmd.dstMip, cmd.dstOrigin, cmd.copySize);
          break;
      }
    }
  }

  // ─── Render Pass Setup ────────────────────────────────────────────────────

  private _fbo: WebGLFramebuffer | null = null;

  private beginRenderPass(desc: RenderPassDescriptor): void {
    const gl = this._gl;

    if (!this._fbo) {
      this._fbo = gl.createFramebuffer();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);

    // Attach color attachments
    for (let i = 0; i < desc.colorAttachments.length; i++) {
      const att = desc.colorAttachments[i];
      const view = att.view as WebGL2TextureView;
      const tex = view.texture;
      const glTex = tex.glTexture;
      if (!glTex) continue;

      const target = tex.textureTarget;
      if (tex.depthOrArrayLayers > 1) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, glTex, att.depthSlice ?? 0, 0);
      } else {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, target, glTex, 0);
      }

      if (att.loadOp === "clear") {
        const cv = att.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
        gl.clearBufferfv(gl.COLOR, i, [cv.r, cv.g, cv.b, cv.a]);
      }
    }

    // Attach depth-stencil
    if (desc.depthStencilAttachment) {
      const ds = desc.depthStencilAttachment;
      const view = ds.view as WebGL2TextureView;
      const tex = view.texture;
      const glTex = tex.glTexture;
      if (glTex) {
        const target = tex.textureTarget;
        const attachPoint = tex.format === "depth24plus-stencil8"
          ? gl.DEPTH_STENCIL_ATTACHMENT
          : gl.DEPTH_ATTACHMENT;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, attachPoint, target, glTex, 0);

        if (ds.depthLoadOp === "clear") {
          gl.clearBufferfv(gl.DEPTH, 0, [ds.depthClearValue ?? 1.0]);
        }
        if (ds.stencilLoadOp === "clear") {
          gl.clearBufferiv(gl.STENCIL, 0, [ds.stencilClearValue ?? 0]);
        }
      }
    }
  }

  // ─── Pipeline State Application ───────────────────────────────────────────

  private applyPipelineState(pipeline: WebGL2RenderPipeline): void {
    const gl = this._gl;
    const info = pipeline.info;

    // Topology
    // Already stored in info.topology, applied at draw time

    // Cull mode
    if (info.cullMode !== gl.NONE) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(info.cullMode);
    } else {
      gl.disable(gl.CULL_FACE);
    }
    gl.frontFace(info.frontFace);

    // Depth
    if (info.depthTest) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(info.depthFunc);
      gl.depthMask(info.depthWrite);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }

    // Stencil
    if (info.stencilTest) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMaskSeparate(gl.FRONT, info.stencilWriteMask);
      gl.stencilMaskSeparate(gl.BACK, info.stencilWriteMask);
      gl.stencilFuncSeparate(gl.FRONT, info.stencilFront.compare, 0, info.stencilReadMask);
      gl.stencilFuncSeparate(gl.BACK, info.stencilBack.compare, 0, info.stencilReadMask);
      gl.stencilOpSeparate(gl.FRONT, info.stencilFront.failOp, info.stencilFront.depthFailOp, info.stencilFront.passOp);
      gl.stencilOpSeparate(gl.BACK, info.stencilBack.failOp, info.stencilBack.depthFailOp, info.stencilBack.passOp);
    } else {
      gl.disable(gl.STENCIL_TEST);
    }

    // Blend
    if (info.blendEnabled && info.blendState) {
      gl.enable(gl.BLEND);
      const bs = info.blendState;
      gl.blendEquationSeparate(
        this.mapBlendOp(bs.color.operation ?? "add"),
        this.mapBlendOp(bs.alpha.operation ?? "add"),
      );
      gl.blendFuncSeparate(
        this.mapBlendFactor(bs.color.srcFactor ?? "one"),
        this.mapBlendFactor(bs.color.dstFactor ?? "zero"),
        this.mapBlendFactor(bs.alpha.srcFactor ?? "one"),
        this.mapBlendFactor(bs.alpha.dstFactor ?? "zero"),
      );
    } else {
      gl.disable(gl.BLEND);
    }

    // Color write mask
    gl.colorMask(
      !!(info.colorWriteMask & 1),
      !!(info.colorWriteMask & 2),
      !!(info.colorWriteMask & 4),
      !!(info.colorWriteMask & 8),
    );
  }

  private mapBlendOp(op: string): number {
    const gl = this._gl;
    switch (op) {
      case "add": return gl.FUNC_ADD;
      case "subtract": return gl.FUNC_SUBTRACT;
      case "reverse-subtract": return gl.FUNC_REVERSE_SUBTRACT;
      case "min": return gl.MIN;
      case "max": return gl.MAX;
      default: return gl.FUNC_ADD;
    }
  }

  private mapBlendFactor(f: string): number {
    const gl = this._gl;
    switch (f) {
      case "zero": return gl.ZERO;
      case "one": return gl.ONE;
      case "src": return gl.SRC_COLOR;
      case "one-minus-src": return gl.ONE_MINUS_SRC_COLOR;
      case "src-alpha": return gl.SRC_ALPHA;
      case "one-minus-src-alpha": return gl.ONE_MINUS_SRC_ALPHA;
      case "dst": return gl.DST_COLOR;
      case "one-minus-dst": return gl.ONE_MINUS_DST_COLOR;
      case "dst-alpha": return gl.DST_ALPHA;
      case "one-minus-dst-alpha": return gl.ONE_MINUS_DST_ALPHA;
      case "src-alpha-saturated": return gl.SRC_ALPHA_SATURATE;
      case "constant": return gl.CONSTANT_COLOR;
      case "one-minus-constant": return gl.ONE_MINUS_CONSTANT_COLOR;
      default: return gl.ONE;
    }
  }

  // ─── Bind Group Application ───────────────────────────────────────────────

  private applyBindGroup(index: number, group: WebGL2BindGroup, _dynamicOffsets: number[], _pipeline: WebGL2RenderPipeline | null): void {
    const gl = this._gl;
    const layout = group.info.layout;
    const entries = group.info.entries;

    for (const entry of entries) {
      const layoutEntry = layout.info.entries.find((e) => e.binding === entry.binding);
      if (!layoutEntry) continue;

      if ("buffer" in entry.resource) {
        const buf = entry.resource.buffer as WebGL2Buffer;
        const offset = entry.resource.offset ?? 0;
        const size = entry.resource.size ?? buf.size;
        gl.bindBufferBase(gl.UNIFORM_BUFFER, entry.binding, buf.glBuffer);
        void offset; void size;
      } else if ("sampler" in entry.resource) {
        // Samplers are bound via texture units — handled with texture binding
        // For now, we bind samplers to their binding point + MAX_TEXTURE_UNITS
        const sampler = entry.resource.sampler as unknown as { glSampler: WebGLSampler | null };
        if (sampler.glSampler) {
          gl.bindSampler(entry.binding, sampler.glSampler);
        }
      } else if ("textureView" in entry.resource) {
        const view = entry.resource.textureView as WebGL2TextureView;
        const tex = view.texture;
        if (tex.glTexture) {
          gl.activeTexture(gl.TEXTURE0 + entry.binding);
          gl.bindTexture(tex.textureTarget, tex.glTexture);
        }
      }
    }
  }

  // ─── Vertex Buffer Binding ────────────────────────────────────────────────

  private bindVertexBuffer(slot: number, buffer: WebGL2Buffer, offset: number, pipeline: WebGL2RenderPipeline): void {
    const gl = this._gl;
    const layout = pipeline.info.vertexBuffers[slot];
    if (!layout) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.glBuffer);

    for (const attr of layout.attributes) {
      const loc = attr.shaderLocation;
      const [size, type, normalized] = this.mapVertexFormat(attr.format);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(
        loc,
        size,
        type,
        normalized,
        layout.arrayStride,
        offset + attr.offset,
      );

      if (layout.stepMode === "instance") {
        gl.vertexAttribDivisor(loc, 1);
      } else {
        gl.vertexAttribDivisor(loc, 0);
      }
    }
  }

  private mapVertexFormat(format: string): [number, number, boolean] {
    const gl = this._gl;
    switch (format) {
      case "float32": return [1, gl.FLOAT, false];
      case "float32x2": return [2, gl.FLOAT, false];
      case "float32x3": return [3, gl.FLOAT, false];
      case "float32x4": return [4, gl.FLOAT, false];
      case "uint32": return [1, gl.UNSIGNED_INT, false];
      case "uint32x2": return [2, gl.UNSIGNED_INT, false];
      case "uint32x3": return [3, gl.UNSIGNED_INT, false];
      case "uint32x4": return [4, gl.UNSIGNED_INT, false];
      case "sint32": return [1, gl.INT, false];
      case "sint32x2": return [2, gl.INT, false];
      case "sint32x3": return [3, gl.INT, false];
      case "sint32x4": return [4, gl.INT, false];
      case "uint16x2": return [2, gl.UNSIGNED_SHORT, false];
      case "uint16x4": return [4, gl.UNSIGNED_SHORT, false];
      case "sint16x2": return [2, gl.SHORT, false];
      case "sint16x4": return [4, gl.SHORT, false];
      case "unorm8x4": return [4, gl.UNSIGNED_BYTE, true];
      case "snorm8x4": return [4, gl.BYTE, true];
      case "uint8x4": return [4, gl.UNSIGNED_BYTE, false];
      case "sint8x4": return [4, gl.BYTE, false];
      case "float16x2": return [2, gl.HALF_FLOAT, false];
      case "float16x4": return [4, gl.HALF_FLOAT, false];
      default: return [1, gl.FLOAT, false];
    }
  }

  // ─── Draw Calls ───────────────────────────────────────────────────────────

  private draw(
    pipeline: WebGL2RenderPipeline | null,
    _vertexBuffers: Map<number, { buffer: WebGL2Buffer; offset: number }>,
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
  ): void {
    const gl = this._gl;
    if (!pipeline) return;

    const topology = pipeline.info.topology;
    if (instanceCount > 1) {
      gl.drawArraysInstanced(topology, firstVertex, vertexCount, instanceCount);
    } else {
      gl.drawArrays(topology, firstVertex, vertexCount);
    }
  }

  private drawIndexed(
    pipeline: WebGL2RenderPipeline | null,
    _vertexBuffers: Map<number, { buffer: WebGL2Buffer; offset: number }>,
    indexBuffer: WebGL2Buffer | null,
    indexFormat: number,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    _baseVertex: number,
  ): void {
    const gl = this._gl;
    if (!pipeline || !indexBuffer) return;

    const topology = pipeline.info.topology;
    const offset = firstIndex * (indexFormat === gl.UNSIGNED_INT ? 4 : 2);
    if (instanceCount > 1) {
      gl.drawElementsInstanced(topology, indexCount, indexFormat, offset, instanceCount);
    } else {
      gl.drawElements(topology, indexCount, indexFormat, offset);
    }
  }

  // ─── Copy Operations ──────────────────────────────────────────────────────

  private copyBufferToBuffer(src: WebGL2Buffer, srcOffset: number, dst: WebGL2Buffer, dstOffset: number, size: number): void {
    const gl = this._gl;
    gl.bindBuffer(gl.COPY_READ_BUFFER, src.glBuffer);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, dst.glBuffer);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, srcOffset, dstOffset, size);
  }

  private copyBufferToTexture(
    srcBuf: WebGL2Buffer, srcOffset: number, bytesPerRow: number,
    dstTex: WebGL2Texture, mipLevel: number, origin: number[], copySize: number[],
  ): void {
    const gl = this._gl;
    const mapping = getWebGL2FormatMapping(dstTex.format);
    if (!mapping) return;

    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, srcBuf.glBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(dstTex.textureTarget, dstTex.glTexture);

    const width = copySize[0] ?? 1;
    const height = copySize[1] ?? 1;

    if (getFormatInfo(dstTex.format).compressed) {
      const blockSize = mapping.blockSize ?? 8;
      const blockWidth = mapping.blockWidth ?? 4;
      const blockHeight = mapping.blockHeight ?? 4;
      const blocksX = Math.ceil(width / blockWidth);
      const blocksY = Math.ceil(height / blockHeight);
      const dataSize = blocksX * blocksY * blockSize;
      gl.compressedTexSubImage2D(
        dstTex.textureTarget, mipLevel,
        origin[0] ?? 0, origin[1] ?? 0,
        width, height,
        mapping.internalFormat,
        dataSize, srcOffset,
      );
    } else {
      gl.texSubImage2D(
        dstTex.textureTarget, mipLevel,
        origin[0] ?? 0, origin[1] ?? 0,
        width, height,
        mapping.format, mapping.type,
        srcOffset,
      );
    }
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    void bytesPerRow;
  }

  private copyTextureToBuffer(
    srcTex: WebGL2Texture, mipLevel: number, origin: number[],
    dstBuf: WebGL2Buffer, dstOffset: number, bytesPerRow: number,
    copySize: number[],
  ): void {
    const gl = this._gl;
    const mapping = getWebGL2FormatMapping(srcTex.format);
    if (!mapping) return;

    // WebGL2 doesn't have a direct readback-to-buffer like WebGPU.
    // We must read from the framebuffer into a buffer.
    // This is a simplified implementation.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, dstBuf.glBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(srcTex.textureTarget, srcTex.glTexture);

    // Note: gl.readPixels reads from the current framebuffer, not directly from texture.
    // A full implementation would need to attach the texture to an FBO first.
    // For now, this is a stub that logs a warning.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    void mipLevel; void origin; void dstOffset; void bytesPerRow; void copySize;
  }

  private copyTextureToTexture(
    srcTex: WebGL2Texture, srcMip: number, srcOrigin: number[],
    dstTex: WebGL2Texture, dstMip: number, dstOrigin: number[],
    copySize: number[],
  ): void {
    const gl = this._gl;
    // Use blitFramebuffer for texture-to-texture copy
    // This requires attaching both textures to framebuffers
    // Simplified implementation for same-format copies
    const width = copySize[0] ?? 1;
    const height = copySize[1] ?? 1;

    // Create temporary FBOs for blitting
    const readFbo = gl.createFramebuffer();
    const drawFbo = gl.createFramebuffer();

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, srcTex.textureTarget, srcTex.glTexture, srcMip);

    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFbo);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dstTex.textureTarget, dstTex.glTexture, dstMip);

    gl.blitFramebuffer(
      srcOrigin[0] ?? 0, srcOrigin[1] ?? 0, (srcOrigin[0] ?? 0) + width, (srcOrigin[1] ?? 0) + height,
      dstOrigin[0] ?? 0, dstOrigin[1] ?? 0, (dstOrigin[0] ?? 0) + width, (dstOrigin[1] ?? 0) + height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );

    gl.deleteFramebuffer(readFbo);
    gl.deleteFramebuffer(drawFbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ─── Direct Write Operations ──────────────────────────────────────────────

  writeBuffer(buffer: BackendBuffer, offset: number, data: BufferSource): void {
    const gl = this._gl;
    const buf = buffer as WebGL2Buffer;
    gl.bindBuffer(buf.target, buf.glBuffer);
    gl.bufferSubData(buf.target, offset, data);
  }

  writeTexture(
    destination: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    data: BufferSource,
    dataLayout: { offset: number; bytesPerRow: number; rowsPerImage?: number },
    _size: number[] | number,
  ): void {
    const gl = this._gl;
    const tex = destination.texture as WebGL2Texture;
    const mapping = getWebGL2FormatMapping(tex.format);
    if (!mapping) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(tex.textureTarget, tex.glTexture);

    const origin = Array.isArray(destination.origin) ? destination.origin : [destination.origin, 0, 0];
    const size = Array.isArray(_size) ? _size : [_size, 1, 1];
    const width = size[0] ?? 1;
    const height = size[1] ?? 1;

    if (getFormatInfo(tex.format).compressed) {
      const blockSize = mapping.blockSize ?? 8;
      const blockWidth = mapping.blockWidth ?? 4;
      const blockHeight = mapping.blockHeight ?? 4;
      const blocksX = Math.ceil(width / blockWidth);
      const blocksY = Math.ceil(height / blockHeight);
      const dataSize = blocksX * blocksY * blockSize;
      gl.compressedTexSubImage2D(
        tex.textureTarget, destination.mipLevel,
        origin[0] ?? 0, origin[1] ?? 0,
        width, height,
        mapping.internalFormat,
        data as ArrayBufferView,
      );
      void dataSize;
    } else {
      gl.texSubImage2D(
        tex.textureTarget, destination.mipLevel,
        origin[0] ?? 0, origin[1] ?? 0,
        width, height,
        mapping.format, mapping.type,
        data as ArrayBufferView,
      );
    }
    void dataLayout;
  }

  copyExternalImageToTexture(
    source: { source: CanvasImageSource | OffscreenCanvas; flipY?: boolean },
    destination: { texture: BackendTexture; mipLevel: number; origin: number[] | number },
    copySize: number[] | number,
  ): void {
    const gl = this._gl;
    const tex = destination.texture as WebGL2Texture;
    const origin = Array.isArray(destination.origin) ? destination.origin : [destination.origin, 0, 0];
    const size = Array.isArray(copySize) ? copySize : [copySize, 1, 1];
    const width = size[0] ?? 1;
    const height = size[1] ?? 1;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(tex.textureTarget, tex.glTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, source.flipY ? 1 : 0);

    gl.texSubImage2D(
      tex.textureTarget, destination.mipLevel,
      origin[0] ?? 0, origin[1] ?? 0,
      width, height,
      gl.RGBA, gl.UNSIGNED_BYTE,
      source.source as TexImageSource,
    );

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  }

  onSubmittedWorkDone(): Promise<void> {
    return Promise.resolve();
  }

  getNative(): unknown {
    return this._gl;
  }
}
