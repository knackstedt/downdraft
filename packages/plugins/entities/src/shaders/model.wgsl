struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  modelPos: vec3<f32>,
  modelScale: vec3<f32>,
  modelRot: vec4<f32>,
  _pad: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var modelSampler: sampler;
@group(1) @binding(1) var modelTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let scaled = input.position * uniforms.modelScale;
  let rotated = qrotate(uniforms.modelRot, scaled);
  let worldPos = rotated + uniforms.modelPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.modelRot, input.normal));
  output.uv = input.uv;
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let ndotl = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.5;
  let lighting = ambient + ndotl * 0.5;

  let texColor = textureSample(modelTexture, modelSampler, input.uv);
  var color = texColor.rgb * input.color * lighting;

  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, vec3<f32>(0.0, 0.1, 0.2), fogFactor);

  return vec4<f32>(color, 1.0);
}
