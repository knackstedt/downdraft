struct PostProcessUniforms {
  texelSize: vec2<f32>,
  depthEdgeStrength: f32,
  normalEdgeStrength: f32,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> uniforms: PostProcessUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.clipPos = vec4(p[vi], 0.0, 1.0);
  output.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(colorTex, samp, input.uv);
  let depth = textureSample(depthTex, samp, input.uv);

  // Depth edge detection — sample 4 neighbours
  let depthR = textureSample(depthTex, samp, input.uv + vec2(uniforms.texelSize.x, 0.0));
  let depthL = textureSample(depthTex, samp, input.uv - vec2(uniforms.texelSize.x, 0.0));
  let depthU = textureSample(depthTex, samp, input.uv + vec2(0.0, uniforms.texelSize.y));
  let depthD = textureSample(depthTex, samp, input.uv - vec2(0.0, uniforms.texelSize.y));

  var diff = 0.0;
  diff += clamp(depthR - depth, 0.0, 1.0);
  diff += clamp(depthL - depth, 0.0, 1.0);
  diff += clamp(depthU - depth, 0.0, 1.0);
  diff += clamp(depthD - depth, 0.0, 1.0);

  let dei = floor(smoothstep(0.01, 0.02, diff) * 2.0) / 2.0;

  let strength = select(1.0, 1.0 - dei * uniforms.depthEdgeStrength, dei > 0.0);

  return vec4(texel.rgb * strength, texel.a);
}
