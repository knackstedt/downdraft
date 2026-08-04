import { MaterialCompiler } from "./compiler";
import { MaterialLibrary } from "./library";
import { BlendMode, CullMode, Material, MaterialType, type MaterialDefinition } from "./material";

function makeTestMaterialDef(): MaterialDefinition {
  return {
    name: "test",
    shader: "shaders/test.wgsl",
    uniforms: {
      color: { name: "color", type: "vec4", binding: 0 },
      intensity: { name: "intensity", type: "f32", binding: 1 },
    },
    textures: {
      mainTex: { name: "mainTex", binding: 2, sampler: "linear-repeat" },
    },
    blendMode: BlendMode.Opaque,
    cullMode: CullMode.Back,
  };
}

describe("Material", () => {
  it("should construct from definition", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.name).toBe("test");
    expect(mat.shader).toBe("shaders/test.wgsl");
    expect(mat.blendMode).toBe(BlendMode.Opaque);
    expect(mat.cullMode).toBe(CullMode.Back);
  });

  it("should store uniforms in a Map", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.uniforms.has("color")).toBe(true);
    expect(mat.uniforms.has("intensity")).toBe(true);
    expect(mat.uniforms.size).toBe(2);
  });

  it("should store textures in a Map", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.textures.has("mainTex")).toBe(true);
    expect(mat.textures.size).toBe(1);
  });

  it("should set and get uniform values", () => {
    const mat = new Material(makeTestMaterialDef());
    mat.setUniform("color", [1, 0, 0, 1]);
    expect(mat.getUniform("color")).toEqual([1, 0, 0, 1]);
  });

  it("should return undefined for unset uniform", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.getUniform("nonexistent")).toBeUndefined();
  });

  it("should generate pipeline key", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.pipelineKey).toContain("test");
    expect(mat.pipelineKey).toContain(BlendMode.Opaque);
    expect(mat.pipelineKey).toContain(CullMode.Back);
  });

  it("should have distinct pipeline keys for different blend modes", () => {
    const def1 = makeTestMaterialDef();
    const def2 = { ...makeTestMaterialDef(), blendMode: BlendMode.Additive };
    const mat1 = new Material(def1);
    const mat2 = new Material(def2);
    expect(mat1.pipelineKey).not.toBe(mat2.pipelineKey);
  });

  it("should store inlineShaderSource when provided", () => {
    const def = makeTestMaterialDef();
    def.inlineShaderSource = "// inline WGSL";
    const mat = new Material(def);
    expect(mat.inlineShaderSource).toBe("// inline WGSL");
  });

  it("should have undefined inlineShaderSource by default", () => {
    const mat = new Material(makeTestMaterialDef());
    expect(mat.inlineShaderSource).toBeUndefined();
  });

  it("should include inline shader hash in pipeline key", () => {
    const def1 = makeTestMaterialDef();
    def1.inlineShaderSource = "shader A";
    const def2 = makeTestMaterialDef();
    def2.inlineShaderSource = "shader B";
    const mat1 = new Material(def1);
    const mat2 = new Material(def2);
    expect(mat1.pipelineKey).not.toBe(mat2.pipelineKey);
  });
});

describe("MaterialLibrary", () => {
  it("should register and get materials", () => {
    const lib = new MaterialLibrary();
    const mat = new Material(makeTestMaterialDef());
    lib.register(mat);
    expect(lib.get("test")).toBe(mat);
  });

  it("should list all materials", () => {
    const lib = new MaterialLibrary();
    lib.createPBR("pbr1");
    lib.createUnlit("unlit1");
    expect(lib.list().length).toBe(2);
  });

  it("should unregister materials", () => {
    const lib = new MaterialLibrary();
    lib.createPBR("pbr1");
    lib.unregister("pbr1");
    expect(lib.get("pbr1")).toBeUndefined();
  });

  it("should create PBR material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createPBR("pbr");
    expect(mat.name).toBe("pbr");
    expect(mat.shader).toBe("shaders/pbr.wgsl");
    expect(mat.uniforms.has("baseColor")).toBe(true);
    expect(mat.uniforms.has("roughness")).toBe(true);
    expect(mat.uniforms.has("metallic")).toBe(true);
    expect(mat.textures.has("albedoMap")).toBe(true);
    expect(mat.textures.has("normalMap")).toBe(true);
  });

  it("should create unlit material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createUnlit("unlit");
    expect(mat.name).toBe("unlit");
    expect(mat.shader).toBe("shaders/unlit.wgsl");
    expect(mat.uniforms.has("color")).toBe(true);
  });

  it("should create skybox material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createSkybox("sky");
    expect(mat.name).toBe("sky");
    expect(mat.shader).toBe("shaders/skybox.wgsl");
    expect(mat.cullMode).toBe(CullMode.Front);
    expect(mat.textures.has("cubemap")).toBe(true);
  });

  it("should create particle material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createParticle("particles");
    expect(mat.name).toBe("particles");
    expect(mat.blendMode).toBe(BlendMode.Additive);
    expect(mat.cullMode).toBe(CullMode.None);
  });

  it("should create post-process material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createPostProcess("post");
    expect(mat.name).toBe("post");
    expect(mat.shader).toBe("shaders/postprocess.wgsl");
    expect(mat.textures.has("source")).toBe(true);
  });

  it("should create physical material with clearcoat and sheen uniforms", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createPhysical("phys");
    expect(mat.name).toBe("phys");
    expect(mat.materialType).toBe(MaterialType.Physical);
    expect(mat.uniforms.has("clearcoat")).toBe(true);
    expect(mat.uniforms.has("sheenColor")).toBe(true);
    expect(mat.uniforms.has("transmission")).toBe(true);
    expect(mat.uniforms.has("iridescence")).toBe(true);
    expect(mat.textures.has("clearcoatNormalMap")).toBe(true);
  });

  it("should create toon material with step and rim uniforms", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createToon("toon");
    expect(mat.name).toBe("toon");
    expect(mat.materialType).toBe(MaterialType.Toon);
    expect(mat.uniforms.has("stepCount")).toBe(true);
    expect(mat.uniforms.has("rimColor")).toBe(true);
    expect(mat.uniforms.has("outlineWidth")).toBe(true);
  });

  it("should create matcap material with matcap texture", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createMatcap("mc");
    expect(mat.name).toBe("mc");
    expect(mat.materialType).toBe(MaterialType.Matcap);
    expect(mat.textures.has("matcapMap")).toBe(true);
  });

  it("should create normal material", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createNormal("nrm");
    expect(mat.name).toBe("nrm");
    expect(mat.materialType).toBe(MaterialType.Normal);
  });

  it("should create depth material with near/far planes", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createDepth("dep");
    expect(mat.name).toBe("dep");
    expect(mat.materialType).toBe(MaterialType.Depth);
    expect(mat.uniforms.has("nearPlane")).toBe(true);
    expect(mat.uniforms.has("farPlane")).toBe(true);
  });

  it("should create shadow material with alpha blend", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createShadow("shd");
    expect(mat.name).toBe("shd");
    expect(mat.materialType).toBe(MaterialType.Shadow);
    expect(mat.blendMode).toBe(BlendMode.AlphaBlend);
  });

  it("should create SSS material with subsurface color", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createSSS("sss");
    expect(mat.name).toBe("sss");
    expect(mat.materialType).toBe(MaterialType.SSS);
    expect(mat.uniforms.has("subsurfaceColor")).toBe(true);
    expect(mat.uniforms.has("scatterRadius")).toBe(true);
  });

  it("should create sprite material with alpha blend", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createSprite("spr");
    expect(mat.name).toBe("spr");
    expect(mat.materialType).toBe(MaterialType.Sprite);
    expect(mat.blendMode).toBe(BlendMode.AlphaBlend);
    expect(mat.textures.has("spriteMap")).toBe(true);
  });

  it("should create line material with dash parameters", () => {
    const lib = new MaterialLibrary();
    const mat = lib.createLine("ln");
    expect(mat.name).toBe("ln");
    expect(mat.materialType).toBe(MaterialType.Line);
    expect(mat.uniforms.has("lineWidth")).toBe(true);
    expect(mat.uniforms.has("dashSize")).toBe(true);
  });

  it("should include materialType in pipeline key", () => {
    const lib = new MaterialLibrary();
    const pbr = lib.createPBR("pbr");
    const toon = lib.createToon("toon");
    expect(pbr.pipelineKey).toContain(MaterialType.PBR);
    expect(toon.pipelineKey).toContain(MaterialType.Toon);
  });
});

describe("MaterialCompiler", () => {
  it("should compile a material definition to WGSL", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(typeof wgsl).toBe("string");
    expect(wgsl.length).toBeGreaterThan(0);
  });

  it("should include vertex shader", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(wgsl).toContain("@vertex");
    expect(wgsl).toContain("vs_main");
  });

  it("should include fragment shader", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(wgsl).toContain("@fragment");
    expect(wgsl).toContain("fs_main");
  });

  it("should include uniform declarations", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(wgsl).toContain("color");
    expect(wgsl).toContain("intensity");
    expect(wgsl).toContain("vec4<f32>");
    expect(wgsl).toContain("f32");
  });

  it("should include texture declarations", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(wgsl).toContain("mainTex");
    expect(wgsl).toContain("texture_2d<f32>");
  });

  it("should include material name in comment", () => {
    const compiler = new MaterialCompiler();
    const wgsl = compiler.compile(makeTestMaterialDef());
    expect(wgsl).toContain("test");
  });

  it("should handle material with no textures", () => {
    const compiler = new MaterialCompiler();
    const def = makeTestMaterialDef();
    def.textures = {};
    const wgsl = compiler.compile(def);
    expect(wgsl).not.toContain("texture_2d");
  });

  it("should handle mat4 uniform type", () => {
    const compiler = new MaterialCompiler();
    const def = makeTestMaterialDef();
    def.uniforms = { transform: { name: "transform", type: "mat4", binding: 0 } };
    const wgsl = compiler.compile(def);
    expect(wgsl).toContain("mat4x4<f32>");
  });

  it("should handle u32 uniform type", () => {
    const compiler = new MaterialCompiler();
    const def = makeTestMaterialDef();
    def.uniforms = { count: { name: "count", type: "u32", binding: 0 } };
    const wgsl = compiler.compile(def);
    expect(wgsl).toContain("u32");
  });

  it("should handle vec4Array uniform type", () => {
    const compiler = new MaterialCompiler();
    const def = makeTestMaterialDef();
    def.uniforms = { data: { name: "data", type: "vec4Array", binding: 0 } };
    const wgsl = compiler.compile(def);
    expect(wgsl).toContain("array<vec4<f32>>");
  });

  it("should handle cube texture dimension", () => {
    const compiler = new MaterialCompiler();
    const def = makeTestMaterialDef();
    def.textures = { envMap: { name: "envMap", binding: 0, sampler: "linear-clamp", dimension: "cube" } };
    const wgsl = compiler.compile(def);
    expect(wgsl).toContain("texture_cube<f32>");
  });
});
