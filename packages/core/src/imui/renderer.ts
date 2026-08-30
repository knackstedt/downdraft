import type { GraphRenderContext } from "..";
import { StructView, wgsl } from "@downdraft/shader-graph";
import type { UIDrawable } from "./element";
import { buildGlyphAtlasData, getAtlasDimensions, getGlyphUV } from "./glyph-atlas";
import { TextAtlasCache } from "./text-cache";

import IMAGE_SHADER from "./shaders/image.wgsl?raw";
import LINE_SHADER from "./shaders/line.wgsl?raw";
import QUAD_SHADER from "./shaders/quad.wgsl?raw";
import TEXT_SHADER from "./shaders/text.wgsl?raw";

// --- Typed uniform struct (validate against quad/text/image/line .wgsl) ---
export const ScreenUniformsStruct = wgsl.struct("ScreenUniforms", {
  screenSize: wgsl.vec2f,
  _pad: wgsl.vec2f,
});

const QUAD_VERTEX_STRIDE = 64; // 2 pos + 2 size + 4 color + 1 radius + 1 borderWidth + 4 borderColor + 2 localOffset = 16 floats * 4
const TEXT_VERTEX_STRIDE = 32; // 2 pos + 2 uv + 4 color = 8 floats * 4
const IMAGE_VERTEX_STRIDE = 32; // 2 pos + 2 uv + 4 color = 8 floats * 4
const LINE_VERTEX_STRIDE = 24; // 2 pos + 4 color = 6 floats * 4

const MAX_QUAD_VERTICES = 65536;
const MAX_TEXT_VERTICES = 131072;
const MAX_IMAGE_VERTICES = 65536;
const MAX_LINE_VERTICES = 65536;

export class UIRenderer {
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private screenBuffer: GPUBuffer | null = null;
  private screenWidth: number = 0;
  private screenHeight: number = 0;
  private _screenView: StructView | null = null;
  private _screenBuf: Float32Array | null = null;

  private quadPipeline: GPURenderPipeline | null = null;
  private quadVertexBuffer: GPUBuffer | null = null;
  private quadBindGroup: GPUBindGroup | null = null;
  private quadShaderModule: GPUShaderModule | null = null;

  private textPipeline: GPURenderPipeline | null = null;
  private textVertexBuffer: GPUBuffer | null = null;
  private textBindGroup: GPUBindGroup | null = null;
  private textShaderModule: GPUShaderModule | null = null;
  private glyphAtlasTexture: GPUTexture | null = null;
  private glyphSampler: GPUSampler | null = null;

  private imagePipeline: GPURenderPipeline | null = null;
  private imageVertexBuffer: GPUBuffer | null = null;
  private imageShaderModule: GPUShaderModule | null = null;
  private imageSampler: GPUSampler | null = null;

  private linePipeline: GPURenderPipeline | null = null;
  private lineVertexBuffer: GPUBuffer | null = null;
  private lineShaderModule: GPUShaderModule | null = null;
  private lineBindGroup: GPUBindGroup | null = null;

  private textCache: TextAtlasCache | null = null;

  private prepared: boolean = false;

  constructor(surfaceFormat: GPUTextureFormat = "bgra8unorm") {
    this.surfaceFormat = surfaceFormat;
  }

  prepare(device: GPUDevice): void {
    if (this.prepared) return;
    this.device = device;

    this.screenBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._screenBuf = new Float32Array(ScreenUniformsStruct.floatCount);
    this._screenView = ScreenUniformsStruct.view(this._screenBuf);

    this.quadShaderModule = device.createShaderModule({ code: QUAD_SHADER });
    this.textShaderModule = device.createShaderModule({ code: TEXT_SHADER });
    this.imageShaderModule = device.createShaderModule({ code: IMAGE_SHADER });
    this.lineShaderModule = device.createShaderModule({ code: LINE_SHADER });
    this.textCache = new TextAtlasCache(device);

    this.quadVertexBuffer = device.createBuffer({
      size: MAX_QUAD_VERTICES * QUAD_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.textVertexBuffer = device.createBuffer({
      size: MAX_TEXT_VERTICES * TEXT_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.imageVertexBuffer = device.createBuffer({
      size: MAX_IMAGE_VERTICES * IMAGE_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.lineVertexBuffer = device.createBuffer({
      size: MAX_LINE_VERTICES * LINE_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const atlasData = buildGlyphAtlasData();
    const { width: atlasW, height: atlasH } = getAtlasDimensions();
    this.glyphAtlasTexture = device.createTexture({
      size: [atlasW, atlasH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.glyphAtlasTexture },
      atlasData as unknown as BufferSource,
      { bytesPerRow: atlasW, rowsPerImage: atlasH },
      [atlasW, atlasH],
    );

    this.glyphSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this.imageSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    const blendState: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };

    this.quadPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.quadShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: QUAD_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32" },
            { shaderLocation: 4, offset: 36, format: "float32" },
            { shaderLocation: 5, offset: 40, format: "float32x4" },
            { shaderLocation: 6, offset: 56, format: "float32x2" },
          ],
        }],
      },
      fragment: {
        module: this.quadShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.quadBindGroup = device.createBindGroup({
      layout: this.quadPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.screenBuffer } }],
    });

    this.textPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.textShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: TEXT_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.textShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.textBindGroup = device.createBindGroup({
      layout: this.textPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.screenBuffer } },
        { binding: 1, resource: this.glyphAtlasTexture.createView() },
        { binding: 2, resource: this.glyphSampler },
      ],
    });

    this.imagePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.imageShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: IMAGE_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.imageShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat, blend: blendState }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.linePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.lineShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: LINE_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.lineShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.surfaceFormat, blend: blendState }],
      },
      primitive: { topology: "line-list" },
    });

    this.lineBindGroup = device.createBindGroup({
      layout: this.linePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.screenBuffer } }],
    });

    this.prepared = true;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    if (this.device && this.screenBuffer && this._screenView && this._screenBuf) {
      this._screenView.set("screenSize", [width, height]);
      this.device.queue.writeBuffer(this.screenBuffer, 0, this._screenBuf as unknown as BufferSource);
    }
  }

  render(ctx: GraphRenderContext, drawables: UIDrawable[]): void {
    if (!this.device || !this.prepared || !ctx.pass) return;
    if (drawables.length === 0) return;

    const tracked = ctx.pass;

    const quadVerts: number[] = [];
    const textVerts: number[] = [];
    const canvasTextEntries: { verts: number[]; textureView: GPUTextureView }[] = [];
    const imageEntries: { verts: number[]; textureView: GPUTextureView }[] = [];
    const lineVerts: number[] = [];

    for (const d of drawables) {
      if (d.kind === "rect") {
        this.buildQuadVertices(d, quadVerts);
      } else if (d.kind === "text" && d.text) {
        if (d.fontFamily && this.textCache) {
          this.buildCanvasTextVertices(d, canvasTextEntries);
        } else {
          this.buildTextVertices(d, textVerts);
        }
      } else if (d.kind === "image" && d.textureView) {
        let entry = imageEntries.find((e) => e.textureView === d.textureView);
        if (!entry) {
          entry = { verts: [], textureView: d.textureView };
          imageEntries.push(entry);
        }
        this.buildImageVertices(d, entry.verts);
      } else if (d.kind === "lines" && d.lines) {
        this.buildLineVertices(d, lineVerts);
      }
    }

    if (this.textCache) {
      this.textCache.flush();
    }

    if (quadVerts.length > 0 && this.quadPipeline && this.quadBindGroup) {
      const count = Math.min(quadVerts.length / 16, MAX_QUAD_VERTICES);
      const data = new Float32Array(quadVerts.slice(0, count * 16));
      this.device.queue.writeBuffer(this.quadVertexBuffer!, 0, data as unknown as BufferSource);
      tracked.setPipeline(this.quadPipeline);
      tracked.setBindGroup(0, this.quadBindGroup);
      tracked.setVertexBuffer(0, this.quadVertexBuffer!);
      tracked.draw(count);
    }

    if (textVerts.length > 0 && this.textPipeline && this.textBindGroup) {
      const count = Math.min(textVerts.length / 8, MAX_TEXT_VERTICES);
      const data = new Float32Array(textVerts.slice(0, count * 8));
      this.device.queue.writeBuffer(this.textVertexBuffer!, 0, data as unknown as BufferSource);
      tracked.setPipeline(this.textPipeline);
      tracked.setBindGroup(0, this.textBindGroup);
      tracked.setVertexBuffer(0, this.textVertexBuffer!);
      tracked.draw(count);
    }

    for (const entry of imageEntries) {
      if (entry.verts.length === 0 || !this.imagePipeline) continue;
      const count = Math.min(entry.verts.length / 8, MAX_IMAGE_VERTICES);
      const data = new Float32Array(entry.verts.slice(0, count * 8));
      this.device.queue.writeBuffer(this.imageVertexBuffer!, 0, data as unknown as BufferSource);
      const bindGroup = this.device.createBindGroup({
        layout: this.imagePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.screenBuffer! } },
          { binding: 1, resource: entry.textureView },
          { binding: 2, resource: this.imageSampler! },
        ],
      });
      tracked.setPipeline(this.imagePipeline);
      tracked.setBindGroup(0, bindGroup);
      tracked.setVertexBuffer(0, this.imageVertexBuffer!);
      tracked.draw(count);
    }

    for (const entry of canvasTextEntries) {
      if (entry.verts.length === 0 || !this.imagePipeline) continue;
      const count = Math.min(entry.verts.length / 8, MAX_IMAGE_VERTICES);
      const data = new Float32Array(entry.verts.slice(0, count * 8));
      this.device.queue.writeBuffer(this.imageVertexBuffer!, 0, data as unknown as BufferSource);
      const bindGroup = this.device.createBindGroup({
        layout: this.imagePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.screenBuffer! } },
          { binding: 1, resource: entry.textureView },
          { binding: 2, resource: this.textCache!.getSampler() },
        ],
      });
      tracked.setPipeline(this.imagePipeline);
      tracked.setBindGroup(0, bindGroup);
      tracked.setVertexBuffer(0, this.imageVertexBuffer!);
      tracked.draw(count);
    }

    if (lineVerts.length > 0 && this.linePipeline && this.lineBindGroup) {
      const count = Math.min(lineVerts.length / 6, MAX_LINE_VERTICES);
      const data = new Float32Array(lineVerts.slice(0, count * 6));
      this.device.queue.writeBuffer(this.lineVertexBuffer!, 0, data as unknown as BufferSource);
      tracked.setPipeline(this.linePipeline);
      tracked.setBindGroup(0, this.lineBindGroup);
      tracked.setVertexBuffer(0, this.lineVertexBuffer!);
      tracked.draw(count);
    }
  }

  private buildQuadVertices(d: UIDrawable, out: number[]): void {
    const { x, y, width, height, color, borderRadius, borderWidth, borderColor } = d;
    const positions = [
      [x, y], [x + width, y], [x + width, y + height],
      [x, y], [x + width, y + height], [x, y + height],
    ];
    const localOffsets = [
      [0, 0], [width, 0], [width, height],
      [0, 0], [width, height], [0, height],
    ];
    for (let i = 0; i < 6; i++) {
      out.push(positions[i][0], positions[i][1]);
      out.push(width, height);
      out.push(color[0], color[1], color[2], color[3]);
      out.push(borderRadius);
      out.push(borderWidth);
      out.push(borderColor[0], borderColor[1], borderColor[2], borderColor[3]);
      out.push(localOffsets[i][0], localOffsets[i][1]);
    }
  }

  private buildTextVertices(d: UIDrawable, out: number[]): void {
    if (!d.text || !d.fontSize || !d.textColor) return;
    const text = d.text;
    const fontSize = d.fontSize;
    const charW = fontSize * 0.6;
    const charH = fontSize * 1.2;
    const [r, g, b, a] = d.textColor;
    const [px, py] = [d.x, d.y];

    let cursorX = px;
    let cursorY = py;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        cursorX = px;
        cursorY += charH;
        continue;
      }
      const code = text.charCodeAt(i);
      if (code < 32 || code > 126) continue;

      const [u0, v0, u1, v1] = getGlyphUV(code);
      const x0 = cursorX;
      const x1 = cursorX + charW;
      const y0 = cursorY;
      const y1 = cursorY + charH;

      const corners = [
        [x0, y0], [x1, y0], [x1, y1],
        [x0, y0], [x1, y1], [x0, y1],
      ];
      const uvs = [
        [u0, v0], [u1, v0], [u1, v1],
        [u0, v0], [u1, v1], [u0, v1],
      ];
      for (let j = 0; j < 6; j++) {
        out.push(corners[j][0], corners[j][1]);
        out.push(uvs[j][0], uvs[j][1]);
        out.push(r, g, b, a);
      }
      cursorX += charW;
    }
  }

  private buildImageVertices(d: UIDrawable, out: number[]): void {
    if (!d.uv) return;
    const { x, y, width, height, color, uv } = d;
    const [u0, v0, u1, v1] = uv;
    const [r, g, b, a] = color;
    const corners = [
      [x, y], [x + width, y], [x + width, y + height],
      [x, y], [x + width, y + height], [x, y + height],
    ];
    const uvs = [
      [u0, v0], [u1, v0], [u1, v1],
      [u0, v0], [u1, v1], [u0, v1],
    ];
    for (let i = 0; i < 6; i++) {
      out.push(corners[i][0], corners[i][1]);
      out.push(uvs[i][0], uvs[i][1]);
      out.push(r, g, b, a);
    }
  }

  private buildCanvasTextVertices(d: UIDrawable, entries: { verts: number[]; textureView: GPUTextureView }[]): void {
    if (!d.text || !d.fontSize || !d.textColor || !d.fontFamily || !this.textCache) return;
    const opts = {
      fontFamily: d.fontFamily,
      fontSize: d.fontSize,
      fontWeight: d.fontWeight ?? "normal",
      color: `rgba(${Math.round(d.textColor[0] * 255)},${Math.round(d.textColor[1] * 255)},${Math.round(d.textColor[2] * 255)},${d.textColor[3]})`,
      textAlign: d.textAlign ?? "left",
      textBaseline: "top" as CanvasTextBaseline,
    };

    const lines = d.maxWidth && d.maxWidth > 0
      ? this.textCache.wrapText(d.text, opts, d.maxWidth)
      : d.text.split("\n");

    let yOffset = 0;
    for (const line of lines) {
      if (line.length === 0) {
        yOffset += d.fontSize * 1.3;
        continue;
      }
      const entry = this.textCache.getText(line, opts);
      if (!entry || !entry.view) {
        yOffset += d.fontSize * 1.3;
        continue;
      }
      let entryObj = entries.find((e) => e.textureView === entry.view);
      if (!entryObj) {
        entryObj = { verts: [], textureView: entry.view };
        entries.push(entryObj);
      }
      const [u0, v0, u1, v1] = entry.uv;
      const [r, g, b, a] = d.textColor;
      const x = d.x;
      const y = d.y + yOffset;
      const w = entry.width;
      const h = entry.height;
      const corners = [
        [x, y], [x + w, y], [x + w, y + h],
        [x, y], [x + w, y + h], [x, y + h],
      ];
      const uvs = [
        [u0, v0], [u1, v0], [u1, v1],
        [u0, v0], [u1, v1], [u0, v1],
      ];
      for (let i = 0; i < 6; i++) {
        entryObj.verts.push(corners[i][0], corners[i][1]);
        entryObj.verts.push(uvs[i][0], uvs[i][1]);
        entryObj.verts.push(r, g, b, a);
      }
      yOffset += d.fontSize * 1.3;
    }
  }

  private buildLineVertices(d: UIDrawable, out: number[]): void {
    if (!d.lines) return;
    const [r, g, b, a] = d.color;
    for (let i = 0; i < d.lines.length; i += 4) {
      const x1 = d.x + d.lines[i];
      const y1 = d.y + d.lines[i + 1];
      const x2 = d.x + d.lines[i + 2];
      const y2 = d.y + d.lines[i + 3];
      out.push(x1, y1, r, g, b, a);
      out.push(x2, y2, r, g, b, a);
    }
  }

  getTextCache(): TextAtlasCache | null {
    return this.textCache;
  }

  destroy(): void {
    this.quadVertexBuffer?.destroy();
    this.textVertexBuffer?.destroy();
    this.imageVertexBuffer?.destroy();
    this.lineVertexBuffer?.destroy();
    this.screenBuffer?.destroy();
    this.glyphAtlasTexture?.destroy();
    this.textCache?.destroy();
    this.quadVertexBuffer = null;
    this.textVertexBuffer = null;
    this.imageVertexBuffer = null;
    this.lineVertexBuffer = null;
    this.screenBuffer = null;
    this._screenView = null;
    this._screenBuf = null;
    this.glyphAtlasTexture = null;
    this.textCache = null;
    this.quadPipeline = null;
    this.textPipeline = null;
    this.imagePipeline = null;
    this.linePipeline = null;
    this.prepared = false;
  }
}
