struct HoloUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,
  wetness: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: HoloUniforms;

struct HoloVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct HoloVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: HoloVertexInput) -> HoloVertexOutput {
  var output: HoloVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: HoloVertexOutput) -> @location(0) vec4<f32> {
  // Holographic effect: tint by vertex color, pulsing alpha, fresnel rim
  let pulse = 0.5 + 0.3 * sin(uniforms.time * 4.0);
  let viewDir = normalize(uniforms.cameraPos - input.worldPos);
  let fresnel = pow(1.0 - max(dot(normalize(input.normal), viewDir), 0.0), 2.0);
  let alpha = (0.3 + fresnel * 0.5) * pulse;
  return vec4<f32>(input.color * (0.6 + fresnel * 0.4), alpha);
}
