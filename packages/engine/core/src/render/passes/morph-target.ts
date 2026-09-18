import type { WgslStruct } from "@downdraft/engine/shader-graph";
import { f32, wgsl } from "@downdraft/engine/shader-graph";

export const MAX_MORPH_TARGETS = 64;

const MorphUniforms: WgslStruct = wgsl.struct("MorphUniforms", {
  morphWeights: wgsl.array(f32, MAX_MORPH_TARGETS),
});

export const MORPH_TARGET_CHUNK_WGSL = `
${MorphUniforms.wgsl}

@group(1) @binding(0) var<uniform> morphUniforms: MorphUniforms;

fn applyMorphTargets(basePos: vec3<f32>, vertexIndex: u32) -> vec3<f32> {
  var pos = basePos;
  for (var i: u32 = 0u; i < ${64}u; i++) {
    let w = morphUniforms.morphWeights[i];
    if w > 0.0 {
      pos += morphDeltas[i][vertexIndex] * w;
    }
  }
  return pos;
}
`;

export const MORPH_TARGET_CHUNK_GLSL = `
uniform float morphWeights[${64}];

vec3 applyMorphTargets(vec3 basePos, uint vertexIndex) {
  vec3 pos = basePos;
  for (int i = 0; i < ${64}; i++) {
    float w = morphWeights[i];
    if (w > 0.0) {
      pos += morphDeltas[i].xyz * w;
    }
  }
  return pos;
}
`;
