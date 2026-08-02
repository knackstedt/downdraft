// ============================================================================
// Shader Source — backend-agnostic shader representation
// A ShaderSource carries shader code in one or more languages.
// The backend selects the appropriate language at compilation time.
// ============================================================================

export type ShaderLanguage = "wgsl" | "glsl" | "glsl-vert" | "glsl-frag" | "glsl-comp";

export interface ShaderSource {
  /** WGSL source (WebGPU). */
  wgsl?: string;
  /** GLSL ES 3.00 vertex shader source (WebGL2). */
  glslVertex?: string;
  /** GLSL ES 3.00 fragment shader source (WebGL2). */
  glslFragment?: string;
  /** GLSL ES 3.00 compute shader source (WebGL2 + extensions, rarely available). */
  glslCompute?: string;
  /** Optional label for debugging. */
  label?: string;
}

/**
 * Create a WGSL-only ShaderSource. This is the most common case
 * in the current codebase — GLSL variants will be added during
// the WebGL2 migration.
 */
export function wgslShader(code: string, label?: string): ShaderSource {
  return { wgsl: code, label };
}

/**
 * Create a dual-language ShaderSource with both WGSL and GLSL variants.
 */
export function dualShader(opts: {
  wgsl: string;
  glslVertex?: string;
  glslFragment?: string;
  glslCompute?: string;
  label?: string;
}): ShaderSource {
  return {
    wgsl: opts.wgsl,
    glslVertex: opts.glslVertex,
    glslFragment: opts.glslFragment,
    glslCompute: opts.glslCompute,
    label: opts.label,
  };
}

/**
 * Create a GLSL-only ShaderSource (for WebGL2-only passes).
 */
export function glslShader(opts: {
  vertex: string;
  fragment?: string;
  compute?: string;
  label?: string;
}): ShaderSource {
  return {
    glslVertex: opts.vertex,
    glslFragment: opts.fragment,
    glslCompute: opts.compute,
    label: opts.label,
  };
}

/**
 * Check if a ShaderSource has a variant for the given language.
 */
export function hasShaderVariant(source: ShaderSource, language: ShaderLanguage): boolean {
  switch (language) {
    case "wgsl":
      return source.wgsl !== undefined;
    case "glsl-vert":
      return source.glslVertex !== undefined;
    case "glsl-frag":
      return source.glslFragment !== undefined;
    case "glsl-comp":
      return source.glslCompute !== undefined;
    case "glsl":
      return source.glslVertex !== undefined || source.glslFragment !== undefined;
    default:
      return false;
  }
}
