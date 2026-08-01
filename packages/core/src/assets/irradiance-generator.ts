const IRRADIANCE_SHADER = /* wgsl */ `
struct Uniforms {
  faceSize: u32,
  sampleCount: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var srcTex: texture_2d_array<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var srcSampler: sampler;

const PI: f32 = 3.141592653589793;

fn faceDirToUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  let a = u * 2.0 - 1.0;
  let b = v * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3<f32>( 1.0, -b, -a); }
    case 1u: { return vec3<f32>(-1.0, -b,  a); }
    case 2u: { return vec3<f32>( a,  1.0,  b); }
    case 3u: { return vec3<f32>( a, -1.0, -b); }
    case 4u: { return vec3<f32>( a, -b,  1.0); }
    case 5u: { return vec3<f32>(-a, -b, -1.0); }
    default: { return vec3<f32>(0.0, 0.0, 0.0); }
  }
}

fn dirToFaceUV(dir: vec3<f32>) -> vec3<f32> {
  let absX = abs(dir.x);
  let absY = abs(dir.y);
  let absZ = abs(dir.z);

  var face: u32 = 0u;
  var ma: f32 = 0.0;
  var sc: f32 = 0.0;
  var tc: f32 = 0.0;

  if (absX > absY && absX > absZ) {
    if (dir.x > 0.0) { face = 0u; sc = -dir.z; tc = -dir.y; ma = dir.x; }
    else { face = 1u; sc = dir.z; tc = -dir.y; ma = -dir.x; }
  } else if (absY > absZ) {
    if (dir.y > 0.0) { face = 2u; sc = dir.x; tc = dir.z; ma = dir.y; }
    else { face = 3u; sc = dir.x; tc = -dir.z; ma = -dir.y; }
  } else {
    if (dir.z > 0.0) { face = 4u; sc = dir.x; tc = -dir.y; ma = dir.z; }
    else { face = 5u; sc = -dir.x; tc = -dir.y; ma = -dir.z; }
  }

  let u = (sc / ma + 1.0) * 0.5;
  let v = (tc / ma + 1.0) * 0.5;
  return vec3<f32>(u, v, f32(face));
}

fn sampleCubemap(dir: vec3<f32>) -> vec3<f32> {
  let info = dirToFaceUV(dir);
  let face = u32(info.z);
  let u = info.x;
  let v = info.y;
  let coords = vec2<i32>(i32(u * f32(textureDimensions(srcTex, 0).x)), i32(v * f32(textureDimensions(srcTex, 0).y)));
  return textureLoad(srcTex, coords, i32(face), 0).rgb;
}

fn tangentToWorld(N: vec3<f32>, tangent: vec3<f32>, bitangent: vec3<f32>, sample: vec3<f32>) -> vec3<f32> {
  return normalize(tangent * sample.x + bitangent * sample.y + N * sample.z);
}

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let faceSize = uniforms.faceSize;
  if (gid.x >= faceSize || gid.y >= faceSize) { return; }

  let face = gid.z;
  let u = (f32(gid.x) + 0.5) / f32(faceSize);
  let v = (f32(gid.y) + 0.5) / f32(faceSize);
  let N = normalize(faceDirToUV(face, u, v));

  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.y) > 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);

  var irradiance = vec3<f32>(0.0);
  var sampleCount = 0u;

  let phiSteps = 64u;
  let thetaSteps = 32u;

  for (var phiStep = 0u; phiStep < phiSteps; phiStep++) {
    for (var thetaStep = 0u; thetaStep < thetaSteps; thetaStep++) {
      let phi = (f32(phiStep) + 0.5) / f32(phiSteps) * 2.0 * PI;
      let theta = (f32(thetaStep) + 0.5) / f32(thetaSteps) * 0.5 * PI;

      let tangentSample = vec3<f32>(
        sin(theta) * cos(phi),
        sin(theta) * sin(phi),
        cos(theta),
      );

      let sampleVec = tangentToWorld(N, tangent, bitangent, tangentSample);
      irradiance += sampleCubemap(sampleVec) * cos(theta);
      sampleCount++;
    }
  }

  irradiance = irradiance * PI / f32(sampleCount);
  textureStore(dstTex, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face), vec4<f32>(irradiance, 1.0));
}
`;

export interface IrradianceOptions {
  faceSize: number;
}

export class IrradianceGenerator {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });

    const shaderModule = this.device.createShaderModule({ code: IRRADIANCE_SHADER });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: "cs_main" },
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  generate(srcCubemap: GPUTexture, options: IrradianceOptions): GPUTexture {
    this.ensurePipeline();

    const faceSize = options.faceSize;
    const dstTexture = this.device.createTexture({
      size: [faceSize, faceSize, 6],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    const srcView = srcCubemap.createView({ dimension: "2d-array" });
    const dstView = dstTexture.createView({ dimension: "2d-array" });

    const uniformData = new Uint32Array(4);
    uniformData[0] = faceSize;
    uniformData[1] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

    const sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: dstView },
        { binding: 2, resource: { buffer: this.uniformBuffer! } },
        { binding: 3, resource: sampler },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(faceSize / 8), Math.ceil(faceSize / 8), 6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    return dstTexture;
  }
}
