import { Material, type MaterialDefinition } from "./material.ts";

export class MaterialCompiler {
  compile(def: MaterialDefinition): string {
    const uniformDecls: string[] = [];
    const textureDecls: string[] = [];

    for (const [name, uniform] of Object.entries(def.uniforms)) {
      const wgslType = this.uniformToWGSL(uniform.type);
      uniformDecls.push(`  @binding(${uniform.binding}) ${name}: ${wgslType},`);
    }

    for (const [name, tex] of Object.entries(def.textures)) {
      textureDecls.push(`@group(0) @binding(${tex.binding}) var ${name}: texture_2d<f32>;`);
    }

    return `// Auto-generated from material definition: ${def.name}
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
};

struct Uniforms {
${uniformDecls.join("\n")}
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${textureDecls.join("\n")}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(input.position, 1.0);
  output.uv = input.uv;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}`;
  }

  private uniformToWGSL(type: string): string {
    switch (type) {
      case "f32": return "f32";
      case "vec2": return "vec2<f32>";
      case "vec3": return "vec3<f32>";
      case "vec4": return "vec4<f32>";
      case "mat4": return "mat4x4<f32>";
      default: return "f32";
    }
  }
}
