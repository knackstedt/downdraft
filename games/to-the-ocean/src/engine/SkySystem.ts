// ============================================================================
// Sky System — sky dome with day/night cycle, weather, stars
// ============================================================================

import { WeatherType } from "@shared/types";
import { CameraState } from "./CameraSystem";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./graphicsConfig";
import { calculateViewProj } from "./mathUtils";

const SKY_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  timeOfDay: f32,
  weatherType: u32,
  sunDir: vec3<f32>,
  sunIntensity: f32,
  moonDir: vec3<f32>,
  moonIntensity: f32,
  time: f32,
  prevWeatherType: u32,
  weatherBlend: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldDir: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = input.position * 4000.0 + vec3<f32>(uniforms.cameraPos.x, 0.0, uniforms.cameraPos.z);
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  // Ensure sky is always at far plane
  output.clipPos.z = 0.9999 * output.clipPos.w;
  output.worldDir = normalize(input.position);
  return output;
}

fn hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn hash2d(p: vec2<f32>) -> vec2<f32> {
  let k = vec2<f32>(0.3183099, 0.3678794);
  let q = fract(p * k);
  return -1.0 + 2.0 * fract(vec2<f32>(
    dot(q, vec2<f32>(127.1, 311.7)),
    dot(q, vec2<f32>(269.5, 183.3))
  ) * 43758.5453);
}

fn perlin2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let ga = hash2d(i);
  let gb = hash2d(i + vec2<f32>(1.0, 0.0));
  let gc = hash2d(i + vec2<f32>(0.0, 1.0));
  let gd = hash2d(i + vec2<f32>(1.0, 1.0));

  let va = dot(ga, f);
  let vb = dot(gb, f - vec2<f32>(1.0, 0.0));
  let vc = dot(gc, f - vec2<f32>(0.0, 1.0));
  let vd = dot(gd, f - vec2<f32>(1.0, 1.0));

  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 0.5 + 0.5;
}

fn fbm6(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pp = p;
  for (var i = 0; i < 6; i = i + 1) {
    v = v + a * perlin2d(pp);
    pp = pp * 2.0;
    a = a * 0.5;
  }
  return v;
}

fn fbm4(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pp = p;
  for (var i = 0; i < 4; i = i + 1) {
    v = v + a * perlin2d(pp);
    pp = pp * 2.0;
    a = a * 0.5;
  }
  return v;
}

fn getCloudThreshold(weather: u32) -> f32 {
  if (weather == 0u) { return 0.62; }
  if (weather == 1u) { return 0.48; }
  if (weather == 2u) { return 0.28; }
  if (weather == 3u) { return 0.22; }
  if (weather == 4u) { return 0.15; }
  if (weather == 5u) { return 0.18; }
  if (weather == 8u) { return 0.10; }
  if (weather == 9u) { return 0.20; }
  return 0.52;
}

struct CloudWeatherResult {
  c1: vec3<f32>,
  c2: vec3<f32>,
  c3: vec3<f32>,
};

fn applyWeatherClouds(c1in: vec3<f32>, c2in: vec3<f32>, c3in: vec3<f32>, weather: u32) -> CloudWeatherResult {
  var r: CloudWeatherResult;
  r.c1 = c1in;
  r.c2 = c2in;
  r.c3 = c3in;
  if (weather == 4u || weather == 8u) {
    r.c1 = mix(r.c1, vec3<f32>(0.1, 0.1, 0.15), 0.5);
    r.c2 = mix(r.c2, vec3<f32>(0.08, 0.08, 0.12), 0.5);
    r.c3 = mix(r.c3, vec3<f32>(0.1, 0.1, 0.15), 0.4);
  }
  if (weather == 8u) {
    r.c1 = mix(r.c1, vec3<f32>(0.3, 0.1, 0.05), 0.3);
    r.c2 = mix(r.c2, vec3<f32>(0.25, 0.08, 0.04), 0.4);
    r.c3 = mix(r.c3, vec3<f32>(0.2, 0.05, 0.03), 0.3);
  }
  if (weather == 5u) {
    r.c1 = mix(r.c1, vec3<f32>(0.6, 0.6, 0.62), 0.6);
    r.c2 = mix(r.c2, vec3<f32>(0.55, 0.55, 0.58), 0.6);
    r.c3 = mix(r.c3, vec3<f32>(0.5, 0.5, 0.53), 0.5);
  }
  if (weather == 9u) {
    r.c1 = mix(r.c1, vec3<f32>(0.75, 0.78, 0.82), 0.5);
    r.c2 = mix(r.c2, vec3<f32>(0.7, 0.73, 0.78), 0.5);
    r.c3 = mix(r.c3, vec3<f32>(0.65, 0.68, 0.73), 0.4);
  }
  return r;
}

fn applyWeatherSky(skyColor: vec3<f32>, horizon: f32, weather: u32) -> vec3<f32> {
  var c = skyColor;
  if (weather == 2u || weather == 3u || weather == 4u) {
    c *= 0.5;
  }
  if (weather == 4u || weather == 8u) {
    c *= 0.4;
    c = mix(c, vec3<f32>(0.1, 0.1, 0.15), horizon * 0.5);
  }
  if (weather == 5u) {
    c = mix(c, vec3<f32>(0.5, 0.5, 0.55), 0.7);
  }
  if (weather == 6u) {
    c = mix(c, vec3<f32>(0.3, 0.1, 0.05), 0.8);
  }
  if (weather == 8u) {
    c = mix(c, vec3<f32>(0.5, 0.1, 0.05), 0.6);
  }
  if (weather == 9u) {
    c = mix(c, vec3<f32>(0.6, 0.65, 0.7), 0.4);
  }
  return c;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dir = normalize(input.worldDir);
  let up = vec3<f32>(0.0, 1.0, 0.0);
  let horizon = 1.0 - abs(dir.y);

  // Day/night colors
  let dayColor = vec3<f32>(0.4, 0.6, 0.9);
  let nightColor = vec3<f32>(0.02, 0.02, 0.05);
  let sunsetColor = vec3<f32>(0.9, 0.4, 0.2);

  let dayFactor = smoothstep(0.2, 0.4, uniforms.timeOfDay) * (1.0 - smoothstep(0.65, 0.8, uniforms.timeOfDay));
  let sunsetFactor = smoothstep(0.15, 0.25, uniforms.timeOfDay) * (1.0 - smoothstep(0.25, 0.35, uniforms.timeOfDay))
    + smoothstep(0.65, 0.75, uniforms.timeOfDay) * (1.0 - smoothstep(0.75, 0.85, uniforms.timeOfDay));

  var skyColor = mix(nightColor, dayColor, dayFactor);
  skyColor = mix(skyColor, sunsetColor, sunsetFactor * 0.7);

  // Horizon gradient
  skyColor = mix(skyColor, vec3<f32>(0.7, 0.8, 0.9), horizon * 0.3 * dayFactor);

  // Sun — bright warm disc with soft glow halo
  let sunDot = max(dot(dir, uniforms.sunDir), 0.0);
  let sunGlow = pow(sunDot, 255.0) * uniforms.sunIntensity;
  let sunHalo = pow(sunDot, 32.0) * uniforms.sunIntensity;
  let sunDisc = smoothstep(0.9995, 0.9998, sunDot) * uniforms.sunIntensity;
  // Warm core, slightly cooler halo
  skyColor += vec3<f32>(1.0, 0.95, 0.8) * sunDisc * 3.0;
  skyColor += vec3<f32>(1.0, 0.8, 0.5) * (sunHalo * 0.15 + sunGlow * 0.4);

  // Moon — pale silver disc with subtle craters and soft glow
  let moonDot = max(dot(dir, uniforms.moonDir), 0.0);
  let moonGlow = pow(moonDot, 200.0) * uniforms.moonIntensity;
  let moonDisc = smoothstep(0.9995, 0.9998, moonDot) * uniforms.moonIntensity;
  // Subtle crater texture using noise on the moon disc surface
  let moonSurface = hash3(dir * 80.0);
  let craterShading = mix(0.7, 1.0, moonSurface);
  skyColor += vec3<f32>(0.9, 0.92, 1.0) * moonDisc * craterShading;
  skyColor += vec3<f32>(0.6, 0.65, 0.8) * moonGlow * 0.15;

  // Stars at night — quantized grid for stable positions (floor prevents flickering)
  if (dayFactor < 0.3) {
    let gridDir = floor(dir * 200.0);
    let starRand = hash3(gridDir);
    let starVar = hash3(gridDir + vec3<f32>(31.0, 17.0, 7.0));
    let star = step(0.997, starRand) * (1.0 - dayFactor);
    let brightness = mix(0.15, 1.0, starVar);
    let starColor = mix(vec3<f32>(0.8, 0.85, 1.0), vec3<f32>(1.0, 0.95, 0.8), starVar);
    skyColor += starColor * star * brightness;
  }

  // Clouds — multi-layer procedural clouds with domain warping & self-shadowing
  if (dir.y > 0.005) {
    let cloudProj = dir.xz / max(dir.y, 0.05);
    let horizonFade = smoothstep(0.005, 0.2, dir.y);

    // Cloud coverage threshold — smoothly blended during weather transitions
    let cloudThreshold = mix(getCloudThreshold(uniforms.prevWeatherType), getCloudThreshold(uniforms.weatherType), uniforms.weatherBlend);

    // --- Layer 1: high-altitude wispy cirrus clouds ---
    let uv1 = cloudProj * 0.12 + vec2<f32>(uniforms.time * 0.005, uniforms.time * 0.003);
    let warp1 = vec2<f32>(
      fbm4(uv1 + vec2<f32>(5.2, 1.3)),
      fbm4(uv1 + vec2<f32>(1.7, 9.2))
    );
    let cloud1 = fbm6(uv1 + warp1 * 1.8);
    let edge1 = fbm4(uv1 * 3.0 + warp1 * 0.5);
    let cov1 = smoothstep(cloudThreshold + 0.08, cloudThreshold + 0.25, cloud1 + edge1 * 0.1);
    let mask1 = cov1 * horizonFade * 0.65;
    // Self-shadowing: denser parts brighter, edges darker
    let shadow1 = mix(0.5, 1.0, smoothstep(cloudThreshold + 0.08, cloudThreshold + 0.4, cloud1));

    // --- Layer 2: mid-altitude cumulus clouds ---
    let uv2 = cloudProj * 0.3 + vec2<f32>(uniforms.time * 0.01, uniforms.time * 0.008) + vec2<f32>(100.0, 50.0);
    let warp2 = vec2<f32>(
      fbm4(uv2 * 1.3 + vec2<f32>(3.1, 7.7)),
      fbm4(uv2 * 1.3 + vec2<f32>(8.4, 2.6))
    );
    let cloud2 = fbm6(uv2 + warp2 * 2.2);
    let edge2 = fbm4(uv2 * 4.0 + warp2 * 0.3);
    let cov2 = smoothstep(cloudThreshold, cloudThreshold + 0.2, cloud2 + edge2 * 0.12);
    let mask2 = cov2 * horizonFade;
    let shadow2 = mix(0.35, 1.0, smoothstep(cloudThreshold, cloudThreshold + 0.35, cloud2));

    // --- Layer 3: low fast-moving stratus scud ---
    let uv3 = cloudProj * 0.55 + vec2<f32>(uniforms.time * 0.02, uniforms.time * 0.015) + vec2<f32>(200.0, 150.0);
    let cloud3 = fbm4(uv3);
    let cov3 = smoothstep(cloudThreshold + 0.1, cloudThreshold + 0.3, cloud3);
    let mask3 = cov3 * horizonFade * 0.35;
    let shadow3 = mix(0.4, 0.9, smoothstep(cloudThreshold + 0.1, cloudThreshold + 0.4, cloud3));

    // Cloud lighting — sun illuminates cloud tops, shadow on underside
    let sunLight = max(dot(uniforms.sunDir, vec3<f32>(0.0, 1.0, 0.0)), 0.0);
    let topLit = vec3<f32>(1.0, 0.97, 0.9);
    let bottomShade = vec3<f32>(0.35, 0.35, 0.45);
    let ambientCloud = vec3<f32>(0.5, 0.5, 0.6);

    // Per-layer colors with self-shadowing
    let lit1 = mix(bottomShade, topLit, sunLight * shadow1);
    let lit2 = mix(bottomShade, topLit, sunLight * shadow2);
    let lit3 = mix(ambientCloud * 0.7, topLit * 0.85, sunLight * shadow3);

    // Darken at night
    let color1 = mix(lit1, lit1 * 0.15, 1.0 - dayFactor);
    let color2 = mix(lit2, lit2 * 0.2, 1.0 - dayFactor);
    let color3 = mix(lit3, lit3 * 0.15, 1.0 - dayFactor);

    // Sunset tint
    let color1s = mix(color1, vec3<f32>(1.0, 0.5, 0.3), sunsetFactor * 0.5);
    let color2s = mix(color2, vec3<f32>(1.0, 0.45, 0.25), sunsetFactor * 0.7);
    let color3s = mix(color3, vec3<f32>(0.9, 0.4, 0.2), sunsetFactor * 0.4);

    // Weather darkening — blended between previous and current weather
    let cloudPrev = applyWeatherClouds(color1s, color2s, color3s, uniforms.prevWeatherType);
    let cloudCurr = applyWeatherClouds(color1s, color2s, color3s, uniforms.weatherType);
    let c1 = mix(cloudPrev.c1, cloudCurr.c1, uniforms.weatherBlend);
    let c2 = mix(cloudPrev.c2, cloudCurr.c2, uniforms.weatherBlend);
    let c3 = mix(cloudPrev.c3, cloudCurr.c3, uniforms.weatherBlend);

    // Combine layers — back to front with proper alpha blending
    skyColor = mix(skyColor, c1, mask1);
    skyColor = mix(skyColor, c2, mask2 * (1.0 - mask1 * 0.5));
    skyColor = mix(skyColor, c3, mask3 * (1.0 - mask2 * 0.5));
  }

  // Weather modifications — smoothly blended during transitions
  let skyPrev = applyWeatherSky(skyColor, horizon, uniforms.prevWeatherType);
  let skyCurr = applyWeatherSky(skyColor, horizon, uniforms.weatherType);
  skyColor = mix(skyPrev, skyCurr, uniforms.weatherBlend);

  return vec4<f32>(skyColor, 1.0);
}
`;

export class SkySystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private prevWeatherType: WeatherType = WeatherType.Clear;
  private displayedWeatherType: WeatherType = WeatherType.Clear;
  private weatherBlend: number = 1.0;
  private lastTime: number = 0;
  private readonly weatherTransitionDuration: number = 30.0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    const shaderModule = this.device.createShaderModule({ code: SKY_WGSL });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sky dome vertices (icosphere simplified — just a big cube)
    const vertices = new Float32Array([
      -1, -1, -1,  1, -1, -1,  1, 1, -1,  -1, 1, -1,
      -1, -1,  1,  1, -1,  1,  1, 1,  1,  -1, 1,  1,
    ]);
    const indices = new Uint16Array([
      0, 1, 2,  0, 2, 3,  // back
      4, 7, 6,  4, 6, 5,  // front
      0, 3, 7,  0, 7, 4,  // left
      1, 5, 6,  1, 6, 2,  // right
      3, 2, 6,  3, 6, 7,  // top
      0, 4, 5,  0, 5, 1,  // bottom
    ]);

    this.vertexBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    const indexBuffer = this.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indexBuffer, 0, indices);

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });

    // Store index buffer for drawing
    (this as any).indexBuffer = indexBuffer;
    (this as any).indexCount = indices.length;
  }

  render(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    timeOfDay: number,
    weatherType: WeatherType,
    time: number,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer) return;

    // Track weather transitions for smooth visual blending
    if (weatherType !== this.displayedWeatherType) {
      this.prevWeatherType = this.displayedWeatherType;
      this.displayedWeatherType = weatherType;
      this.weatherBlend = 0.0;
    }
    if (this.weatherBlend < 1.0) {
      const dt = this.lastTime > 0 ? Math.min(0.1, time - this.lastTime) : 0;
      this.weatherBlend = Math.min(1.0, this.weatherBlend + dt / this.weatherTransitionDuration);
    }
    this.lastTime = time;
    const easedBlend = this.weatherBlend * this.weatherBlend * (3 - 2 * this.weatherBlend);

    // Calculate sun/moon direction based on time of day
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sunDirRaw = [Math.cos(sunAngle), Math.sin(sunAngle), 0.3];
    const sunLen = Math.sqrt(sunDirRaw[0] ** 2 + sunDirRaw[1] ** 2 + sunDirRaw[2] ** 2);
    const sunDir = [sunDirRaw[0] / sunLen, sunDirRaw[1] / sunLen, sunDirRaw[2] / sunLen];
    const moonDir = [-sunDir[0], -sunDir[1], -sunDir[2]];

    const sunIntensity = Math.max(0, Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2));
    const moonIntensity = Math.max(0, -Math.sin(timeOfDay * Math.PI * 2 - Math.PI / 2));

    const viewProj = calculateViewProj(camera);

    // WGSL uniform layout with vec3 16-byte alignment:
    //   0-15:   viewProj (mat4x4)
    //   16-18:  cameraPos (vec3)
    //   19:     timeOfDay (f32)
    //   20:     weatherType (u32)
    //   21-23:  PADDING (vec3 sunDir needs 16-byte align → starts at index 24)
    //   24-26:  sunDir (vec3)
    //   27:     sunIntensity (f32)
    //   28-30:  moonDir (vec3)
    //   31:     moonIntensity (f32)
    //   32:     time (f32)
    //   33:     prevWeatherType (u32)
    //   34:     weatherBlend (f32)
    const uniforms = new Float32Array(35);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];
    uniforms[19] = timeOfDay;
    // Write weatherType as u32 (same byte offset, different interpretation)
    const u32View = new Uint32Array(uniforms.buffer);
    u32View[20] = this.displayedWeatherType;
    // indices 21-23 are padding (already 0)
    uniforms[24] = sunDir[0];
    uniforms[25] = sunDir[1];
    uniforms[26] = sunDir[2];
    uniforms[27] = sunIntensity;
    uniforms[28] = moonDir[0];
    uniforms[29] = moonDir[1];
    uniforms[30] = moonDir[2];
    uniforms[31] = moonIntensity;
    uniforms[32] = time;
    u32View[33] = this.prevWeatherType;
    uniforms[34] = easedBlend;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer((this as any).indexBuffer, "uint16");
    passEncoder.drawIndexed((this as any).indexCount);
  }

}
