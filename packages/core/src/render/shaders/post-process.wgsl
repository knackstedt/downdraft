// Post-process: ACES tonemapping + bloom + color grading + FXAA

struct PostProcessUniforms {
  exposure: f32,
  bloomThreshold: f32,
  bloomIntensity: f32,
  gamma: f32,
  contrast: f32,
  saturation: f32,
  vignette: f32,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: PostProcessUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn fxaa(uv: vec2<f32>, texelSize: vec2<f32>) -> vec3<f32> {
  let lumaThreshold = 0.0625;
  let mulReduce = 1.0 / 8.0;
  let minReduce = 1.0 / 128.0;

  let lumaTL = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>(-1.0, -1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaTR = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>( 1.0, -1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaBL = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>(-1.0,  1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaBR = dot(textureSample(sourceTex, texSampler, uv + vec2<f32>( 1.0,  1.0) * texelSize).rgb, vec3<f32>(0.299, 0.587, 0.114));
  let lumaM = dot(textureSample(sourceTex, texSampler, uv).rgb, vec3<f32>(0.299, 0.587, 0.114));

  let lumaMin = min(lumaM, min(min(lumaTL, lumaTR), min(lumaBL, lumaBR)));
  let lumaMax = max(lumaM, max(max(lumaTL, lumaTR), max(lumaBL, lumaBR)));

  let lumaRange = lumaMax - lumaMin;
  if (lumaRange < max(lumaThreshold, lumaMax * mulReduce)) {
    return textureSample(sourceTex, texSampler, uv).rgb;
  }

  let dir = vec2<f32>(
    -((lumaTL + lumaTR) - (lumaBL + lumaBR)),
    ((lumaTL + lumaBL) - (lumaTR + lumaBR)),
  );
  let dirReduce = max(lumaM * mulReduce, minReduce);
  let dirScale = 1.0 / min(abs(dir.x) + abs(dir.y), dirReduce);
  let dirAdj = clamp(dir * dirScale, vec2<f32>(-2.0), vec2<f32>(2.0)) * texelSize;

  let rgbN1 = textureSample(sourceTex, texSampler, uv + dirAdj * 0.5).rgb;
  let rgbN2 = textureSample(sourceTex, texSampler, uv - dirAdj * 0.5).rgb;
  let rgbP1 = textureSample(sourceTex, texSampler, uv + dirAdj * 1.0).rgb;
  let rgbP2 = textureSample(sourceTex, texSampler, uv - dirAdj * 1.0).rgb;

  return (rgbN1 + rgbN2 + rgbP1 + rgbP2) * 0.25;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texelSize = vec2<f32>(1.0 / 1280.0, 1.0 / 720.0);

  var color = fxaa(input.uv, texelSize);
  let bloom = textureSample(bloomTex, texSampler, input.uv).rgb;
  color += bloom * u.bloomIntensity;

  color *= u.exposure;
  color = acesTonemap(color);

  // Contrast
  color = (color - 0.5) * u.contrast + 0.5;

  // Saturation
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  color = mix(vec3<f32>(luma), color, u.saturation);

  // Vignette
  let center = input.uv - 0.5;
  let dist = dot(center, center);
  color *= 1.0 - dist * u.vignette;

  // Gamma correction
  color = pow(color, vec3<f32>(1.0 / u.gamma));

  return vec4<f32>(color, 1.0);
}
