// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// DOF — depth-of-field with circle-of-confusion + bokeh-shaped disk sampling.
// Computes CoC from depth, then gathers a rotated disk kernel with shape
// support (circle / hexagon / octagon) and near/far field separation.
struct U {
  texelSize: vec2<f32>,
  focusDist: f32,
  focusRange: f32,
  maxBlur: f32,
  bokehShape: f32,   // 0 = circle, 1 = hexagon, 2 = octagon
  sampleCount: f32,  // kernel sample count (max 48)
  nearOnly: f32,     // 1.0 = blur only near field, 0.0 = blur both
  farOnly: f32,      // 1.0 = blur only far field, 0.0 = blur both
  bladeRotation: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
  _p5: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

// Golden-angle spiral disk sampling — well-distributed kernel points.
// Returns offset direction (unit) for sample index i of N.
fn diskSample(i: u32, n: f32) -> vec2<f32> {
  let goldenAngle = 2.39996323;
  let r = sqrt((f32(i) + 0.5) / n);
  let theta = f32(i) * goldenAngle + u.bladeRotation;
  return vec2<f32>(cos(theta), sin(theta)) * r;
}

// Shape mask: modifies sample weight based on bokeh shape.
fn shapeMask(dir: vec2<f32>) -> f32 {
  if (u.bokehShape < 0.5) {
    // Circle — no modification
    return 1.0;
  } else if (u.bokehShape < 1.5) {
    // Hexagon — clip to hexagonal aperture
    let a = atan2(dir.y, dir.x);
    let hex = abs(cos(a)) * 0.5 + abs(cos(a + 1.0471976)) * 0.5 + abs(cos(a - 1.0471976)) * 0.5;
    return smoothstep(0.45, 0.5, hex);
  } else {
    // Octagon — clip to octagonal aperture
    let a = atan2(dir.y, dir.x);
    let oct = abs(cos(a)) * 0.5 + abs(cos(a + 0.7853982)) * 0.5 + abs(cos(a - 0.7853982)) * 0.5;
    return smoothstep(0.42, 0.5, oct);
  }
}

fn computeCoC(depth: f32) -> f32 {
  // CoC: 0 at focus distance, grows linearly outside focus range, clamped to maxBlur.
  let diff = depth - u.focusDist;
  let coc = clamp(abs(diff) / u.focusRange, 0.0, 1.0) * u.maxBlur;
  // Sign: positive = far field, negative = near field
  return select(-coc, coc, diff > 0.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let depth = textureSample(depthTex, samp, uv);
  let sharp = textureSample(colorTex, samp, uv);
  let centerCoC = computeCoC(depth);

  // If CoC is negligible, return the sharp pixel directly
  if (abs(centerCoC) < 0.01) {
    return vec4<f32>(sharp.rgb, 1.0);
  }

  let n = u32(clamp(u.sampleCount, 4.0, 48.0));
  let nF = f32(n);
  let cocAbs = abs(centerCoC);
  let isNear = centerCoC < 0.0;

  // Field filtering
  if (u.nearOnly > 0.5 && !isNear) {
    return vec4<f32>(sharp.rgb, 1.0);
  }
  if (u.farOnly > 0.5 && isNear) {
    return vec4<f32>(sharp.rgb, 1.0);
  }

  var color = vec3<f32>(0.0);
  var totalWeight = 0.0;
  let dims = textureDimensions(colorTex);

  for (var i = 0u; i < 48u; i = i + 1u) {
    if (i >= n) { break; }
    let dir = diskSample(i, nF);
    let sampleOff = dir * cocAbs * u.texelSize;
    let sampleUV = uv + sampleOff;

    // Bounds check + textureLoad for non-uniform flow
    let coords = vec2<u32>(clamp(
      vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))),
      vec2<i32>(0, 0),
      vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
    ));
    let sampleColor = textureLoad(colorTex, coords, 0).rgb;

    // Sample CoC — use the larger of center and sample CoC for near field
    // (near field objects should bleed over far field)
    let dcoords = vec2<u32>(clamp(
      vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))),
      vec2<i32>(0, 0),
      vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
    ));
    let sampleDepth = textureLoad(depthTex, dcoords, 0);
    let sampleCoC = computeCoC(sampleDepth);
    let effectiveCoC = select(abs(sampleCoC), max(cocAbs, abs(sampleCoC)), isNear);

    // Weight by shape mask + CoC influence
    let shapeW = shapeMask(dir);
    let cocW = smoothstep(0.0, 1.0, effectiveCoC / u.maxBlur);
    let weight = shapeW * cocW;
    color += sampleColor * weight;
    totalWeight += weight;
  }

  let blurred = color / max(totalWeight, 0.0001);
  // Blend sharp → blurred based on CoC magnitude
  let blend = clamp(cocAbs / u.maxBlur, 0.0, 1.0);
  let result = mix(sharp.rgb, blurred, blend);
  return vec4<f32>(result, 1.0);
}
