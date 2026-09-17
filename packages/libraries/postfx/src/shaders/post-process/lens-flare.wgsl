// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// Lens flare — ghost chain + halo + anamorphic streak + bright spot.
struct U {
  lightScreenPos: vec2<f32>,
  intensity: f32,
  threshold: f32,
  ghostCount: f32,
  ghostSpacing: f32,
  haloWidth: f32,
  starSamples: f32,
  _p0: f32,
  tint: vec3<f32>,
  _p1: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let center = vec2<f32>(0.5, 0.5);
  let lightPos = u.lightScreenPos;
  let dir = lightPos - center;
  let dist = length(dir);
  let ndir = dir / max(dist, 0.0001);

  let color = textureSample(colorTex, samp, uv).rgb;
  var flare = vec3<f32>(0.0);

  let ghostCount = u32(u.ghostCount);
  for (var i = 0u; i < 16u; i = i + 1u) {
    if (i >= ghostCount) { break; }
    let t = (f32(i) + 1.0) * u.ghostSpacing;
    let ghostPos = lightPos - ndir * dist * t;
    let ghostDist = length(uv - ghostPos);
    let falloff = 1.0 / (1.0 + ghostDist * ghostDist * 200.0);
    let scale = 1.0 - f32(i) / f32(ghostCount);
    let ghostColor = textureSampleLevel(colorTex, samp, ghostPos, 0.0).rgb;
    flare += ghostColor * falloff * scale * u.intensity * u.tint;
  }

  let haloAxis = lightPos - center;
  let haloDist = length(uv - center - haloAxis * 0.5);
  let haloRadius = length(haloAxis) * 0.5;
  let haloRing = abs(haloDist - haloRadius);
  let haloFalloff = 1.0 / (1.0 + haloRing * haloRing * 100.0 / u.haloWidth);
  flare += u.tint * haloFalloff * u.intensity * 0.5;

  let toLight = lightPos - uv;
  let horizDist = abs(toLight.x);
  let vertDist = abs(toLight.y);
  let streakFalloff = 1.0 / (1.0 + horizDist * horizDist * 50.0) * (1.0 / (1.0 + vertDist * vertDist * 500.0));
  flare += u.tint * streakFalloff * u.intensity * 0.3;

  let lightDist = length(uv - lightPos);
  let lightFalloff = 1.0 / (1.0 + lightDist * lightDist * 300.0);
  let lightColor = textureSampleLevel(colorTex, samp, lightPos, 0.0).rgb;
  let luma = dot(lightColor, vec3<f32>(0.299, 0.587, 0.114));
  if (luma > u.threshold) {
    flare += lightColor * lightFalloff * u.intensity;
  }

  return vec4<f32>(color + flare, 1.0);
}
