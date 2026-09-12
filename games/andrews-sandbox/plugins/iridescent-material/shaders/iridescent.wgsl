// Iridescent material shader — a stylized iridescent surface effect.
// Registered as a material shader via the MaterialRegistry.
// The renderer applies this to spawned props that reference this material id.
//
// Uniform (32 bytes):
//   [0..3]  baseColor (vec3) + intensity (float)
//   [4..7]  fresnelPower + fresnelScale + hueShift + time

@group(0) @binding(0) var<uniform> u: array<vec4f, 2>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(vi & 1) * 4.0 - 1.0;
  let y = f32(vi >> 1) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let baseColor = u[0].xyz;
  let intensity = u[0].w;
  let fresnelPower = u[1].x;
  let fresnelScale = u[1].y;
  let hueShift = u[1].z;
  let time = u[1].w;

  // Screen-space iridescence — simulate Fresnel + hue cycling
  let uv = fragCoord.xy / vec2f(1920.0, 1080.0);
  let center = vec2f(0.5, 0.5);
  let dist = length(uv - center);
  let fresnel = pow(1.0 - dist, fresnelPower) * fresnelScale;

  // Hue cycling based on angle + time
  let angle = atan2(uv.y - center.y, uv.x - center.x);
  let hue = angle / 6.2832 + hueShift + time * 0.1;

  // HSV → RGB
  let h = fract(hue);
  let s = 1.0;
  let v = 1.0;
  let c = vec3f(v, v * (1.0 - s), v * (1.0 - h * 6.0));
  let i = u32(h * 6.0);
  let f = h * 6.0 - f32(i);
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));
  var rgb = vec3f(0.0);
  switch (i % 6u) {
    case 0u: { rgb = vec3f(v, t, p); }
    case 1u: { rgb = vec3f(q, v, p); }
    case 2u: { rgb = vec3f(p, v, t); }
    case 3u: { rgb = vec3f(p, q, v); }
    case 4u: { rgb = vec3f(t, p, v); }
    case 5u: { rgb = vec3f(v, p, q); }
    default: { rgb = vec3f(v, t, p); }
  }

  // Mix base color with iridescent fresnel
  let iridescent = rgb * fresnel * intensity;
  return vec4f(baseColor * 0.3 + iridescent, 1.0);
}
