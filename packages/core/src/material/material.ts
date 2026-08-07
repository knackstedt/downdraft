import type { MaterialGraph } from "@downdraft/shader-graph";
import { GraphCompiler, getProfile } from "@downdraft/shader-graph";
import { DEFAULT_VARIANT_FLAGS, variantKey, type MaterialVariantFlags } from "./variants";

export enum MaterialType {
  PBR = "pbr",
  Physical = "physical",
  Toon = "toon",
  Matcap = "matcap",
  Normal = "normal",
  Depth = "depth",
  Shadow = "shadow",
  Unlit = "unlit",
  SSS = "sss",
  Sprite = "sprite",
  Line = "line",
}

export enum BlendMode {
  Opaque = "opaque",
  AlphaBlend = "alpha-blend",
  AlphaClip = "alpha-clip",
  Additive = "additive",
}

export enum CullMode {
  None = "none",
  Front = "front",
  Back = "back",
}

export interface MaterialUniform {
  name: string;
  type: "f32" | "vec2" | "vec3" | "vec4" | "mat4" | "u32" | "vec4Array";
  binding: number;
}

export interface MaterialTexture {
  name: string;
  binding: number;
  sampler: "linear-repeat" | "linear-clamp" | "point";
  dimension?: "2d" | "cube";
}

export interface MaterialDefinition {
  name: string;
  /** Original shader path (legacy/documentation; the render path uses inlineShaderSource). */
  shader: string;
  inlineShaderSource?: string;
  /** Optional material graph — compiled to inlineShaderSource at construction. */
  graph?: MaterialGraph;
  uniforms: Record<string, MaterialUniform>;
  textures: Record<string, MaterialTexture>;
  blendMode: BlendMode;
  cullMode: CullMode;
  profile?: string;
  materialType?: MaterialType;
  /** Variant flags for hybrid shader permutations. Defaults to DEFAULT_VARIANT_FLAGS. */
  variantFlags?: MaterialVariantFlags;
}

export class Material {
  name: string;
  shader: string;
  inlineShaderSource: string | undefined;
  /** The source graph, retained for editor round-tripping + variant recompilation. */
  graph: MaterialGraph | undefined;
  uniforms: Map<string, MaterialUniform>;
  textures: Map<string, MaterialTexture>;
  blendMode: BlendMode;
  cullMode: CullMode;
  uniformValues: Map<string, unknown> = new Map();
  pipelineKey: string = "";
  profile: string | undefined;
  materialType: MaterialType;
  variantFlags: MaterialVariantFlags;
  /** Per-variant compiled WGSL, keyed by variantKey(). Populated by the renderer/bridge. */
  compiledVariants: Map<string, string> = new Map();
  /** Per-variant render pipelines, keyed by variantKey(). Populated by the renderer. */
  variantCache: Map<string, unknown> = new Map();

  constructor(def: MaterialDefinition) {
    this.name = def.name;
    this.shader = def.shader;
    this.graph = def.graph;
    this.inlineShaderSource = def.inlineShaderSource;
    // If a graph is provided without explicit inline source, compile it now.
    if (!this.inlineShaderSource && this.graph) {
      const profile = def.profile ? getProfile(def.profile) : undefined;
      this.inlineShaderSource = new GraphCompiler().compile(this.graph, profile ? { profile } : undefined);
    }
    this.uniforms = new Map(Object.entries(def.uniforms));
    this.textures = new Map(Object.entries(def.textures));
    this.blendMode = def.blendMode;
    this.cullMode = def.cullMode;
    this.profile = def.profile;
    this.materialType = def.materialType ?? MaterialType.PBR;
    this.variantFlags = def.variantFlags ?? { ...DEFAULT_VARIANT_FLAGS };
    this.updatePipelineKey();
  }

  setUniform(name: string, value: unknown): void {
    this.uniformValues.set(name, value);
  }

  getUniform(name: string): unknown | undefined {
    return this.uniformValues.get(name);
  }

  /** Clear cached variant pipelines/WGSL (e.g. after hot-reload recompile). */
  invalidateVariants(): void {
    this.variantCache.clear();
    this.compiledVariants.clear();
    this.updatePipelineKey();
  }

  private updatePipelineKey(): void {
    const shaderHash = this.inlineShaderSource
      ? `${this.inlineShaderSource.length}:${this.inlineShaderSource.slice(0, 32)}`
      : this.shader;
    this.pipelineKey = `${this.name}:${this.materialType}:${this.blendMode}:${this.cullMode}:${variantKey(this.variantFlags)}:${shaderHash}`;
  }
}
