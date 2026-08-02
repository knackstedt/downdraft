import { describe, it, expect } from "bun:test";
import {
  wgslShader,
  dualShader,
  glslShader,
  hasShaderVariant,
  type ShaderSource,
  type ShaderLanguage,
} from "./shader-source.ts";

describe("shader-source — wgslShader", () => {
  it("creates a WGSL-only shader source", () => {
    const s = wgslShader("@vertex fn vs() {}");
    expect(s.wgsl).toBe("@vertex fn vs() {}");
    expect(s.glslVertex).toBeUndefined();
    expect(s.glslFragment).toBeUndefined();
    expect(s.glslCompute).toBeUndefined();
    expect(s.label).toBeUndefined();
  });

  it("creates a WGSL shader with label", () => {
    const s = wgslShader("fn main() {}", "test-shader");
    expect(s.wgsl).toBe("fn main() {}");
    expect(s.label).toBe("test-shader");
  });
});

describe("shader-source — dualShader", () => {
  it("creates a dual-language shader with both WGSL and GLSL", () => {
    const s = dualShader({
      wgsl: "@vertex fn vs() {}",
      glslVertex: "#version 300 es\nvoid main() {}",
      glslFragment: "#version 300 es\nvoid main() {}",
      label: "dual",
    });
    expect(s.wgsl).toBe("@vertex fn vs() {}");
    expect(s.glslVertex).toContain("#version 300 es");
    expect(s.glslFragment).toContain("#version 300 es");
    expect(s.label).toBe("dual");
  });

  it("creates a dual-language shader with compute", () => {
    const s = dualShader({
      wgsl: "@compute @workgroup_size(64) fn cs() {}",
      glslCompute: "#version 300 es\nvoid main() {}",
    });
    expect(s.wgsl).toContain("@compute");
    expect(s.glslCompute).toContain("#version 300 es");
    expect(s.glslVertex).toBeUndefined();
  });
});

describe("shader-source — glslShader", () => {
  it("creates a GLSL-only shader source", () => {
    const s = glslShader({
      vertex: "#version 300 es\nvoid main() {}",
      fragment: "#version 300 es\nvoid main() {}",
      label: "glsl-only",
    });
    expect(s.wgsl).toBeUndefined();
    expect(s.glslVertex).toContain("#version 300 es");
    expect(s.glslFragment).toContain("#version 300 es");
    expect(s.label).toBe("glsl-only");
  });
});

describe("shader-source — hasShaderVariant", () => {
  const wgslOnly: ShaderSource = { wgsl: "fn main() {}" };
  const dual: ShaderSource = {
    wgsl: "fn main() {}",
    glslVertex: "#version 300 es",
    glslFragment: "#version 300 es",
  };
  const glslOnly: ShaderSource = {
    glslVertex: "#version 300 es",
    glslFragment: "#version 300 es",
  };
  const computeShader: ShaderSource = {
    wgsl: "@compute fn cs() {}",
    glslCompute: "#version 300 es",
  };

  it("detects WGSL variant", () => {
    expect(hasShaderVariant(wgslOnly, "wgsl")).toBe(true);
    expect(hasShaderVariant(dual, "wgsl")).toBe(true);
    expect(hasShaderVariant(glslOnly, "wgsl")).toBe(false);
  });

  it("detects GLSL vertex variant", () => {
    expect(hasShaderVariant(wgslOnly, "glsl-vert")).toBe(false);
    expect(hasShaderVariant(dual, "glsl-vert")).toBe(true);
    expect(hasShaderVariant(glslOnly, "glsl-vert")).toBe(true);
  });

  it("detects GLSL fragment variant", () => {
    expect(hasShaderVariant(wgslOnly, "glsl-frag")).toBe(false);
    expect(hasShaderVariant(dual, "glsl-frag")).toBe(true);
    expect(hasShaderVariant(glslOnly, "glsl-frag")).toBe(true);
  });

  it("detects GLSL compute variant", () => {
    expect(hasShaderVariant(wgslOnly, "glsl-comp")).toBe(false);
    expect(hasShaderVariant(computeShader, "glsl-comp")).toBe(true);
  });

  it("detects generic GLSL (vertex or fragment)", () => {
    expect(hasShaderVariant(wgslOnly, "glsl")).toBe(false);
    expect(hasShaderVariant(dual, "glsl")).toBe(true);
    expect(hasShaderVariant(glslOnly, "glsl")).toBe(true);
  });

  it("returns false for unknown languages", () => {
    expect(hasShaderVariant(wgslOnly, "unknown" as ShaderLanguage)).toBe(false);
  });
});
