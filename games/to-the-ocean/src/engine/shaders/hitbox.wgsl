struct HitboxUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  halfExtent: vec3<f32>,
  entityRot: vec4<f32>,
  screenSize: vec2<f32>,
  lineWidth: f32,
  hitboxColor: vec3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: HitboxUniforms;

struct VertexInput {
  @location(0) endpointA: vec3<f32>,
  @location(1) endpointB: vec3<f32>,
  @location(2) cornerVec: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let scaledA = input.endpointA * uniforms.halfExtent * 2.0;
  let scaledB = input.endpointB * uniforms.halfExtent * 2.0;
  let worldA = qrotate(uniforms.entityRot, scaledA) + uniforms.entityPos;
  let worldB = qrotate(uniforms.entityRot, scaledB) + uniforms.entityPos;

  let clipA = uniforms.viewProj * vec4<f32>(worldA, 1.0);
  let clipB = uniforms.viewProj * vec4<f32>(worldB, 1.0);

  let ndcA = clipA.xy / clipA.w;
  let ndcB = clipB.xy / clipB.w;

  let dir = normalize(ndcB - ndcA);
  let perp = vec2<f32>(-dir.y, dir.x);

  let halfWidthNdc = uniforms.lineWidth / uniforms.screenSize.x;
  let offset = perp * input.cornerVec.y * halfWidthNdc;

  let t = input.cornerVec.x;
  let ndcPos = mix(ndcA, ndcB, t) + offset;
  let clipW = mix(clipA.w, clipB.w, t);
  let clipZ = mix(clipA.z, clipB.z, t);

  output.clipPos = vec4<f32>(ndcPos * clipW, clipZ, clipW);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(uniforms.hitboxColor, 1.0);
}
