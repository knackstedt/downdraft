import { type Mat4 } from "wgpu-matrix";
import type { DebugDrawQueue, DebugText } from "../../debug-draw/queue.ts";
import { RenderPass } from "../render-pass.ts";

import DEBUG_LINE_SHADER from "../shaders/debug/debug-line.wgsl?raw";
import DEBUG_POINT_SHADER from "../shaders/debug/debug-point.wgsl?raw";
import DEBUG_TEXT_SHADER from "../shaders/debug/debug-text.wgsl?raw";

const LINE_STRIDE = 28;
const POINT_STRIDE = 32;

const GLYPH_W = 8;
const GLYPH_H = 12;
const GLYPHS_PER_ROW = 16;
const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;
const TEXT_VERTEX_STRIDE = 36; // 3 pos + 2 uv + 4 color = 9 floats * 4 bytes

const ASCII_FONT: Record<number, string[]> = {};

function initAsciiFont(): void {
  const chars = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_abcdefghijklmnopqrstuvwxyz{|}~";
  for (let i = 0; i < chars.length; i++) {
    const code = chars.charCodeAt(i);
    ASCII_FONT[code] = getGlyphPattern(chars[i]);
  }
}

function getGlyphPattern(ch: string): string[] {
  const patterns: Record<string, string[]> = {
    ' ': ['........', '........', '........', '........', '........', '........', '........', '........', '........', '........', '........', '........'],
    '!': ['...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '........', '........', '...XX...', '...XX...', '........', '........'],
    '"': ['..XX.XX.', '..XX.XX.', '..XX.XX.', '........', '........', '........', '........', '........', '........', '........', '........', '........'],
    '#': ['..XX.XX.', '..XX.XX.', '..XX.XX.', 'XXXXXXXX', '..XX.XX.', 'XXXXXXXX', '..XX.XX.', '..XX.XX.', '..XX.XX.', '........', '........', '........'],
    '$': ['...XXX..', '.XX.X.X.', '.X..X...', '.XX.XX..', '...X.XX.', '.X..X.X.', '.XX.X.X.', '..XXX...', '........', '........', '........', '........'],
    '%': ['XX...XX.', 'XX..XX..', '...XX...', '..XX....', '..XX....', '...XX...', '..XX..XX', 'XX...XX.', '........', '........', '........', '........'],
    '&': ['..XXX...', '.XX.XX..', '.XX.XX..', '..XX....', '.XX.XXX.', 'XX.X.XX.', 'X..XX.X.', '.XXX..X.', '........', '........', '........', '........'],
    '\'': ['...XX...', '...XX...', '...XX...', '........', '........', '........', '........', '........', '........', '........', '........', '........'],
    '(': ['....XX..', '...XX...', '..XX....', '..XX....', '..XX....', '..XX....', '..XX....', '...XX...', '....XX..', '........', '........', '........'],
    ')': ['..XX....', '...XX...', '....XX..', '....XX..', '....XX..', '....XX..', '....XX..', '...XX...', '..XX....', '........', '........', '........'],
    '*': ['........', '..X..X..', '.XX.XXX.', 'X.XXX.X.', '.XX.XXX.', '..X..X..', '........', '........', '........', '........', '........', '........'],
    '+': ['........', '........', '...XX...', '...XX...', '...XX...', 'XXXXXXX.', '...XX...', '...XX...', '...XX...', '........', '........', '........'],
    ',': ['........', '........', '........', '........', '........', '........', '........', '...XX...', '...XX...', '..XX....', '........', '........'],
    '-': ['........', '........', '........', '........', 'XXXXXXX.', 'XXXXXXX.', '........', '........', '........', '........', '........', '........'],
    '.': ['........', '........', '........', '........', '........', '........', '........', '...XX...', '...XX...', '........', '........', '........'],
    '/': ['......XX', '.....XX.', '....XX..', '...XX...', '..XX....', '.XX.....', 'XX......', 'XX......', '........', '........', '........', '........'],
    '0': ['..XXX...', '.XX.XX..', '.X...X..', 'X..X..X.', 'X..X..X.', 'X..X..X.', '.X...X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    '1': ['...XX...', '..XXX...', '.XXXX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', 'XXXXXXX.', '........', '........', '........'],
    '2': ['..XXX...', '.XX.XX..', 'X....X..', '....XX..', '..XX....', '.XX.....', 'XX......', 'XXXXXXX.', 'XXXXXXX.', '........', '........', '........'],
    '3': ['..XXX...', '.XX.XX..', 'X....X..', '...XX...', '...XXX..', '......X.', 'X....X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    '4': ['....XX..', '...XXX..', '..X.XX..', '.X..XX..', 'X...XX..', 'XXXXXXX.', '....XX..', '....XX..', '....XX..', '........', '........', '........'],
    '5': ['XXXXXXX.', 'XX......', 'XX......', 'XXXXX...', '....XX..', '......X.', 'X....X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    '6': ['..XXX...', '.XX.XX..', 'XX......', 'XXXXX...', 'XX.X.XX.', 'X....X..', '.X...X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    '7': ['XXXXXXX.', 'X....X..', '....X...', '...X....', '..X.....', '..X.....', '.XX.....', '.XX.....', '.XX.....', '........', '........', '........'],
    '8': ['..XXX...', '.XX.XX..', '.X...X..', '.XX.XX..', '..XXX...', '.XX.XX..', '.X...X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    '9': ['..XXX...', '.XX.XX..', '.X...X..', '.XX..XX.', '..XX.XX.', '....XX..', '...XX...', '..XX....', '.XXX....', '........', '........', '........'],
    ':': ['........', '........', '...XX...', '...XX...', '........', '........', '...XX...', '...XX...', '........', '........', '........', '........'],
    ';': ['........', '........', '...XX...', '...XX...', '........', '........', '...XX...', '...XX...', '..XX....', '........', '........', '........'],
    '<': ['....XX..', '...XX...', '..XX....', '.XX.....', '.XX.....', '..XX....', '...XX...', '....XX..', '........', '........', '........', '........'],
    '=': ['........', '........', 'XXXXXXX.', 'XXXXXXX.', '........', 'XXXXXXX.', 'XXXXXXX.', '........', '........', '........', '........', '........'],
    '>': ['..XX....', '...XX...', '....XX..', '.....XX.', '.....XX.', '....XX..', '...XX...', '..XX....', '........', '........', '........', '........'],
    '?': ['..XXX...', '.XX.XX..', 'X....X..', '....XX..', '...XX...', '...XX...', '........', '...XX...', '...XX...', '........', '........', '........'],
    '@': ['..XXX...', '.XX.XX..', 'X.XX.X..', 'X.XX.X..', 'X.XXXX..', 'X.XX....', '.X.XX.X.', '.XX..XX.', '..XXXX..', '........', '........', '........'],
    'A': ['..XXX...', '.XX.XX..', '.X...X..', '.X...X..', 'XXXXXXX.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'B': ['XXXXXX..', 'X.....X.', 'X.....X.', 'XXXXXX..', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'XXXXXX..', '........', '........', '........'],
    'C': ['..XXX...', '.XX.XX..', 'X.....X.', 'X......', 'X......', 'X......', 'X.....X.', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'D': ['XXXXX...', 'X....X..', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X....X..', 'XXXXX...', '........', '........', '........', '........'],
    'E': ['XXXXXXX.', 'X......', 'X......', 'XXXXX...', 'X......', 'X......', 'X......', 'X......', 'XXXXXXX.', '........', '........', '........'],
    'F': ['XXXXXXX.', 'X......', 'X......', 'XXXXX...', 'X......', 'X......', 'X......', 'X......', 'X......', '........', '........', '........'],
    'G': ['..XXX...', '.XX.XX..', 'X.....X.', 'X......', 'X..XXX..', 'X.....X.', '.X...X..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'H': ['X.....X.', 'X.....X.', 'X.....X.', 'XXXXXXX.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'I': ['XXXXXXX.', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', 'XXXXXXX.', '........', '........', '........'],
    'J': ['..XXXXX.', '....XX..', '....XX..', '....XX..', '....XX..', 'X...XX..', 'X..XX...', '.XXX....', '........', '........', '........', '........'],
    'K': ['X.....X.', 'X....X..', 'X...X...', 'XXXX....', 'X...X...', 'X....X..', 'X.....X.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'L': ['X......', 'X......', 'X......', 'X......', 'X......', 'X......', 'X......', 'X......', 'XXXXXXX.', '........', '........', '........'],
    'M': ['X.....X.', 'XX...XX.', 'XX.X.XX.', 'XX.X.XX.', 'X.X.X.X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'N': ['X.....X.', 'XX....X.', 'X.X...X.', 'X.X...X.', 'X..X..X.', 'X...X.X.', 'X....XX.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'O': ['..XXX...', '.XX.XX..', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'P': ['XXXXXX..', 'X.....X.', 'X.....X.', 'X.....X.', 'XXXXXX..', 'X......', 'X......', 'X......', 'X......', '........', '........', '........'],
    'Q': ['..XXX...', '.XX.XX..', 'X.....X.', 'X.....X.', 'X.....X.', 'X...X.X.', 'X....X..', '.XX.XX..', '..XXX.X.', '........', '........', '........'],
    'R': ['XXXXXX..', 'X.....X.', 'X.....X.', 'X.....X.', 'XXXXXX..', 'X...X...', 'X....X..', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'S': ['..XXX...', '.XX.XX..', 'X......', '.XX.....', '..XXX...', '....XX..', '......X.', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'T': ['XXXXXXX.', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '........', '........', '........'],
    'U': ['X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'V': ['X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', '.X...X..', '.X...X..', '..X.X...', '..X.X...', '...X....', '........', '........', '........'],
    'W': ['X.....X.', 'X.....X.', 'X.....X.', 'X.....X.', 'X.X.X.X.', 'XX.X.XX.', 'XX.X.XX.', 'XX...XX.', 'X.....X.', '........', '........', '........'],
    'X': ['X.....X.', 'X.....X.', '.X...X..', '..X.X...', '...X....', '..X.X...', '.X...X..', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'Y': ['X.....X.', 'X.....X.', '.X...X..', '..X.X...', '...X....', '...X....', '...X....', '...X....', '...X....', '........', '........', '........'],
    'Z': ['XXXXXXX.', '......X.', '....X...', '...X....', '..X.....', '.X......', 'X......', 'X......', 'XXXXXXX.', '........', '........', '........'],
    '[': ['..XXXX..', '..XX....', '..XX....', '..XX....', '..XX....', '..XX....', '..XX....', '..XX....', '..XXXX..', '........', '........', '........'],
    '\\': ['XX......', 'XX......', '.XX.....', '..XX....', '...XX...', '....XX..', '.....XX.', '......XX', '........', '........', '........', '........'],
    ']': ['..XXXX..', '....XX..', '....XX..', '....XX..', '....XX..', '....XX..', '....XX..', '....XX..', '..XXXX..', '........', '........', '........'],
    '^': ['...X....', '..X.X...', '.X...X..', 'X.....X.', '........', '........', '........', '........', '........', '........', '........', '........'],
    '_': ['........', '........', '........', '........', '........', '........', '........', '........', 'XXXXXXX.', '........', '........', '........'],
    '`': ['..XX....', '...XX...', '....XX..', '........', '........', '........', '........', '........', '........', '........', '........', '........'],
    'a': ['........', '........', '........', '..XXX...', '....XX..', '..XX.XX.', 'X...XX..', '.XX.XX..', '..XX.X..', '........', '........', '........'],
    'b': ['X......', 'X......', 'X......', 'X.XXX...', 'XX..XX..', 'X...XX..', 'X...XX..', 'XX..XX..', 'X.XXX...', '........', '........', '........'],
    'c': ['........', '........', '........', '..XXX...', '.XX.XX..', 'X......', 'X......', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'd': ['....XX..', '....XX..', '....XX..', '..XXX.X.', '.XX..XX.', 'X...XX..', 'X...XX..', '.XX..XX.', '..XXX.X.', '........', '........', '........'],
    'e': ['........', '........', '........', '..XXX...', '.XX.XX..', 'XXXXXXX.', 'X......', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'f': ['...XX...', '..XX.X..', '..XX....', 'XXXXX...', '..XX....', '..XX....', '..XX....', '..XX....', '..XX....', '........', '........', '........'],
    'g': ['........', '........', '........', '..XXX.X.', '.XX..XX.', 'X...XX..', 'X...XX..', '.XX..XX.', 'X..XX.X.', 'X..XX...', '.XXX....'],
    'h': ['X......', 'X......', 'X......', 'X.XXX...', 'XX..XX..', 'X...XX..', 'X...XX..', 'X...XX..', 'X...XX..', '........', '........', '........'],
    'i': ['...XX...', '........', '........', '..XXX...', '...XX...', '...XX...', '...XX...', '...XX...', '..XXXX..', '........', '........', '........'],
    'j': ['....XX..', '........', '........', '...XXX..', '....XX..', '....XX..', '....XX..', 'X...XX..', 'X..XX...', '.XXX....', '........', '........'],
    'k': ['X......', 'X......', 'X......', 'X..XX...', 'X.X.X...', 'XX......', 'X.X.X...', 'X..XX...', 'X...XX..', '........', '........', '........'],
    'l': ['..XXX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '..XXXX..', '........', '........', '........'],
    'm': ['........', '........', '........', 'XX.XX...', 'X.X.X.X.', 'X.X.X.X.', 'X.X.X.X.', 'X.....X.', 'X.....X.', '........', '........', '........'],
    'n': ['........', '........', '........', 'X.XXX...', 'XX..XX..', 'X...XX..', 'X...XX..', 'X...XX..', 'X...XX..', '........', '........', '........'],
    'o': ['........', '........', '........', '..XXX...', '.XX.XX..', 'X...XX..', 'X...XX..', '.XX.XX..', '..XXX...', '........', '........', '........'],
    'p': ['........', '........', '........', 'X.XXX...', 'XX..XX..', 'X...XX..', 'X...XX..', 'XX..XX..', 'X.XXX...', 'X......', 'X......', 'X......'],
    'q': ['........', '........', '........', '..XXX.X.', '.XX..XX.', 'X...XX..', 'X...XX..', '.XX..XX.', '..XXX.X.', '....XX..', '....XX..', '....XX..'],
    'r': ['........', '........', '........', 'X.XXX...', 'XX..XX..', 'X......', 'X......', 'X......', 'X......', '........', '........', '........'],
    's': ['........', '........', '........', '..XXX.X.', '.XX..XX.', '..XXX...', '...XX.X.', '.XX..XX.', 'X.XXX...', '........', '........', '........'],
    't': ['..XX....', '..XX....', '..XX....', 'XXXXX...', '..XX....', '..XX....', '..XX.X..', '...XX...', '..XXX.X.', '........', '........', '........'],
    'u': ['........', '........', '........', 'X...XX..', 'X...XX..', 'X...XX..', 'X...XX..', '.XX..XX.', '..XXX.X.', '........', '........', '........'],
    'v': ['........', '........', '........', 'X.....X.', 'X.....X.', '.X...X..', '.X...X..', '..X.X...', '...X....', '........', '........', '........'],
    'w': ['........', '........', '........', 'X.....X.', 'X.....X.', 'X.X.X.X.', 'XX.X.XX.', 'XX.X.XX.', 'X.....X.', '........', '........', '........'],
    'x': ['........', '........', '........', 'X...XX..', '.X.XX...', '..XX....', '..XX....', '.X.XX...', 'X...XX..', '........', '........', '........'],
    'y': ['........', '........', '........', 'X...XX..', 'X...XX..', 'X...XX..', '.XX..XX.', '..XXX.X.', '....XX..', '...XX...', '..XX....'],
    'z': ['........', '........', '........', 'XXXXXXX.', '....XX..', '..XX....', '.XX.....', 'XX......', 'XXXXXXX.', '........', '........', '........'],
    '{': ['...XXX..', '..XX....', '..XX....', '.XX.....', 'XXX.....', '.XX.....', '..XX....', '..XX....', '...XXX..', '........', '........', '........'],
    '|': ['...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '........', '........', '........'],
    '}': ['..XXX...', '....XX..', '....XX..', '.....XX.', '.....XXX', '.....XX.', '....XX..', '....XX..', '..XXX...', '........', '........', '........'],
    '~': ['........', '........', '.XX..XX.', 'X.XX.X.X', 'X..XX.X.', '........', '........', '........', '........', '........', '........', '........'],
  };
  return patterns[ch] ?? patterns[' '];
}

function buildGlyphAtlasData(): Uint8Array {
  const atlasW = ATLAS_COLS * GLYPH_W;
  const atlasH = ATLAS_ROWS * GLYPH_H;
  const data = new Uint8Array(atlasW * atlasH);
  const chars = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_abcdefghijklmnopqrstuvwxyz{|}~";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = chars.charCodeAt(i);
    const pattern = ASCII_FONT[code] ?? getGlyphPattern(ch);
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    const baseX = col * GLYPH_W;
    const baseY = row * GLYPH_H;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        const rowStr = pattern[y] ?? '........';
        const px = rowStr[x] === 'X' ? 255 : 0;
        data[(baseY + y) * atlasW + (baseX + x)] = px;
      }
    }
  }
  return data;
}

function getGlyphUV(code: number): [number, number, number, number] {
  const chars = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_abcdefghijklmnopqrstuvwxyz{|}~";
  const idx = chars.indexOf(String.fromCharCode(code));
  if (idx < 0) return [0, 0, 0, 0];
  const col = idx % ATLAS_COLS;
  const row = Math.floor(idx / ATLAS_COLS);
  const atlasW = ATLAS_COLS * GLYPH_W;
  const atlasH = ATLAS_ROWS * GLYPH_H;
  const u0 = (col * GLYPH_W) / atlasW;
  const v0 = (row * GLYPH_H) / atlasH;
  const u1 = ((col + 1) * GLYPH_W) / atlasW;
  const v1 = ((row + 1) * GLYPH_H) / atlasH;
  return [u0, v0, u1, v1];
}

export class DebugRenderPass extends RenderPass {
  name = "debug";
  surfaceHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private debugQueue: DebugDrawQueue | null = null;
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private linePipeline: GPURenderPipeline | null = null;
  private pointPipeline: GPURenderPipeline | null = null;
  private lineVertexBuffer: GPUBuffer | null = null;
  private pointVertexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private lineBindGroup: GPUBindGroup | null = null;
  private pointBindGroup: GPUBindGroup | null = null;
  private lineShaderModule: GPUShaderModule | null = null;
  private pointShaderModule: GPUShaderModule | null = null;
  private maxLineVertices: number = 8192;
  private maxPointVertices: number = 4096;
  private maxTextVertices: number = 16384;
  private textPipeline: GPURenderPipeline | null = null;
  private textShaderModule: GPUShaderModule | null = null;
  private textVertexBuffer: GPUBuffer | null = null;
  private textBindGroup: GPUBindGroup | null = null;
  private glyphAtlasTexture: GPUTexture | null = null;
  private glyphSampler: GPUSampler | null = null;
  private cameraBufferSize: number = 80;
  private screenWidth: number = 0;
  private screenHeight: number = 0;
  private fontInitialized: boolean = false;

  constructor(surfaceFormat: GPUTextureFormat = "rgba16float") {
    super();
    this.surfaceFormat = surfaceFormat;
  }

  setDebugQueue(queue: DebugDrawQueue): void {
    this.debugQueue = queue;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    if (!this.fontInitialized) {
      initAsciiFont();
      this.fontInitialized = true;
    }
    this.lineShaderModule = device.createShaderModule({ code: DEBUG_LINE_SHADER });
    this.pointShaderModule = device.createShaderModule({ code: DEBUG_POINT_SHADER });
    this.textShaderModule = device.createShaderModule({ code: DEBUG_TEXT_SHADER });

    this.cameraBuffer = device.createBuffer({
      size: this.cameraBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lineVertexBuffer = device.createBuffer({
      size: this.maxLineVertices * LINE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.pointVertexBuffer = device.createBuffer({
      size: this.maxPointVertices * POINT_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.textVertexBuffer = device.createBuffer({
      size: this.maxTextVertices * TEXT_VERTEX_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Build glyph atlas texture
    const atlasData = buildGlyphAtlasData();
    const atlasW = ATLAS_COLS * GLYPH_W;
    const atlasH = ATLAS_ROWS * GLYPH_H;
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

    this.linePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.lineShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: LINE_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.lineShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "line-list" },
    });

    this.pointPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.pointShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: POINT_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x4" },
            { shaderLocation: 2, offset: 28, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: this.pointShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "point-list" },
    });

    this.lineBindGroup = device.createBindGroup({
      layout: this.linePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.pointBindGroup = device.createBindGroup({
      layout: this.pointPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.textPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.textShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: TEXT_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
            { shaderLocation: 2, offset: 20, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: this.textShaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.textBindGroup = device.createBindGroup({
      layout: this.textPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.glyphAtlasTexture.createView() },
        { binding: 2, resource: this.glyphSampler },
      ],
    });
  }

  setCameraViewProj(viewProj: Mat4): void {
    if (!this.device || !this.cameraBuffer) return;
    const data = new Float32Array(20);
    data.set(viewProj as Float32Array, 0);
    data[16] = this.screenWidth;
    data[17] = this.screenHeight;
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.surfaceHandle) builder.colorAttachment({ handle: this.surfaceHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.debugQueue || this.debugQueue.isEmpty() || !this.device || !ctx.pass) return;
    if (!this.linePipeline || !this.pointPipeline || !this.lineBindGroup || !this.pointBindGroup) return;

    this.setScreenSize(ctx.width, ctx.height);
    this.setCameraViewProj(ctx.viewProj);

    const lines = this.debugQueue.getLines();
    const points = this.debugQueue.getPoints();

    const tracked = ctx.pass;

    if (lines.length > 0) {
      const vertexCount = Math.min(lines.length * 2, this.maxLineVertices);
      const data = new Float32Array(vertexCount * 7);
      let offset = 0;
      for (let i = 0; i < lines.length && offset / 7 < this.maxLineVertices; i++) {
        const line = lines[i];
        data[offset++] = line.from[0];
        data[offset++] = line.from[1];
        data[offset++] = line.from[2];
        data[offset++] = line.color[0];
        data[offset++] = line.color[1];
        data[offset++] = line.color[2];
        data[offset++] = line.color[3];
        data[offset++] = line.to[0];
        data[offset++] = line.to[1];
        data[offset++] = line.to[2];
        data[offset++] = line.color[0];
        data[offset++] = line.color[1];
        data[offset++] = line.color[2];
        data[offset++] = line.color[3];
      }
      this.device.queue.writeBuffer(this.lineVertexBuffer!, 0, data.subarray(0, vertexCount * 7) as unknown as BufferSource);
      tracked.setPipeline(this.linePipeline);
      tracked.setBindGroup(0, this.lineBindGroup);
      tracked.setVertexBuffer(0, this.lineVertexBuffer!);
      tracked.draw(vertexCount);
    }

    if (points.length > 0) {
      const vertexCount = Math.min(points.length, this.maxPointVertices);
      const data = new Float32Array(vertexCount * 8);
      let offset = 0;
      for (let i = 0; i < vertexCount; i++) {
        const pt = points[i];
        data[offset++] = pt.pos[0];
        data[offset++] = pt.pos[1];
        data[offset++] = pt.pos[2];
        data[offset++] = pt.color[0];
        data[offset++] = pt.color[1];
        data[offset++] = pt.color[2];
        data[offset++] = pt.color[3];
        data[offset++] = pt.size;
      }
      this.device.queue.writeBuffer(this.pointVertexBuffer!, 0, data.subarray(0, vertexCount * 8) as unknown as BufferSource);
      tracked.setPipeline(this.pointPipeline);
      tracked.setBindGroup(0, this.pointBindGroup);
      tracked.setVertexBuffer(0, this.pointVertexBuffer!);
      tracked.draw(vertexCount);
    }

    const texts = this.debugQueue.getTexts();
    if (texts.length > 0 && this.textPipeline && this.textBindGroup) {
      const vertices: number[] = [];
      for (const t of texts) {
        this.buildTextVertices(t, vertices);
      }
      const vertexCount = Math.min(Math.floor(vertices.length / 9), this.maxTextVertices);
      if (vertexCount > 0) {
        const data = new Float32Array(vertexCount * 9);
        for (let i = 0; i < vertexCount * 9; i++) {
          data[i] = vertices[i];
        }
        this.device.queue.writeBuffer(this.textVertexBuffer!, 0, data as unknown as BufferSource);
        tracked.setPipeline(this.textPipeline);
        tracked.setBindGroup(0, this.textBindGroup);
        tracked.setVertexBuffer(0, this.textVertexBuffer!);
        tracked.draw(vertexCount);
      }
    }

    this.debugQueue.clearFrame();
  }

  private buildTextVertices(t: DebugText, out: number[]): void {
    const chars = t.text;
    const len = chars.length;
    const totalW = len * GLYPH_W;
    const [r, g, b, a] = t.color;
    const [px, py, pz] = t.pos;

    for (let i = 0; i < len; i++) {
      const code = chars.charCodeAt(i);
      if (code < 32 || code > 126) continue;
      const [u0, v0, u1, v1] = getGlyphUV(code);
      const x0 = i * GLYPH_W;
      const x1 = x0 + GLYPH_W;
      const y0 = 0;
      const y1 = GLYPH_H;

      if (t.screenSpace) {
        // screen space: z = -1 signals screen mode
        // 4 corners: (x0,y0), (x1,y0), (x1,y1), (x0,y1)
        // 2 triangles: (0,1,2) and (0,2,3)
        const corners = [
          [px + x0, py + y0, -1.0],
          [px + x1, py + y0, -1.0],
          [px + x1, py + y1, -1.0],
          [px + x0, py + y1, -1.0],
        ];
        const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        const indices = [0, 1, 2, 0, 2, 3];
        for (const idx of indices) {
          out.push(corners[idx][0], corners[idx][1], corners[idx][2]);
          out.push(uvs[idx][0], uvs[idx][1]);
          out.push(r, g, b, a);
        }
      } else {
        // world space: offset each glyph quad in world units (scaled)
        const scale = 0.01;
        const sx0 = px + x0 * scale;
        const sx1 = px + x1 * scale;
        const sy0 = py + y0 * scale;
        const sy1 = py + y1 * scale;
        const corners = [
          [sx0, sy0, pz],
          [sx1, sy0, pz],
          [sx1, sy1, pz],
          [sx0, sy1, pz],
        ];
        const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        const indices = [0, 1, 2, 0, 2, 3];
        for (const idx of indices) {
          out.push(corners[idx][0], corners[idx][1], corners[idx][2]);
          out.push(uvs[idx][0], uvs[idx][1]);
          out.push(r, g, b, a);
        }
      }
    }
  }

  destroy(): void {
    this.lineVertexBuffer?.destroy();
    this.pointVertexBuffer?.destroy();
    this.textVertexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.glyphAtlasTexture?.destroy();
    this.lineVertexBuffer = null;
    this.pointVertexBuffer = null;
    this.textVertexBuffer = null;
    this.cameraBuffer = null;
    this.glyphAtlasTexture = null;
    this.textPipeline = null;
    this.textBindGroup = null;
  }
}
