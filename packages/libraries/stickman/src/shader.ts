// Shared thick-line + SDF-circle stickman WGSL shader.
//
// Both games use this single shader. The per-game coordinate transform is
// baked into a uniform affine `u.transform` (cell coords -> NDC):
//
//   ndc.xy = worldPos.xy * transform.xy + transform.zw
//
// falling-sand:  transform = (2/gridW, -2/gridH, -1, +1)
// mining-rpg:    transform = (zoom*2/canvasW, -zoom*2/canvasH,
//                            -camX*zoom*2/canvasW, +camY*zoom*2/canvasH)
//
// Two segment types (detected via endpointB.z > 0):
//   Line:  extrudes a thick stroke perpendicular to the segment.
//   Circle (head): expands quad to bounding box, fragment shader uses SDF
//     to draw a perfect anti-aliased circle ring.
//
// Light/volumetric textures are sampled at the player's world position
// (half-res, matching the mining-rpg light-accum pass). falling-sand binds
// 1x1 white dummy textures so lighting is identity.

export const STICKMAN_WGSL = /* wgsl */`

struct StickmanUniforms {
  transform: vec4<f32>,   // (scaleX, scaleY, offsetX, offsetY)
  screenSize: vec2<f32>,  // (canvasW, canvasH) in pixels
  lineWidth: f32,         // stroke half-width in cell units (scales with zoom)
  color: vec3<f32>,       // health-tinted stroke color
};

@group(0) @binding(0) var<uniform> u: StickmanUniforms;
@group(0) @binding(1) var lightTex: texture_2d<f32>;
@group(0) @binding(2) var volumetricTex: texture_2d<f32>;

struct VertexInput {
  @location(0) endpointA: vec3<f32>,
  @location(1) endpointB: vec3<f32>,
  @location(2) cornerVec: vec2<f32>,
};

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) worldPos: vec2<f32>,
  @location(2) circleCenter: vec2<f32>,  // valid only for circle segments
  @location(3) circleRadius: f32,         // > 0 for circle, 0 for line
};

fn worldToNdc(p: vec2<f32>) -> vec2<f32> {
  return p * u.transform.xy + u.transform.zw;
}

@vertex
fn vs_main(input: VertexInput) -> VSOut {
  let isCircle = input.endpointB.z > 0.0;

  var out: VSOut;
  out.color = u.color;
  out.circleCenter = vec2<f32>(0.0, 0.0);
  out.circleRadius = 0.0;

  if (isCircle) {
    // Head circle: expand quad to bounding box (center ± radius).
    let center = input.endpointA.xy;
    let radius = input.endpointB.z;
    let worldPos = center + input.cornerVec * radius;
    let ndcPos = worldToNdc(worldPos);
    out.pos = vec4<f32>(ndcPos, 0.0, 1.0);
    out.worldPos = worldPos;
    out.circleCenter = center;
    out.circleRadius = radius;
  } else {
    // Line segment: extrude thick stroke.
    let a = input.endpointA.xy;
    let b = input.endpointB.xy;
    let ndcA = worldToNdc(a);
    let ndcB = worldToNdc(b);
    let dir = normalize(ndcB - ndcA);
    let perp = vec2<f32>(-dir.y, dir.x);
    let halfWidthNdc = u.lineWidth * abs(u.transform.x);
    let offset = perp * input.cornerVec.y * halfWidthNdc;
    let t = input.cornerVec.x;
    let ndcPos = mix(ndcA, ndcB, t) + offset;
    out.pos = vec4<f32>(ndcPos, 0.0, 1.0);
    out.worldPos = mix(a, b, t);
  }

  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Sample light + volumetric at the player's world position (half-res).
  let lc = vec2<i32>(i32(in.worldPos.x) / 2, i32(in.worldPos.y) / 2);
  let light = textureLoad(lightTex, lc, 0);
  let vol = textureLoad(volumetricTex, lc, 0);
  let lighting = light.rgb + vol.rgb;

  if (in.circleRadius > 0.0) {
    // SDF circle ring: draw if |dist - radius| < lineWidth.
    // Anti-alias with a 1-cell smoothstep edge.
    let dist = distance(in.worldPos, in.circleCenter);
    let ringHalf = u.lineWidth;
    let aa = 0.5;
    let d = abs(dist - in.circleRadius);
    let alpha = 1.0 - smoothstep(ringHalf, ringHalf + aa, d);
    if (alpha < 0.01) {
      discard;
    }
    return vec4<f32>(in.color * lighting, alpha);
  }

  // Line segment: opaque.
  return vec4<f32>(in.color * lighting, 1.0);
}
`;
