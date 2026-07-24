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
  type: "f32" | "vec2" | "vec3" | "vec4" | "mat4";
  binding: number;
}

export interface MaterialTexture {
  name: string;
  binding: number;
  sampler: "linear-repeat" | "linear-clamp" | "point";
}

export interface MaterialDefinition {
  name: string;
  shader: string;
  uniforms: Record<string, MaterialUniform>;
  textures: Record<string, MaterialTexture>;
  blendMode: BlendMode;
  cullMode: CullMode;
}

export class Material {
  name: string;
  shader: string;
  uniforms: Map<string, MaterialUniform>;
  textures: Map<string, MaterialTexture>;
  blendMode: BlendMode;
  cullMode: CullMode;
  uniformValues: Map<string, unknown> = new Map();
  pipelineKey: string = "";

  constructor(def: MaterialDefinition) {
    this.name = def.name;
    this.shader = def.shader;
    this.uniforms = new Map(Object.entries(def.uniforms));
    this.textures = new Map(Object.entries(def.textures));
    this.blendMode = def.blendMode;
    this.cullMode = def.cullMode;
    this.updatePipelineKey();
  }

  setUniform(name: string, value: unknown): void {
    this.uniformValues.set(name, value);
  }

  getUniform(name: string): unknown | undefined {
    return this.uniformValues.get(name);
  }

  private updatePipelineKey(): void {
    this.pipelineKey = `${this.name}:${this.blendMode}:${this.cullMode}`;
  }
}
