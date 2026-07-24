import { Material, BlendMode, CullMode, type MaterialDefinition } from "./material.ts";

export class MaterialLibrary {
  private materials: Map<string, Material> = new Map();

  register(material: Material): void {
    this.materials.set(material.name, material);
  }

  get(name: string): Material | undefined {
    return this.materials.get(name);
  }

  list(): Material[] {
    return [...this.materials.values()];
  }

  unregister(name: string): boolean {
    return this.materials.delete(name);
  }

  createPBR(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/pbr.wgsl",
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
        roughness: { name: "roughness", type: "f32", binding: 1 },
        metallic: { name: "metallic", type: "f32", binding: 2 },
      },
      textures: {
        albedoMap: { name: "albedoMap", binding: 3, sampler: "linear-repeat" },
        normalMap: { name: "normalMap", binding: 4, sampler: "linear-repeat" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createUnlit(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/unlit.wgsl",
      uniforms: {
        color: { name: "color", type: "vec4", binding: 0 },
      },
      textures: {},
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createSkybox(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/skybox.wgsl",
      uniforms: {},
      textures: {
        cubemap: { name: "cubemap", binding: 0, sampler: "linear-clamp" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Front,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createParticle(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/particle.wgsl",
      uniforms: {
        color: { name: "color", type: "vec4", binding: 0 },
      },
      textures: {},
      blendMode: BlendMode.Additive,
      cullMode: CullMode.None,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createPostProcess(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/postprocess.wgsl",
      uniforms: {},
      textures: {
        source: { name: "source", binding: 0, sampler: "linear-clamp" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.None,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }
}
