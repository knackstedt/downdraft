// SSAO — Ground-Truth Ambient Occlusion (GTAO).
// Slice-based horizon scanning with cosine-weighted falloff.
// Replaces the basic hemisphere approach with a more accurate GTAO that
// computes per-slice horizons by ray-marching in the view-space slice plane.
struct U {
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  directions: f32,   // number of slice directions (default 4)
  radius: f32,
  bias: f32,
  noiseScale: vec2<f32>,
  screenSize: vec2<f32>,
  power: f32,        // AO contrast power (default 1.5)
  thickness: f32,    // depth thickness for horizon test (default 0.1)
  slices: f32,       // samples per slice direction (default 8)
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

fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  let clip = u.projection * vec4<f32>(viewPos, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3<f32>(ndc.xy * 0.5 + 0.5, ndc.z);
}

// Falloff function: 1 near, 0 at radius
fn falloff(dist: f32) -> f32 {
  return max(0.0, 1.0 - dist / u.radius);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  // All textureSample calls in uniform control flow
  let depth = textureSample(depthTex, samp, uv);
  let worldNormal = textureSample(normalTex, samp, uv).xyz * 2.0 - 1.0;
  let noiseVal = textureSample(noiseTex, samp, uv * u.noiseScale).xy;

  if (depth >= 1.0) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }

  let viewPos = reconstructViewPos(uv, depth);
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);
  let V = normalize(-viewPos);

  let rotAngle = noiseVal.x * 6.2831853;
  let numDirs = u32(clamp(u.directions, 1.0, 8.0));
  let numSamples = u32(clamp(u.slices, 2.0, 16.0));
  let dims = textureDimensions(depthTex);

  var occlusion = 0.0;

  for (var d = 0u; d < 8u; d = d + 1u) {
    if (d >= numDirs) { break; }
    // Slice direction in screen space, rotated by noise
    let sliceAngle = rotAngle + f32(d) * 6.2831853 / f32(numDirs);
    let sliceDir = vec2<f32>(cos(sliceAngle), sin(sliceAngle));

    // Project slice direction to view space
    // The slice plane contains V and the slice direction projected to view space
    let sliceNormalVS = normalize(vec3<f32>(sliceDir, 0.0));

    // Horizon search in both directions along the slice
    var horizon1 = -1.0;  // max angle in +dir
    var horizon2 = 1.0;   // min angle in -dir

    for (var s = 1u; s < 16u; s = s + 1u) {
      if (s >= numSamples) { break; }
      let t = f32(s) / f32(numSamples);
      let radius = t * u.radius;

      // +direction sample
      let samplePos1 = viewPos + vec3<f32>(sliceDir, 0.0) * radius;
      let screen1 = projectToScreen(samplePos1);
      if (screen1.x >= 0.0 && screen1.x <= 1.0 && screen1.y >= 0.0 && screen1.y <= 1.0) {
        let icoords1 = vec2<u32>(clamp(
          vec2<i32>(i32(screen1.x * f32(dims.x)), i32(screen1.y * f32(dims.y))),
          vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
        ));
        let sampleDepth1 = textureLoad(depthTex, icoords1, 0);
        let sampleViewPos1 = reconstructViewPos(screen1.xy, sampleDepth1);
        let depthDiff1 = samplePos1.z - sampleViewPos1.z;
        if (depthDiff1 > u.bias && depthDiff1 < u.thickness * radius) {
          let omega = atan2(sampleViewPos1.z - viewPos.z, length(sampleViewPos1.xy - viewPos.xy));
          horizon1 = max(horizon1, omega);
        }
      }

      // -direction sample
      let samplePos2 = viewPos - vec3<f32>(sliceDir, 0.0) * radius;
      let screen2 = projectToScreen(samplePos2);
      if (screen2.x >= 0.0 && screen2.x <= 1.0 && screen2.y >= 0.0 && screen2.y <= 1.0) {
        let icoords2 = vec2<u32>(clamp(
          vec2<i32>(i32(screen2.x * f32(dims.x)), i32(screen2.y * f32(dims.y))),
          vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
        ));
        let sampleDepth2 = textureLoad(depthTex, icoords2, 0);
        let sampleViewPos2 = reconstructViewPos(screen2.xy, sampleDepth2);
        let depthDiff2 = samplePos2.z - sampleViewPos2.z;
        if (depthDiff2 > u.bias && depthDiff2 < u.thickness * radius) {
          let omega = atan2(sampleViewPos2.z - viewPos.z, length(sampleViewPos2.xy - viewPos.xy));
          horizon2 = min(horizon2, omega);
        }
      }
    }

    // Compute the angle between the normal and the slice plane
    // Project normal onto the slice plane
    let sliceNormal3D = normalize(vec3<f32>(sliceDir, 0.0));
    let Nproj = normalize(N - dot(N, sliceNormal3D) * sliceNormal3D);
    let Nangle = atan2(Nproj.z, length(Nproj.xy));

    // Clamp horizons to the normal hemisphere
    let h1 = max(horizon1, Nangle);
    let h2 = min(horizon2, Nangle);

    // AO contribution from this slice: integral of cos(theta - Nangle) from h2 to h1
    let ao1 = cos(2.0 * h1 - Nangle) - cos(2.0 * Nangle - Nangle);
    let ao2 = cos(2.0 * Nangle - Nangle) - cos(2.0 * h2 - Nangle);
    let sliceAO = clamp((ao1 + ao2) * 0.5, 0.0, 1.0);

    // Weight by the slice's alignment with the normal
    let sliceWeight = abs(dot(Nproj, N));
    occlusion += sliceAO * sliceWeight;
  }

  occlusion = occlusion / f32(numDirs);
  // Apply power for contrast control
  let ao = 1.0 - pow(clamp(occlusion, 0.0, 1.0), u.power);
  let result = clamp(ao, 0.0, 1.0);
  return vec4<f32>(result, result, result, 1.0);
}
