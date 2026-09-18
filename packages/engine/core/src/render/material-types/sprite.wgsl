// Sprite material — billboard quad with texture + color, no lighting
// Forward-rendered

struct SpriteUniforms {
  color: vec4<f32>,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraRight: vec3<f32>,
  cameraUp: vec3<f32>,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> sprite: SpriteUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var spriteMap: texture_2d<f32>;
@group(0) @binding(3) var spriteSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = vec4<f32>(
    input.position + camera.cameraRight * (input.uv.x - 0.5) + camera.cameraUp * (input.uv.y - 0.5),
    1.0,
  );
  output.clipPosition = camera.viewProj * worldPos;
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(spriteMap, spriteSampler, input.uv);
  return texColor * sprite.color;
}
