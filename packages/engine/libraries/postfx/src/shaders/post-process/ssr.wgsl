// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// SSR — screen-space reflections with DDA ray marching + binary refinement.
// Upgraded from linear march to pixel-perfect DDA stepping with sub-pixel
// binary search refinement for accurate hit detection. Includes thickness
// testing, edge fade, and distance fade.
struct U {
  invProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
  maxSteps: f32,
  thickness: f32,
  maxDistance: f32,
  fadeStart: f32,
  fadeEnd: f32,
  binarySteps: f32,  // number of binary refinement steps (default 10)
  stride: f32,       // ray march stride multiplier (default 1.0)
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
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
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  // All textureSample calls in uniform control flow
  let depth = textureSample(depthTex, samp, uv);
  let baseColor = textureSample(colorTex, samp, uv);
  let worldNormal = textureSample(normalTex, samp, uv).xyz * 2.0 - 1.0;

  if (depth >= 1.0) { return baseColor; }

  let viewPos = reconstructViewPos(uv, depth);
  let N = normalize((u.view * vec4<f32>(worldNormal, 0.0)).xyz);
  let V = normalize(-viewPos);
  let reflectDir = reflect(-V, N);

  // Skip reflections pointing toward the camera
  if (reflectDir.z >= 0.0) { return baseColor; }

  // Project start and end points to screen space
  let startPos = viewPos;
  let endPos = viewPos + reflectDir * u.maxDistance;
  let startScreen = projectToScreen(startPos);
  let endScreen = projectToScreen(endPos);

  // DDA setup: march from startScreen to endScreen in pixel space
  let dims = textureDimensions(depthTex);
  let colorDims = textureDimensions(colorTex);
  let pixelStart = vec2<f32>(startScreen.x * f32(dims.x), startScreen.y * f32(dims.y));
  let pixelEnd = vec2<f32>(endScreen.x * f32(dims.x), endScreen.y * f32(dims.y));
  let pixelDir = pixelEnd - pixelStart;
  let pixelLen = length(pixelDir);
  let pixelStep = normalize(pixelDir) * u.stride;

  let maxSteps = u32(clamp(u.maxSteps, 1.0, 128.0));
  let binarySteps = u32(clamp(u.binarySteps, 1.0, 16.0));

  var hitColor = vec3<f32>(0.0);
  var hitAlpha = 0.0;
  var hit = false;

  // ── DDA ray march ──
  var currentPixel = pixelStart;
  var currentViewPos = startPos;

  for (var i = 0u; i < 128u; i = i + 1u) {
    if (i >= maxSteps) { break; }
    currentPixel = currentPixel + pixelStep;
    let sampleUV = currentPixel / vec2<f32>(f32(dims.x), f32(dims.y));

    // Out of bounds — stop
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) { break; }

    // Interpolate view-space position along the ray
    let t = f32(i + 1u) / f32(maxSteps);
    currentViewPos = mix(startPos, endPos, t);

    let icoords = vec2<u32>(clamp(
      vec2<i32>(i32(sampleUV.x * f32(dims.x)), i32(sampleUV.y * f32(dims.y))),
      vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
    ));
    let sampleDepth = textureLoad(depthTex, icoords, 0);
    let sampleViewPos = reconstructViewPos(sampleUV, sampleDepth);

    let depthDiff = currentViewPos.z - sampleViewPos.z;
    // Hit: ray is behind the surface within thickness threshold
    if (depthDiff > 0.0 && depthDiff < u.thickness) {
      hit = true;
      // ── Binary refinement for sub-pixel accuracy ──
      var refineStart = currentPixel - pixelStep;
      var refineEnd = currentPixel;
      for (var b = 0u; b < 16u; b = b + 1u) {
        if (b >= binarySteps) { break; }
        let midPixel = (refineStart + refineEnd) * 0.5;
        let midUV = midPixel / vec2<f32>(f32(dims.x), f32(dims.y));
        let midCoords = vec2<u32>(clamp(
          vec2<i32>(i32(midUV.x * f32(dims.x)), i32(midUV.y * f32(dims.y))),
          vec2<i32>(0, 0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1),
        ));
        let midDepth = textureLoad(depthTex, midCoords, 0);
        let midViewPos = reconstructViewPos(midUV, midDepth);

        let bt = length(midPixel - pixelStart) / pixelLen;
        let rayZ = mix(startPos.z, endPos.z, bt);
        let midDiff = rayZ - midViewPos.z;
        if (midDiff > 0.0 && midDiff < u.thickness) {
          refineEnd = midPixel;
        } else {
          refineStart = midPixel;
        }
      }

      // Sample color at the refined hit position
      let hitUV = refineEnd / vec2<f32>(f32(dims.x), f32(dims.y));
      let hitCoords = vec2<u32>(clamp(
        vec2<i32>(i32(hitUV.x * f32(colorDims.x)), i32(hitUV.y * f32(colorDims.y))),
        vec2<i32>(0, 0), vec2<i32>(i32(colorDims.x) - 1, i32(colorDims.y) - 1),
      ));
      hitColor = textureLoad(colorTex, hitCoords, 0).rgb;

      // Distance fade
      let dist = length(currentViewPos - viewPos);
      let fade = 1.0 - smoothstep(u.fadeStart, u.fadeEnd, dist);
      // Edge fade (screen border)
      let edgeFade = smoothstep(0.0, 0.1, hitUV.x) * smoothstep(0.0, 0.1, 1.0 - hitUV.x) *
                     smoothstep(0.0, 0.1, hitUV.y) * smoothstep(0.0, 0.1, 1.0 - hitUV.y);
      hitAlpha = fade * edgeFade;
      break;
    }
  }

  if (!hit) { return baseColor; }
  return vec4<f32>(mix(baseColor.rgb, hitColor, hitAlpha), baseColor.a);
}
