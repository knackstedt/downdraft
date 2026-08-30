import type { WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, vec3f, wgsl } from "@downdraft/shader-graph";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const DomeUniforms: WgslStruct = wgsl.struct("DomeUniforms", {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  fov: f32,
  aspect: f32,
  _pad0: f32,
  _pad1: f32,
});

const DOME_360_SHADER = /* wgsl */ `
${DomeUniforms.wgsl}

@group(0) @binding(0) var<uniform> u: DomeUniforms;
@group(0) @binding(1) var equirectTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) dir: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let pos = positions[vi];
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(pos, 0.999, 1.0);
  output.dir = vec3<f32>(pos.x * u.aspect * tan(u.fov * 0.5), pos.y * tan(u.fov * 0.5), -1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let dir = normalize(input.dir);
  let phi = atan2(dir.z, dir.x);
  let theta = acos(clamp(dir.y, -1.0, 1.0));
  let uv = vec2<f32>(phi / (2.0 * 3.14159265) + 0.5, theta / 3.14159265);
  return textureSample(equirectTex, texSampler, uv);
}
`;

export interface Dome360Config {
  equirectangularHandle: TextureHandle | null;
  fov: number;
  aspect: number;
  background: boolean;
}

export class Dome360Pass extends RenderPass {
  name = "dome-360";
  config: Dome360Config;
  outputHandle: TextureHandle | null = null;

  constructor(config?: Partial<Dome360Config>) {
    super();
    this.config = {
      equirectangularHandle: null,
      fov: Math.PI / 3,
      aspect: 16 / 9,
      background: true,
      ...config,
    };
  }

  prepare(_device: GPUDevice): void {}

  setup(builder: FrameGraphBuilder): void {
    if (this.config.equirectangularHandle) builder.read(this.config.equirectangularHandle);
    if (this.outputHandle) builder.colorAttachment({ handle: this.outputHandle, loadOp: "clear", storeOp: "store" });
  }

  execute(_ctx: GraphRenderContext): void {}

  destroy(): void {}
}
