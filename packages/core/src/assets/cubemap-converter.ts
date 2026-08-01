const EQUIRECT_TO_CUBEMAP_SHADER = /* wgsl */ `
struct Uniforms {
  faceSize: u32,
  _pad: u32,
  srcWidth: u32,
  srcHeight: u32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

const PI: f32 = 3.141592653589793;

fn faceDirToUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  let a = u * 2.0 - 1.0;
  let b = v * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3<f32>( 1.0, -b, -a); }  // +X
    case 1u: { return vec3<f32>(-1.0, -b,  a); }  // -X
    case 2u: { return vec3<f32>( a,  1.0,  b); }  // +Y
    case 3u: { return vec3<f32>( a, -1.0, -b); }  // -Y
    case 4u: { return vec3<f32>( a, -b,  1.0); }  // +Z
    case 5u: { return vec3<f32>(-a, -b, -1.0); }  // -Z
    default: { return vec3<f32>(0.0, 0.0, 0.0); }
  }
}

fn dirToEquirect(dir: vec3<f32>, srcW: u32, srcH: u32) -> vec2<u32> {
  let phi = atan2(dir.z, dir.x);
  let theta = acos(clamp(dir.y, -1.0, 1.0));
  let u = (phi / (2.0 * PI) + 0.5);
  let v = theta / PI;
  return vec2<u32>(u32(u * f32(srcW)), u32(v * f32(srcH)));
}

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let faceSize = uniforms.faceSize;
  if (gid.x >= faceSize || gid.y >= faceSize) {
    return;
  }

  let face = gid.z;
  let u = (f32(gid.x) + 0.5) / f32(faceSize);
  let v = (f32(gid.y) + 0.5) / f32(faceSize);

  let dir = normalize(faceDirToUV(face, u, v));
  let srcCoord = dirToEquirect(dir, uniforms.srcWidth, uniforms.srcHeight);

  let color = textureLoad(srcTex, srcCoord, 0);
  textureStore(dstTex, vec2<i32>(i32(gid.x), i32(gid.y)), i32(face), color);
}
`;

export interface EquirectToCubemapOptions {
  faceSize: number;
  srcFormat?: GPUTextureFormat;
  dstFormat?: GPUTextureFormat;
}

export class EquirectToCubemapConverter {
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
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });

    const shaderModule = this.device.createShaderModule({ code: EQUIRECT_TO_CUBEMAP_SHADER });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "cs_main" },
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  convert(
    srcTexture: GPUTexture,
    options: EquirectToCubemapOptions,
  ): GPUTexture {
    this.ensurePipeline();

    const faceSize = options.faceSize;
    const dstFormat = options.dstFormat ?? "rgba16float";

    const dstTexture = this.device.createTexture({
      size: [faceSize, faceSize, 6],
      format: dstFormat,
      usage: GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_SRC,
    });

    const srcView = srcTexture.createView({
      dimension: "2d",
    });

    const dstView = dstTexture.createView({
      dimension: "2d-array",
    });

    const uniformData = new Uint32Array(4);
    uniformData[0] = faceSize;
    uniformData[1] = 0;
    uniformData[2] = srcTexture.width;
    uniformData[3] = srcTexture.height;
    this.device!.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: dstView },
        { binding: 2, resource: { buffer: this.uniformBuffer! } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    const workgroupsX = Math.ceil(faceSize / 8);
    const workgroupsY = Math.ceil(faceSize / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY, 6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    return dstTexture;
  }
}
