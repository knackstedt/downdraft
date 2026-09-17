// wgsl-validate: prelude ./light-structs.wgsl
// wgsl-validate: prelude ./pbr-functions.wgsl
// wgsl-validate: prelude ./ibl-bindings.wgsl
// wgsl-validate: prelude ./lighting-fn.wgsl
struct Uniforms {
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

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn getTypeColor(entityType: u32) -> vec3<f32> {
  switch (entityType) {
    case 0u: { return vec3<f32>(0.8, 0.6, 0.4); } // Player
    case 1u: { return vec3<f32>(0.45, 0.35, 0.25); } // Ship
    case 2u: { return vec3<f32>(0.6, 0.5, 0.4); } // SmallCraft
    case 3u: { return vec3<f32>(0.8, 0.7, 0.3); } // Fish
    case 4u: { return vec3<f32>(0.3, 0.3, 0.4); } // Shark
    case 5u: { return vec3<f32>(0.2, 0.2, 0.3); } // Eel
    case 6u: { return vec3<f32>(0.9, 0.8, 1.0); } // Jellyfish
    case 7u: { return vec3<f32>(0.5, 0.1, 0.1); } // DevilShrimp
    case 8u: { return vec3<f32>(0.2, 0.3, 0.5); } // Whale
    case 9u: { return vec3<f32>(0.6, 0.7, 0.8); } // Dolphin
    case 10u: { return vec3<f32>(0.4, 0.5, 0.3); } // Turtle
    case 11u: { return vec3<f32>(0.7, 0.6, 0.4); } // Crustacean
    case 12u: { return vec3<f32>(0.9, 0.5, 0.5); } // Coral
    case 14u: { return vec3<f32>(0.3, 0.1, 0.1); } // Pirate
    case 15u: { return vec3<f32>(0.2, 0.1, 0.05); } // PirateShip
    case 16u: { return vec3<f32>(0.3, 0.5, 0.2); } // Island
    case 17u: { return vec3<f32>(0.6, 0.5, 0.3); } // Port
    default: { return vec3<f32>(0.5, 0.5, 0.5); }
  }
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));

  let baseColor = getTypeColor(uniforms.entityType);
  // yFactor gradient is designed for cube entities; skip for player model (type 0)
  var yFactor = 0.6 + 0.4 * smoothstep(-0.3, 0.3, input.position.y);
  if (uniforms.entityType == 0u) {
    yFactor = 0.9;
  }
  output.color = baseColor * yFactor;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = entityLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
