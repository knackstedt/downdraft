// World-space UI billboard shader — instanced quads with per-instance texture UV regions
// Supports: ScreenAligned, AxisAligned, Fixed billboard modes + error state rendering

struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraRight: vec3<f32>,
  cameraUp: vec3<f32>,
  _pad: f32,
};

struct InstanceData {
  position: vec3<f32>,
  _pad0: f32,
  size: vec2<f32>,
  uvOffset: vec2<f32>,
  uvScale: vec2<f32>,
  billboardMode: f32,
  textureIndex: f32,
  errorFlag: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var uiSampler: sampler;

@group(1) @binding(0) var uiTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) errorFlag: f32,
};

struct InstanceInput {
  @location(1) position: vec3<f32>,
  @location(2) size: vec2<f32>,
  @location(3) uvOffset: vec2<f32>,
  @location(4) uvScale: vec2<f32>,
  @location(5) billboardMode: f32,
  @location(6) textureIndex: f32,
  @location(7) errorFlag: f32,
};

@vertex
fn vs_main(@location(0) quadUV: vec2<f32>, instance: InstanceInput) -> VertexOutput {

  var output: VertexOutput;
  output.errorFlag = instance.errorFlag;

  var worldOffset: vec3<f32>;
  if (instance.billboardMode == 0.0) {
    // ScreenAligned — use camera right and up vectors
    worldOffset = camera.cameraRight * (quadUV.x - 0.5) * instance.size.x
                + camera.cameraUp * (quadUV.y - 0.5) * instance.size.y;
  } else if (instance.billboardMode == 1.0) {
    // AxisAligned — only Y axis is aligned to camera up, X stays world-aligned
    worldOffset = vec3<f32>((quadUV.x - 0.5) * instance.size.x, 0.0, 0.0)
                + camera.cameraUp * (quadUV.y - 0.5) * instance.size.y;
  } else {
    // Fixed — no billboarding, quad lies in XZ plane
    worldOffset = vec3<f32>((quadUV.x - 0.5) * instance.size.x, 0.0, (quadUV.y - 0.5) * instance.size.y);
  }

  let worldPos = vec4<f32>(instance.position + worldOffset, 1.0);
  output.clipPosition = camera.viewProj * worldPos;

  // Compute UV within the texture (atlas sub-region or full texture)
  output.uv = instance.uvOffset + quadUV * instance.uvScale;

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.errorFlag > 0.5) {
    // Error state — solid red
    return vec4<f32>(1.0, 0.0, 0.0, 0.85);
  }

  let texColor = textureSample(uiTexture, uiSampler, input.uv);
  return texColor;
}
