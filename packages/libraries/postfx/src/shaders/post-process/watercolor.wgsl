// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
// Watercolor — stylized edge-aware smoothing + paper texture blend.
// Combines a soft bilateral-like smoothing with edge enhancement and a
// subtle paper grain overlay for a hand-painted watercolor look.
struct U {
  texelSize: vec2<f32>,
  edgeStrength: f32,   // edge enhancement intensity (0–2)
  paperScale: f32,     // paper texture scale (1–10)
  blend: f32,          // watercolor blend amount (0–1)
  _p0: f32,
  _p1: f32,
  _p2: f32,
  _p3: f32,
};
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

// Hash for procedural paper texture
fn hash(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn noise2D(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv;
  let ts = u.texelSize;
  let color = textureSample(colorTex, samp, uv).rgb;

  // ── Edge-aware smoothing: 3x3 weighted blur (edge-preserving) ──
  let tl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0, -1.0) * ts).rgb;
  let tr = textureSample(colorTex, samp, uv + vec2<f32>( 1.0, -1.0) * ts).rgb;
  let bl = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  1.0) * ts).rgb;
  let br = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  1.0) * ts).rgb;
  let l = textureSample(colorTex, samp, uv + vec2<f32>(-1.0,  0.0) * ts).rgb;
  let r = textureSample(colorTex, samp, uv + vec2<f32>( 1.0,  0.0) * ts).rgb;
  let t = textureSample(colorTex, samp, uv + vec2<f32>( 0.0, -1.0) * ts).rgb;
  let b = textureSample(colorTex, samp, uv + vec2<f32>( 0.0,  1.0) * ts).rgb;

  // Edge weight: closer colors get more weight (bilateral-like)
  let centerLuma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  let neighbors = array<vec3<f32>, 8>(tl, tr, bl, br, l, r, t, b);
  var smoothColor = vec3<f32>(0.0);
  var totalWeight = 0.0;
  for (var i = 0u; i < 8u; i = i + 1u) {
    let nl = dot(neighbors[i], vec3<f32>(0.299, 0.587, 0.114));
    let w = exp(-abs(centerLuma - nl) * 5.0);
    smoothColor += neighbors[i] * w;
    totalWeight += w;
  }
  smoothColor = (smoothColor + color * 2.0) / (totalWeight + 2.0);

  // ── Edge enhancement (Sobel) ──
  let gx = abs(dot(tr + 2.0 * r + br - tl - 2.0 * l - bl, vec3<f32>(0.299, 0.587, 0.114)));
  let gy = abs(dot(bl + 2.0 * b + br - tl - 2.0 * t - tr, vec3<f32>(0.299, 0.587, 0.114)));
  let edge = sqrt(gx * gx + gy * gy);
  let edgeFactor = 1.0 - clamp(edge * u.edgeStrength, 0.0, 1.0);

  // ── Paper texture ──
  let paperUV = uv * u.paperScale * 50.0;
  let paper = noise2D(paperUV) * 0.15 + 0.85;

  // ── Combine: smoothed color darkened at edges, multiplied by paper texture ──
  let watercolor = smoothColor * edgeFactor * paper;
  let result = mix(color, watercolor, u.blend);
  return vec4<f32>(result, 1.0);
}
