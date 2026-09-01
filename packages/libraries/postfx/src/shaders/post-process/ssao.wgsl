// SSAO — screen-space ambient occlusion: compute AO factor from depth + normals + noise.
struct U {
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  kernelSize: f32,
  radius: f32,
  bias: f32,
  noiseScale: vec2<f32>,
  screenSize: vec2<f32>,
  _p0: f32,
  _p1: f32,
};
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var normalTex: texture_2d<f32>;
@group(0) @binding(2) var noiseTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> u: U;

fn reconstructViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec3<f32>(uv * 2.0 - 1.0, depth);
  let clip = vec4<f32>(ndc, 1.0);
  let viewPos = u.invProjection * clip;
  return viewPos.xyz / viewPos.w;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  // All textureSample calls must be in uniform control flow (before any branching).
  let depth = textureSample(depthTex, samp, uv);
  let worldNormal = textureSample(normalTex, samp, uv).xyz * 2.0 - 1.0;
  let noiseVal = textureSample(noiseTex, samp, uv * u.noiseScale).xy;

  if (depth >= 1.0) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }

  let viewPos = reconstructViewPos(uv, depth);
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);

  let rotAngle = noiseVal.x * 6.2831853;
  let rotMat = mat2x2<f32>(
    vec2<f32>(cos(rotAngle), -sin(rotAngle)),
    vec2<f32>(sin(rotAngle), cos(rotAngle)),
  );

  var occlusion = 0.0;
  let kernelSize = u32(u.kernelSize);
  let kernelSizeF = u.kernelSize;
  let radius = u.radius;
  let dims = textureDimensions(depthTex);

  for (var i = 0u; i < 64u; i = i + 1u) {
    if (i >= kernelSize) { break; }
    let sampleDir = vec3<f32>(
      f32(i) / kernelSizeF * 2.0 - 1.0,
      fract(f32(i) * 0.6180339887) * 2.0 - 1.0,
      fract(f32(i) * 0.4142135623),
    );
    let sampleDirNorm = normalize(sampleDir);
    let scaledDir = sampleDirNorm * (fract(f32(i) * 0.12345) * 0.9 + 0.1) * radius;
    let rotatedDir = vec3<f32>(rotMat * scaledDir.xy, scaledDir.z);
    let samplePos = viewPos + rotatedDir;

    let sampleClip = u.projection * vec4<f32>(samplePos, 1.0);
    let sampleNDC = sampleClip.xyz / sampleClip.w;
    let sampleUV = sampleNDC.xy * 0.5 + 0.5;
    // Use textureLoad (works in non-uniform control flow) instead of textureSample.
    let icoords = vec2<u32>(clamp(vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))), vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1)));
    let sampleDepth = textureLoad(depthTex, icoords, 0);
    let sampleViewPos = reconstructViewPos(sampleUV, sampleDepth);

    if (samplePos.z - sampleViewPos.z > u.bias) {
      occlusion += 1.0;
    }
  }

  let ao = 1.0 - occlusion / kernelSizeF;
  let result = clamp(ao, 0.0, 1.0);
  return vec4<f32>(result, result, result, 1.0);
}
