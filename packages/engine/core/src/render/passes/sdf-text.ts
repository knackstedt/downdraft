import type { WgslStruct } from "@downdraft/engine/shader-graph";
import { f32, vec4f, wgsl } from "@downdraft/engine/shader-graph";

export interface SDFGlyph {
  char: string;
  charCode: number;
  x: number;
  y: number;
  width: number;
  height: number;
  advance: number;
  bearingX: number;
  bearingY: number;
}

export interface SDFFontData {
  glyphs: Map<number, SDFGlyph>;
  atlasWidth: number;
  atlasHeight: number;
  fontSize: number;
  distanceRange: number;
  lineHeight: number;
  ascent: number;
  descent: number;
  name: string;
}

export function parseSDFFont(json: string): SDFFontData {
  const data = JSON.parse(json);
  const glyphs = new Map<number, SDFGlyph>();

  if (data.glyphs) {
    data.glyphs.forEach((glyph: any) => {
      glyphs.set(glyph.unicode, {
        char: String.fromCodePoint(glyph.unicode),
        charCode: glyph.unicode,
        x: glyph.planeBounds?.left ?? glyph.x ?? 0,
        y: glyph.planeBounds?.bottom ?? glyph.y ?? 0,
        width: glyph.planeBounds ? glyph.planeBounds.right - glyph.planeBounds.left : (glyph.width ?? 0),
        height: glyph.planeBounds ? glyph.planeBounds.top - glyph.planeBounds.bottom : (glyph.height ?? 0),
        advance: glyph.advance,
        bearingX: glyph.planeBounds?.left ?? 0,
        bearingY: glyph.planeBounds?.top ?? 0,
      });
    });
  }

  return {
    glyphs,
    atlasWidth: data.atlas?.width ?? 512,
    atlasHeight: data.atlas?.height ?? 512,
    fontSize: data.atlas?.size ?? 32,
    distanceRange: data.atlas?.distanceRange ?? 4,
    lineHeight: data.metrics?.lineHeight ?? 1.2,
    ascent: data.metrics?.ascender ?? 0.8,
    descent: data.metrics?.descender ?? -0.2,
    name: data.name ?? "sdf-font",
  };
}

export function layoutSDFText(
  text: string,
  font: SDFFontData,
  fontSize: number,
  maxWidth: number = Infinity,
): { quads: Array<{ x: number; y: number; w: number; h: number; u: number; v: number; uw: number; vh: number }>; width: number; height: number } {
  const scale = fontSize / font.fontSize;
  const quads: Array<{ x: number; y: number; w: number; h: number; u: number; v: number; uw: number; vh: number }> = [];
  let penX = 0;
  let penY = 0;
  const lineHeight = font.lineHeight * fontSize;

  for (let _i = 0, _it = text, _n = _it.length; _i < _n; _i++) { const char = _it[_i];
    const charCode = char.codePointAt(0);
    if (charCode === undefined) continue;

    if (char === "\n") {
      penX = 0;
      penY += lineHeight;
      continue;
    }

    const glyph = font.glyphs.get(charCode);
    if (!glyph) continue;

    if (maxWidth !== Infinity && penX + glyph.advance * scale > maxWidth) {
      penX = 0;
      penY += lineHeight;
    }

    const w = glyph.width * scale;
    const h = glyph.height * scale;
    const x = penX + glyph.bearingX * scale;
    const y = penY - glyph.bearingY * scale + font.ascent * fontSize;

    quads.push({
      x, y, w, h,
      u: glyph.x / font.atlasWidth,
      v: 1.0 - (glyph.y + glyph.height) / font.atlasHeight,
      uw: glyph.width / font.atlasWidth,
      vh: glyph.height / font.atlasHeight,
    });

    penX += glyph.advance * scale;
  }

  return { quads, width: penX, height: penY + lineHeight };
}

const TextUniforms: WgslStruct = wgsl.struct("TextUniforms", {
  color: vec4f,
  outlineColor: vec4f,
  outlineWidth: f32,
  smoothing: f32,
  _pad0: f32,
  _pad1: f32,
});

export const SDF_TEXT_SHADER = /* wgsl */ `
${TextUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: TextUniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(input.position, 0.0, 1.0);
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let sdf = textureSample(atlasTex, texSampler, input.uv).r;
  let smoothing = u.smoothing;
  let outlineThreshold = 0.5 - u.outlineWidth;
  let fillAlpha = smoothstep(0.5 - smoothing, 0.5 + smoothing, sdf);
  let outlineAlpha = smoothstep(outlineThreshold - smoothing, outlineThreshold + smoothing, sdf) - fillAlpha;
  let color = u.color.rgb * fillAlpha + u.outlineColor.rgb * outlineAlpha;
  let alpha = fillAlpha + outlineAlpha * u.outlineColor.a;
  return vec4<f32>(color, alpha);
}
`;
