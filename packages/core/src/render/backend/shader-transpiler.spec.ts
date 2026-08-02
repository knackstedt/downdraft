import { beforeEach, describe, expect, it } from "bun:test";
import { getShaderSource, getTranspiler, registerShader, transpileShader } from "./shader-registry.ts";
import { ShaderTranspiler } from "./shader-transpiler.ts";

// ─── Test WGSL snippets ────────────────────────────────────────────────────

const SIMPLE_WGSL = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

const FULLSCREEN_WGSL = `
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0),
  );
  var o: VertexOutput;
  o.clipPos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
`;

const TEXTURE_SAMPLE_WGSL = `
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, };

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(colorTex, samp, input.uv);
}
`;

const COMPUTE_WGSL = `
@group(0) @binding(0) var<storage> data: array<vec4<f32>>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  data[idx] = data[idx] * 2.0;
}
`;

const STORAGE_BUFFER_WGSL = `
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(8) var<storage> pointLights: array<vec4<f32>>;

fn test() -> vec4<f32> {
  return pointLights[0u];
}
`;

const SHADOW_SAMPLER_WGSL = `
@group(0) @binding(5) var shadowMapTex: texture_2d<f32>;
@group(0) @binding(6) var shadowSampler: sampler_comparison;

fn shadowFactor(uv: vec2<f32>, depth: f32) -> f32 {
  return textureSampleCompare(shadowMapTex, shadowSampler, uv, depth);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let s = shadowFactor(vec2<f32>(0.5, 0.5), 0.9);
  return vec4<f32>(s, 0.0, 0.0, 1.0);
}
`;

// ─── Transpiler tests ──────────────────────────────────────────────────────

describe("ShaderTranspiler — basic transpilation", () => {
  let transpiler: ShaderTranspiler;

  beforeEach(() => {
    transpiler = new ShaderTranspiler();
  });

  it("transpiles simple vertex+fragment shader", () => {
    const result = transpiler.transpile(SIMPLE_WGSL);
    expect(result.errors).toHaveLength(0);
    expect(result.vertexShader).not.toBeNull();
    expect(result.fragmentShader).not.toBeNull();
    expect(result.vertexShader).toContain("#version 300 es");
    expect(result.fragmentShader).toContain("#version 300 es");
  });

  it("converts WGSL types to GLSL types", () => {
    const result = transpiler.transpile(SIMPLE_WGSL);
    expect(result.vertexShader).toContain("mat4");
    expect(result.vertexShader).not.toContain("mat4x4<f32>");
    expect(result.vertexShader).toContain("vec3");
    expect(result.vertexShader).not.toContain("vec3<f32>");
    expect(result.vertexShader).toContain("vec4");
    expect(result.vertexShader).not.toContain("vec4<f32>");
  });

  it("converts @builtin(position) to gl_Position", () => {
    const result = transpiler.transpile(SIMPLE_WGSL);
    expect(result.vertexShader).toContain("gl_Position");
    expect(result.vertexShader).not.toContain("@builtin(position)");
  });

  it("converts @builtin(vertex_index) to gl_VertexID", () => {
    const result = transpiler.transpile(FULLSCREEN_WGSL);
    expect(result.vertexShader).toContain("gl_VertexID");
  });

  it("generates uniform blocks from var<uniform>", () => {
    const result = transpiler.transpile(SIMPLE_WGSL);
    expect(result.vertexShader).toContain("layout(std140, binding = 0)");
    expect(result.vertexShader).toContain("uniform CameraUniforms");
  });

  it("generates texture declarations", () => {
    const result = transpiler.transpile(TEXTURE_SAMPLE_WGSL);
    expect(result.fragmentShader).toContain("sampler2D colorTex");
    expect(result.fragmentShader).toContain("uniform sampler samp");
  });

  it("converts textureSample to texture()", () => {
    const result = transpiler.transpile(TEXTURE_SAMPLE_WGSL);
    expect(result.fragmentShader).toContain("texture(colorTex");
    expect(result.fragmentShader).not.toContain("textureSample");
  });

  it("converts textureSampleCompare to texture()", () => {
    const result = transpiler.transpile(SHADOW_SAMPLER_WGSL);
    expect(result.fragmentShader).toContain("texture(shadowSampler");
    expect(result.fragmentShader).not.toContain("textureSampleCompare");
  });

  it("generates sampler2DShadow for sampler_comparison", () => {
    const result = transpiler.transpile(SHADOW_SAMPLER_WGSL);
    expect(result.fragmentShader).toContain("sampler2DShadow shadowSampler");
  });

  it("flags compute shaders as unsupported", () => {
    const result = transpiler.transpile(COMPUTE_WGSL);
    expect(result.computeShader).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Compute");
  });

  it("warns about storage buffers", () => {
    const result = transpiler.transpile(STORAGE_BUFFER_WGSL);
    expect(result.warnings.some((w) => w.includes("Storage buffer"))).toBe(true);
  });

  it("converts let to const", () => {
    const wgsl = `
      fn test() -> f32 {
        let x = 5.0;
        return x;
      }
      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
        let y = test();
        return vec4<f32>(y, 0.0, 0.0, 1.0);
      }
    `;
    const result = transpiler.transpile(wgsl);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("const x");
  });

  it("converts select() to mix()", () => {
    const wgsl = `
      fn test(a: f32, b: f32, c: bool) -> f32 {
        return select(a, b, c);
      }
      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
        let y = test(1.0, 2.0, true);
        return vec4<f32>(y, 0.0, 0.0, 1.0);
      }
    `;
    const result = transpiler.transpile(wgsl);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("mix(a, b, c)");
  });

  it("converts f32() cast to float()", () => {
    const wgsl = `
      fn test(x: u32) -> f32 {
        return f32(x);
      }
      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
        let y = test(0u);
        return vec4<f32>(y, 0.0, 0.0, 1.0);
      }
    `;
    const result = transpiler.transpile(wgsl);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("float(x)");
  });

  it("converts textureLoad to texelFetch", () => {
    const wgsl = `
      @group(0) @binding(0) var tex: texture_2d<f32>;
      fn test(uv: vec2<f32>) -> vec4<f32> {
        return textureLoad(tex, vec2<i32>(uv * 100.0), 0);
      }
      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
        return test(vec2<f32>(0.5, 0.5));
      }
    `;
    const result = transpiler.transpile(wgsl);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("texelFetch(");
  });

  it("returns null shaders for empty input", () => {
    const result = transpiler.transpile("");
    expect(result.vertexShader).toBeNull();
    expect(result.fragmentShader).toBeNull();
  });
});

// ─── Registry tests ────────────────────────────────────────────────────────

describe("ShaderTranspiler — registry", () => {
  let transpiler: ShaderTranspiler;

  beforeEach(() => {
    transpiler = new ShaderTranspiler();
  });

  it("registers and retrieves shader sources", () => {
    const source = {
      wgsl: "fn main() {}",
      glslVertex: "#version 300 es\nvoid main() {}",
      glslFragment: "#version 300 es\nvoid main() {}",
      label: "test",
    };
    transpiler.register("test-shader", source);
    const retrieved = transpiler.getShaderSource("test-shader");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.glslVertex).toContain("#version 300 es");
  });

  it("returns null for unregistered shaders", () => {
    expect(transpiler.getShaderSource("nonexistent")).toBeNull();
  });

  it("hasRegistered returns true for registered GLSL", () => {
    transpiler.register("test", {
      wgsl: "",
      glslVertex: "#version 300 es\nvoid main() {}",
      glslFragment: "#version 300 es\nvoid main() {}",
    });
    expect(transpiler.hasRegistered("test")).toBe(true);
    expect(transpiler.hasRegistered("nonexistent")).toBe(false);
  });

  it("uses registered GLSL instead of transpiling", () => {
    transpiler.register("simple", {
      wgsl: SIMPLE_WGSL,
      glslVertex: "#version 300 es\n// hand-written vertex\nvoid main() {}",
      glslFragment: "#version 300 es\n// hand-written fragment\nvoid main() {}",
    });
    const result = transpiler.transpile(SIMPLE_WGSL, "simple");
    expect(result.vertexShader).toContain("hand-written vertex");
    expect(result.fragmentShader).toContain("hand-written fragment");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("falls back to transpilation when name not registered", () => {
    const result = transpiler.transpile(SIMPLE_WGSL, "nonexistent");
    expect(result.vertexShader).not.toBeNull();
    expect(result.vertexShader).toContain("#version 300 es");
  });
});

// ─── Global registry tests ─────────────────────────────────────────────────

describe("shader-registry — global instance", () => {
  it("getTranspiler returns same instance", () => {
    const t1 = getTranspiler();
    const t2 = getTranspiler();
    expect(t1).toBe(t2);
  });

  it("has pre-registered core shaders", () => {
    expect(getShaderSource("blit")).not.toBeNull();
    expect(getShaderSource("skybox")).not.toBeNull();
    expect(getShaderSource("debug-line")).not.toBeNull();
    expect(getShaderSource("depth")).not.toBeNull();
    expect(getShaderSource("shadow")).not.toBeNull();
    expect(getShaderSource("fxaa")).not.toBeNull();
    expect(getShaderSource("fullscreen-vs")).not.toBeNull();
    expect(getShaderSource("vertex-color")).not.toBeNull();
  });

  it("blit GLSL has correct version and sampler", () => {
    const source = getShaderSource("blit");
    expect(source!.glslVertex).toContain("#version 300 es");
    expect(source!.glslFragment).toContain("sampler2D colorTex");
  });

  it("skybox GLSL has cubemap sampler", () => {
    const source = getShaderSource("skybox");
    expect(source!.glslFragment).toContain("samplerCube");
  });

  it("debug-line GLSL has vertex color output", () => {
    const source = getShaderSource("debug-line");
    expect(source!.glslVertex).toContain("vColor");
    expect(source!.glslFragment).toContain("vColor");
  });

  it("depth GLSL has near/far planes", () => {
    const source = getShaderSource("depth");
    expect(source!.glslFragment).toContain("nearPlane");
    expect(source!.glslFragment).toContain("farPlane");
  });

  it("shadow GLSL has lightViewProj", () => {
    const source = getShaderSource("shadow");
    expect(source!.glslVertex).toContain("lightViewProj");
  });

  it("fxaa GLSL has FxaaContrast function", () => {
    const source = getShaderSource("fxaa");
    expect(source!.glslFragment).toContain("FxaaContrast");
  });

  it("transpileShader uses registered GLSL", () => {
    const result = transpileShader("whatever", "blit");
    expect(result.vertexShader).toContain("#version 300 es");
    expect(result.vertexShader).toContain("vUv");
    expect(result.errors).toHaveLength(0);
  });

  it("registerShader adds to global registry", () => {
    registerShader("custom-test", {
      wgsl: "",
      glslVertex: "#version 300 es\nvoid main() {}",
      glslFragment: "#version 300 es\nvoid main() {}",
    });
    expect(getShaderSource("custom-test")).not.toBeNull();
  });
});

// ─── Real shader transpilation tests ───────────────────────────────────────

describe("ShaderTranspiler — real WGSL shaders", () => {
  let transpiler: ShaderTranspiler;

  beforeEach(() => {
    transpiler = new ShaderTranspiler();
  });

  it("transpiles debug-line.wgsl pattern", () => {
    const wgsl = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct LineVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct LineVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: LineVertexInput) -> LineVertexOutput {
  var output: LineVertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: LineVertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.errors).toHaveLength(0);
    expect(result.vertexShader).toContain("gl_Position");
    expect(result.vertexShader).toContain("layout(location = 0) in vec3 position");
    expect(result.vertexShader).toContain("layout(location = 1) in vec4 color");
    expect(result.fragmentShader).toContain("layout(location = 0) out vec4 fragColor0");
  });

  it("transpiles depth.wgsl pattern", () => {
    const wgsl = `
struct DepthUniforms {
  nearPlane: f32,
  farPlane: f32,
};

struct CameraUniforms {
  viewProj: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> depthU: DepthUniforms;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<uniform> model: ModelUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) viewDepth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.viewDepth = output.clipPosition.z / output.clipPosition.w;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let linearDepth = (input.viewDepth - depthU.nearPlane) / (depthU.farPlane - depthU.nearPlane);
  let gray = clamp(linearDepth, 0.0, 1.0);
  return vec4<f32>(gray, gray, gray, 1.0);
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.errors).toHaveLength(0);
    expect(result.vertexShader).toContain("layout(std140, binding = 0)");
    expect(result.vertexShader).toContain("nearPlane");
    expect(result.fragmentShader).toContain("clamp(linearDepth");
  });

  it("transpiles skybox.wgsl pattern with cubemap", () => {
    const wgsl = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var skyboxTex: texture_cube<f32>;
@group(0) @binding(2) var skyboxSampler: sampler;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(vec2<f32>(0.0), 1.0, 1.0);
  output.direction = vec3<f32>(1.0, 0.0, 0.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(skyboxTex, skyboxSampler, input.direction);
  return vec4<f32>(color.rgb, 1.0);
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.errors).toHaveLength(0);
    expect(result.fragmentShader).toContain("samplerCube skyboxTex");
    expect(result.fragmentShader).toContain("texture(skyboxTex");
  });

  it("transpiles fullscreen triangle vertex shader", () => {
    const wgsl = `
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0),
  );
  var o: VertexOutput;
  o.clipPos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.errors).toHaveLength(0);
    expect(result.vertexShader).not.toBeNull();
    expect(result.vertexShader).toContain("gl_VertexID");
    expect(result.vertexShader).toContain("gl_Position");
  });

  it("handles storage buffer declarations", () => {
    const wgsl = `
@group(0) @binding(8) var<storage> pointLights: array<vec4<f32>>;
@group(0) @binding(10) var<storage> spotLights: array<vec4<f32>>;

fn test() -> vec4<f32> {
  return pointLights[0u];
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return test();
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.warnings.some((w) => w.includes("Storage buffer"))).toBe(true);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("buffer");
    expect(result.fragmentShader).toContain("pointLights");
  });

  it("handles for loops with u32 counter", () => {
    const wgsl = `
fn test() -> f32 {
  var sum = 0.0;
  for (var i = 0u; i < 10u; i = i + 1u) {
    sum = sum + 1.0;
  }
  return sum;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let y = test();
  return vec4<f32>(y, 0.0, 0.0, 1.0);
}
`;
    const result = transpiler.transpile(wgsl);
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("for (i = 0u");
  });
});
