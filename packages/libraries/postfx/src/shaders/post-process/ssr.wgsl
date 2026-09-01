// SSR — screen-space reflections with ray marching.
struct U {
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  maxSteps: f32,
  thickness: f32,
  maxDistance: f32,
  fadeStart: f32,
  fadeEnd: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var normalTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

fn reconstructViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let viewPos = u.invProjection * clip;
  return viewPos.xyz / viewPos.w;
}

fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  let clip = u.projection * vec4<f32>(viewPos, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3<f32>(ndc.xy * 0.5 + 0.5, ndc.z);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  // All textureSample calls must be in uniform control flow (before any branching).
  let depth = textureSample(depthTex, samp, uv);
  let baseColor = textureSample(colorTex, samp, uv);
  let worldNormal = textureSample(normalTex, samp, uv).xyz * 2.0 - 1.0;

  if (depth >= 1.0) { return baseColor; }

  let viewPos = reconstructViewPos(uv, depth);
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);

  let viewDir = normalize(-viewPos);
  let reflectDir = reflect(-viewDir, N);

  if (reflectDir.z >= 0.0) { return baseColor; }

  let startPos = viewPos;
  let endPos = viewPos + reflectDir * u.maxDistance;

  let startScreen = projectToScreen(startPos);
  let endScreen = projectToScreen(endPos);

  let stepCount = u32(u.maxSteps);
  let stepCountF = u.maxSteps;
  var hitColor = vec3<f32>(0.0);
  var hitAlpha = 0.0;
  let dims = textureDimensions(depthTex);
  let colorDims = textureDimensions(colorTex);

  for (var i = 1u; i < 128u; i = i + 1u) {
    if (i >= stepCount) { break; }
    let t = f32(i) / stepCountF;
    let samplePos = mix(startPos, endPos, t);
    let sampleScreen = projectToScreen(samplePos);

    if (sampleScreen.x < 0.0 || sampleScreen.x > 1.0 || sampleScreen.y < 0.0 || sampleScreen.y > 1.0) { break; }

    // Use textureLoad (works in non-uniform control flow) instead of textureSample.
    let dcoords = vec2<u32>(clamp(vec2<i32>(i32(sampleScreen.x * f32(dims.x)), i32(sampleScreen.y * f32(dims.y))), vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1)));
    let sampleDepth = textureLoad(depthTex, dcoords, 0);
    let sampleViewPos = reconstructViewPos(sampleScreen.xy, sampleDepth);

    let depthDiff = samplePos.z - sampleViewPos.z;
    if (depthDiff > 0.0 && depthDiff < u.thickness) {
      let ccoords = vec2<u32>(clamp(vec2<i32>(i32(sampleScreen.x * f32(colorDims.x)), i32(sampleScreen.y * f32(colorDims.y))), vec2<i32>(0, 0), vec2<i32>(i32(colorDims.x) - 1, i32(colorDims.y) - 1)));
      hitColor = textureLoad(colorTex, ccoords, 0).rgb;
      let dist = length(samplePos - viewPos);
      let fade = 1.0 - smoothstep(u.fadeStart, u.fadeEnd, dist);
      let edgeFade = smoothstep(0.0, 0.1, sampleScreen.x) * smoothstep(0.0, 0.1, 1.0 - sampleScreen.x) *
                     smoothstep(0.0, 0.1, sampleScreen.y) * smoothstep(0.0, 0.1, 1.0 - sampleScreen.y);
      hitAlpha = fade * edgeFade;
      break;
    }
  }

  return vec4<f32>(mix(baseColor.rgb, hitColor, hitAlpha), baseColor.a);
}
