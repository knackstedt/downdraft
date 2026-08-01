import { BlendMode, CullMode, Material, MaterialType, type MaterialDefinition } from "./material.ts";

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

  createPhysical(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/physical.wgsl",
      materialType: MaterialType.Physical,
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
        roughness: { name: "roughness", type: "f32", binding: 1 },
        metallic: { name: "metallic", type: "f32", binding: 2 },
        clearcoat: { name: "clearcoat", type: "f32", binding: 3 },
        clearcoatRoughness: { name: "clearcoatRoughness", type: "f32", binding: 4 },
        transmission: { name: "transmission", type: "f32", binding: 5 },
        ior: { name: "ior", type: "f32", binding: 6 },
        thickness: { name: "thickness", type: "f32", binding: 7 },
        sheenColor: { name: "sheenColor", type: "vec3", binding: 8 },
        sheenRoughness: { name: "sheenRoughness", type: "f32", binding: 9 },
        iridescence: { name: "iridescence", type: "f32", binding: 10 },
        iridescenceIOR: { name: "iridescenceIOR", type: "f32", binding: 11 },
        attenuationColor: { name: "attenuationColor", type: "vec3", binding: 12 },
        attenuationDistance: { name: "attenuationDistance", type: "f32", binding: 13 },
        envMapIntensity: { name: "envMapIntensity", type: "f32", binding: 14 },
      },
      textures: {
        albedoMap: { name: "albedoMap", binding: 20, sampler: "linear-repeat" },
        normalMap: { name: "normalMap", binding: 21, sampler: "linear-repeat" },
        clearcoatNormalMap: { name: "clearcoatNormalMap", binding: 22, sampler: "linear-repeat" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createToon(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/toon.wgsl",
      materialType: MaterialType.Toon,
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
        stepCount: { name: "stepCount", type: "f32", binding: 1 },
        stepSmoothness: { name: "stepSmoothness", type: "f32", binding: 2 },
        outlineColor: { name: "outlineColor", type: "vec4", binding: 3 },
        outlineWidth: { name: "outlineWidth", type: "f32", binding: 4 },
        rimColor: { name: "rimColor", type: "vec3", binding: 5 },
        rimPower: { name: "rimPower", type: "f32", binding: 6 },
      },
      textures: {
        albedoMap: { name: "albedoMap", binding: 10, sampler: "linear-repeat" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createMatcap(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/matcap.wgsl",
      materialType: MaterialType.Matcap,
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
      },
      textures: {
        matcapMap: { name: "matcapMap", binding: 1, sampler: "linear-clamp" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createNormal(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/normal.wgsl",
      materialType: MaterialType.Normal,
      uniforms: {},
      textures: {},
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createDepth(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/depth.wgsl",
      materialType: MaterialType.Depth,
      uniforms: {
        nearPlane: { name: "nearPlane", type: "f32", binding: 0 },
        farPlane: { name: "farPlane", type: "f32", binding: 1 },
      },
      textures: {},
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createShadow(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/shadow-viz.wgsl",
      materialType: MaterialType.Shadow,
      uniforms: {
        shadowColor: { name: "shadowColor", type: "vec4", binding: 0 },
      },
      textures: {},
      blendMode: BlendMode.AlphaBlend,
      cullMode: CullMode.None,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createSSS(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/sss.wgsl",
      materialType: MaterialType.SSS,
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
        subsurfaceColor: { name: "subsurfaceColor", type: "vec3", binding: 1 },
        scatterRadius: { name: "scatterRadius", type: "f32", binding: 2 },
        transmittance: { name: "transmittance", type: "f32", binding: 3 },
      },
      textures: {
        albedoMap: { name: "albedoMap", binding: 10, sampler: "linear-repeat" },
      },
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createSprite(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/sprite.wgsl",
      materialType: MaterialType.Sprite,
      uniforms: {
        color: { name: "color", type: "vec4", binding: 0 },
      },
      textures: {
        spriteMap: { name: "spriteMap", binding: 1, sampler: "linear-clamp" },
      },
      blendMode: BlendMode.AlphaBlend,
      cullMode: CullMode.None,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  createLine(name: string): Material {
    const def: MaterialDefinition = {
      name,
      shader: "shaders/line.wgsl",
      materialType: MaterialType.Line,
      uniforms: {
        color: { name: "color", type: "vec4", binding: 0 },
        lineWidth: { name: "lineWidth", type: "f32", binding: 1 },
        dashScale: { name: "dashScale", type: "f32", binding: 2 },
        dashSize: { name: "dashSize", type: "f32", binding: 3 },
        gapSize: { name: "gapSize", type: "f32", binding: 4 },
      },
      textures: {},
      blendMode: BlendMode.AlphaBlend,
      cullMode: CullMode.None,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }
}
