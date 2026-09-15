import { GBUFFER_PROFILE, MaterialGraph, PBR_PROFILE } from "@downdraft/shader-graph";
import { BlendMode, CullMode, Material, MaterialType, type MaterialDefinition } from "./material";
// Fallback WGSL sources — loaded via Vite ?raw so the render path can use
// inlineShaderSource directly. These are the hand-written fallbacks used when
// a material has no shader graph; the graph is the primary source of truth.
import DEPTH_WGSL from "../render/material-types/depth.wgsl?raw" with { type: "text" };
import LINE_WGSL from "../render/material-types/line.wgsl?raw" with { type: "text" };
import MATCAP_WGSL from "../render/material-types/matcap.wgsl?raw" with { type: "text" };
import NORMAL_WGSL from "../render/material-types/normal.wgsl?raw" with { type: "text" };
import PHYSICAL_WGSL from "../render/material-types/physical.wgsl?raw" with { type: "text" };
import SPRITE_WGSL from "../render/material-types/sprite.wgsl?raw" with { type: "text" };
import SSS_WGSL from "../render/material-types/sss.wgsl?raw" with { type: "text" };
import TOON_WGSL from "../render/material-types/toon.wgsl?raw" with { type: "text" };

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
      shader: "material-types/physical.wgsl",
      inlineShaderSource: PHYSICAL_WGSL,
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
      shader: "material-types/toon.wgsl",
      inlineShaderSource: TOON_WGSL,
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
      shader: "material-types/matcap.wgsl",
      inlineShaderSource: MATCAP_WGSL,
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
      shader: "material-types/normal.wgsl",
      inlineShaderSource: NORMAL_WGSL,
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
      shader: "material-types/depth.wgsl",
      inlineShaderSource: DEPTH_WGSL,
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
      shader: "material-types/sss.wgsl",
      inlineShaderSource: SSS_WGSL,
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
      shader: "material-types/sprite.wgsl",
      inlineShaderSource: SPRITE_WGSL,
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
      shader: "material-types/line.wgsl",
      inlineShaderSource: LINE_WGSL,
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

  // ── Graph-based preset materials ──────────────────────────────────────
  // These build a MaterialGraph equivalent to the hand-written fallback
  // shaders, giving the editor graph presets to load and modify. The graph
  // is the primary source of truth; the .wgsl fallbacks above are used when
  // a material has no graph.

  /**
   * Create a PBR graph material — a simple graph that samples an albedo texture
   * and applies PBR lighting via the pbr_lighting node. Uses the PBR profile.
   */
  createPBRGraph(name: string): Material {
    const g = new MaterialGraph();
    const normalId = g.input("normal", "vec3");
    const worldPosId = g.input("worldPos", "vec3");
    const baseColorId = g.input("baseColor", "vec3");
    const metallicId = g.input("metallic", "f32");
    const roughnessId = g.input("roughness", "f32");

    g.addNode({
      id: "pbr",
      type: "pbr_lighting",
      inputs: { N: "", worldPos: "", baseColor: "", metallic: "", roughness: "" },
      outputs: { value: "vec3" },
      properties: {},
    });
    g.connect(normalId, "value", "pbr", "N");
    g.connect(worldPosId, "value", "pbr", "worldPos");
    g.connect(baseColorId, "value", "pbr", "baseColor");
    g.connect(metallicId, "value", "pbr", "metallic");
    g.connect(roughnessId, "value", "pbr", "roughness");
    g.output("color", "pbr", "value");

    const def: MaterialDefinition = {
      name,
      shader: "graph://pbr",
      graph: g,
      uniforms: {
        baseColor: { name: "baseColor", type: "vec3", binding: 0 },
        metallic: { name: "metallic", type: "f32", binding: 1 },
        roughness: { name: "roughness", type: "f32", binding: 2 },
        normal: { name: "normal", type: "vec3", binding: 3 },
        worldPos: { name: "worldPos", type: "vec3", binding: 4 },
      },
      textures: {},
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
      profile: PBR_PROFILE.name,
      materialType: MaterialType.PBR,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }

  /**
   * Create a GBuffer graph material — a surface shader that writes albedo,
   * normal, metallic/emissive, and velocity to the deferred GBuffer targets.
   * Uses the GBUFFER_PROFILE (multi-render-target).
   */
  createGBufferGraph(name: string): Material {
    const g = new MaterialGraph();
    // Albedo output — vertex color (default white).
    g.addNode({
      id: "albedo_const",
      type: "vec4_constant",
      inputs: {},
      outputs: { value: "vec4" },
      properties: { value: [1, 1, 1, 1] },
    });
    g.output("albedo", "albedo_const", "value");

    // Normal output — world normal encoded to [0,1].
    g.addNode({
      id: "n",
      type: "normal",
      inputs: {},
      outputs: { value: "vec3" },
      properties: {},
    });
    g.addNode({
      id: "n_enc",
      type: "normalize",
      inputs: { v: "" },
      outputs: { result: "vec3" },
      properties: {},
    });
    g.connect("n", "value", "n_enc", "v");
    g.output("normal", "n_enc", "result");

    // Metallic/emissive — default zeros.
    g.addNode({
      id: "me_const",
      type: "vec4_constant",
      inputs: {},
      outputs: { value: "vec4" },
      properties: { value: [0, 0, 0, 0] },
    });
    g.output("metallicEmissive", "me_const", "value");

    // Velocity — default zero (static geometry).
    g.addNode({
      id: "vel_const",
      type: "vec4_constant",
      inputs: {},
      outputs: { value: "vec4" },
      properties: { value: [0, 0, 0, 0] },
    });
    g.output("velocity", "vel_const", "value");

    const def: MaterialDefinition = {
      name,
      shader: "graph://gbuffer",
      graph: g,
      uniforms: {},
      textures: {},
      blendMode: BlendMode.Opaque,
      cullMode: CullMode.Back,
      profile: GBUFFER_PROFILE.name,
      materialType: MaterialType.PBR,
    };
    const mat = new Material(def);
    this.register(mat);
    return mat;
  }
}
