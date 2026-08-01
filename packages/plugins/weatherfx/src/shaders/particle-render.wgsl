struct RenderUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  particleCount: f32,
  weatherType: f32,
  aspect: f32,
  focalLength: f32,
  cullDistance: f32,
};

@group(0) @binding(0) var<uniform> uniforms: RenderUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

struct Particle {
  posX: f32, posY: f32, posZ: f32,
  velX: f32, velY: f32, velZ: f32,
  life: f32, size: f32,
  colorR: f32, colorG: f32, colorB: f32,
  alive: f32,
};

@group(0) @binding(1) var<storage, read> particles: array<Particle>;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var output: VertexOutput;

  let particleIdx = vid / 6u;
  if (particleIdx >= u32(uniforms.particleCount)) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  let p = particles[particleIdx];
  if (p.alive < 0.5) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  // Quad corner offsets: 2 triangles (0,1,2) and (0,2,3)
  var cornerX = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
  var cornerY = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let cx = cornerX[vid % 6u];
  let cy = cornerY[vid % 6u];

  // Project center to clip space
  let center = uniforms.viewProj * vec4<f32>(vec3<f32>(p.posX, p.posY, p.posZ), 1.0);

  // Cull if particle is too close in view space (center.w = distance along view dir)
  if (center.w < uniforms.cullDistance) {
    output.clipPos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec3<f32>(0.0);
    output.uv = vec2<f32>(0.0);
    return output;
  }

  // Fade size based on life (full at start, shrinks near death)
  let lifeRatio = clamp(p.life / 4.0, 0.0, 1.0);
  let fadedSize = p.size * min(1.0, lifeRatio * 2.0);

  // Rain: streak shape — thin horizontal, elongated vertical based on velocity
  // Snow: round billboard
  let isSnow = u32(uniforms.weatherType) == 9u;
  let speed = length(vec3<f32>(p.velX, p.velY, p.velZ));

  let halfW = select(fadedSize * 0.3, fadedSize * 0.5, isSnow);
  let halfH = select(fadedSize * 0.5 + speed * 0.06, fadedSize * 0.5, isSnow);

  let offsetX = cx * halfW * uniforms.focalLength / center.w / uniforms.aspect;
  let offsetY = cy * halfH * uniforms.focalLength / center.w;

  output.clipPos = vec4<f32>(center.x + offsetX, center.y + offsetY, center.z, center.w);
  output.color = vec3<f32>(p.colorR, p.colorG, p.colorB);
  output.uv = vec2<f32>(cx, cy);

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.uv);
  if (dist > 1.0) { discard; }
  let alpha = (1.0 - dist * dist) * 0.8;
  return vec4<f32>(input.color, alpha);
}
