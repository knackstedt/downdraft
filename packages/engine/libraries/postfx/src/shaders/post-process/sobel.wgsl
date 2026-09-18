// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, _p6: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let uv = input.uv; let t = u.texelSize;
  let tl = lum(textureSample(colorTex, samp, uv + vec2(-t.x, -t.y)).rgb);
  let tm = lum(textureSample(colorTex, samp, uv + vec2(0.0, -t.y)).rgb);
  let tr = lum(textureSample(colorTex, samp, uv + vec2( t.x, -t.y)).rgb);
  let ml = lum(textureSample(colorTex, samp, uv + vec2(-t.x, 0.0)).rgb);
  let mr = lum(textureSample(colorTex, samp, uv + vec2( t.x, 0.0)).rgb);
  let bl = lum(textureSample(colorTex, samp, uv + vec2(-t.x,  t.y)).rgb);
  let bm = lum(textureSample(colorTex, samp, uv + vec2(0.0,  t.y)).rgb);
  let br = lum(textureSample(colorTex, samp, uv + vec2( t.x,  t.y)).rgb);
  let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
  let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
  let g = sqrt(gx * gx + gy * gy);
  let edge = clamp(g, 0.0, 1.0);
  let c = textureSample(colorTex, samp, uv);
  return vec4(c.rgb * (1.0 - edge) + vec3(edge) * 0.5, c.a);
}
