import { type MaterialDefinition } from "./material";

/**
 * Compiles a MaterialDefinition to WGSL.
 *
 * Priority:
 * 1. inlineShaderSource (from graph compilation or ?raw fallback .wgsl) — used directly.
 * 2. Auto-generated trivial white shader — last-resort fallback only.
 *
 * The graph is the primary source of truth; the 8 hand-written material-types/*.wgsl
 * files are loaded as inlineShaderSource fallbacks by MaterialLibrary. This compiler's
 * generated shader is only reached when a material has neither a graph nor a fallback.
 */
export class MaterialCompiler {
  compile(def: MaterialDefinition): string {
    if (def.inlineShaderSource) {
      return def.inlineShaderSource;
    }

    const uniformDecls: string[] = [];
    const textureDecls: string[] = [];

    for (const [name, uniform] of Object.entries(def.uniforms)) {
      const wgslType = this.uniformToWGSL(uniform.type);
      uniformDecls.push(`  @binding(${uniform.binding}) ${name}: ${wgslType},`);
    }

    for (const [name, tex] of Object.entries(def.textures)) {
      const dim = tex.dimension === "cube" ? "texture_cube<f32>" : "texture_2d<f32>";
      textureDecls.push(`@group(0) @binding(${tex.binding}) var ${name}: ${dim};`);
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
      case "u32": return "u32";
      case "vec4Array": return "array<vec4<f32>>";
      default: return "f32";
    }
  }
}
