import { MaterialCompiler } from "./compiler.ts";
import { MaterialLibrary } from "./library.ts";
import { BlendMode, CullMode, Material, type MaterialDefinition } from "./material.ts";

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
});
