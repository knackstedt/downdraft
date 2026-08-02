import { describe, it, expect, vi, beforeEach } from "bun:test";
import {
  getTranspiler,
  registerShader,
  getShaderSource,
  transpileShader,
} from "./shader-registry.ts";
import { dualShader, wgslShader } from "./shader-source.ts";

describe("shader-registry — global instance", () => {
  beforeEach(() => {
    // Ensure the transpiler is initialized
    getTranspiler();
  });

  it("getTranspiler returns same instance on repeated calls", () => {
    const t1 = getTranspiler();
    const t2 = getTranspiler();
    expect(t1).toBe(t2);
  });

  it("has pre-registered core shaders", () => {
    const t = getTranspiler();
    expect(t.hasRegistered("blit")).toBe(true);
    expect(t.hasRegistered("blit-simple")).toBe(true);
    expect(t.hasRegistered("skybox")).toBe(true);
    expect(t.hasRegistered("debug-line")).toBe(true);
    expect(t.hasRegistered("debug-point")).toBe(true);
    expect(t.hasRegistered("depth")).toBe(true);
    expect(t.hasRegistered("shadow")).toBe(true);
    expect(t.hasRegistered("fullscreen-vs")).toBe(true);
    expect(t.hasRegistered("fxaa")).toBe(true);
    expect(t.hasRegistered("vertex-color")).toBe(true);
  });

  it("blit GLSL has correct version and sampler", () => {
    const src = getShaderSource("blit");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("#version 300 es");
    expect(src!.glslFragment).toContain("sampler2D");
    expect(src!.glslFragment).toContain("texture(colorTex");
  });

  it("blit-simple GLSL has correct version and sampler", () => {
    const src = getShaderSource("blit-simple");
    expect(src).not.toBeNull();
    expect(src!.glslFragment).toContain("#version 300 es");
    expect(src!.glslFragment).toContain("sampler2D");
  });

  it("skybox GLSL has cubemap sampler", () => {
    const src = getShaderSource("skybox");
    expect(src).not.toBeNull();
    expect(src!.glslFragment).toContain("samplerCube");
    expect(src!.glslVertex).toContain("invViewProj");
  });

  it("debug-line GLSL has vertex color output", () => {
    const src = getShaderSource("debug-line");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("layout(location = 0) in vec3 position");
    expect(src!.glslVertex).toContain("layout(location = 1) in vec4 color");
    expect(src!.glslFragment).toContain("vColor");
  });

  it("debug-point GLSL has gl_PointSize and gl_PointCoord", () => {
    const src = getShaderSource("debug-point");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("gl_PointSize");
    expect(src!.glslFragment).toContain("gl_PointCoord");
    expect(src!.glslFragment).toContain("discard");
  });

  it("depth GLSL has near/far planes", () => {
    const src = getShaderSource("depth");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("nearPlane");
    expect(src!.glslVertex).toContain("farPlane");
    expect(src!.glslFragment).toContain("linearDepth");
    expect(src!.glslFragment).toContain("clamp");
  });

  it("shadow GLSL has lightViewProj", () => {
    const src = getShaderSource("shadow");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("lightViewProj");
  });

  it("fullscreen-vs GLSL uses gl_VertexID for triangle generation", () => {
    const src = getShaderSource("fullscreen-vs");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("gl_VertexID");
    expect(src!.glslFragment).toBeUndefined();
  });

  it("fxaa GLSL has FxaaContrast function", () => {
    const src = getShaderSource("fxaa");
    expect(src).not.toBeNull();
    expect(src!.glslFragment).toContain("FxaaContrast");
    expect(src!.glslFragment).toContain("texelSize");
  });

  it("vertex-color GLSL has model uniform and color passthrough", () => {
    const src = getShaderSource("vertex-color");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("modelUniform");
    expect(src!.glslVertex).toContain("vColor");
    expect(src!.glslFragment).toContain("vColor");
  });

  it("getShaderSource returns null for unregistered shader", () => {
    expect(getShaderSource("nonexistent-shader")).toBeNull();
  });

  it("transpileShader uses registered GLSL instead of transpiling", () => {
    const wgsl = "fn dummy() {}";
    const result = transpileShader(wgsl, "blit");
    expect(result.vertexShader).toContain("#version 300 es");
    expect(result.fragmentShader).toContain("sampler2D");
    expect(result.errors).toHaveLength(0);
  });

  it("transpileShader falls back to transpilation when name not registered", () => {
    const wgsl = `
      @fragment
      fn fs_main() -> @location(0) vec4<f32> {
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
      }
    `;
    const result = transpileShader(wgsl, "nonexistent");
    expect(result.fragmentShader).not.toBeNull();
    expect(result.fragmentShader).toContain("#version 300 es");
  });

  it("registerShader adds to global registry", () => {
    const customShader = dualShader({
      wgsl: "",
      glslVertex: "#version 300 es\nvoid main() {}",
      glslFragment: "#version 300 es\nvoid main() {}",
      label: "custom-test",
    });
    registerShader("custom-test", customShader);
    const src = getShaderSource("custom-test");
    expect(src).not.toBeNull();
    expect(src!.glslVertex).toContain("void main()");
  });

  it("all registered shaders have glslVertex with #version 300 es", () => {
    const names = [
      "blit", "blit-simple", "skybox", "debug-line", "debug-point",
      "depth", "shadow", "fullscreen-vs", "fxaa", "vertex-color",
    ];
    for (const name of names) {
      const src = getShaderSource(name);
      expect(src).not.toBeNull();
      expect(src!.glslVertex).toContain("#version 300 es");
    }
  });

  it("all registered fragment shaders have #version 300 es (where fragment exists)", () => {
    const names = [
      "blit", "blit-simple", "skybox", "debug-line", "debug-point",
      "depth", "shadow", "fxaa", "vertex-color",
    ];
    for (const name of names) {
      const src = getShaderSource(name);
      expect(src).not.toBeNull();
      expect(src!.glslFragment).toBeDefined();
      expect(src!.glslFragment!).toContain("#version 300 es");
    }
  });

  it("all registered shaders have precision highp float", () => {
    const names = [
      "blit", "blit-simple", "skybox", "debug-line", "debug-point",
      "depth", "shadow", "fullscreen-vs", "fxaa", "vertex-color",
    ];
    for (const name of names) {
      const src = getShaderSource(name);
      expect(src!.glslVertex).toContain("precision highp float");
    }
  });

  it("registered shaders use dualShader format with empty wgsl", () => {
    const src = getShaderSource("blit");
    expect(src!.wgsl).toBe("");
    expect(src!.glslVertex).toBeDefined();
    expect(src!.glslFragment).toBeDefined();
  });
});
