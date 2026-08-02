// ============================================================================
// Shader Registry — registers hand-written GLSL ES 3.00 shaders for core
// render passes. These take precedence over auto-transpiled WGSL.
//
// The registry is populated at module load time. Call getTranspiler() to
// get a ShaderTranspiler instance with all registered shaders.
// ============================================================================

import { ShaderTranspiler } from "./shader-transpiler.ts";
import type { ShaderSource } from "./shader-source.ts";
import { dualShader, wgslShader } from "./shader-source.ts";

// ─── Hand-written GLSL shaders ─────────────────────────────────────────────

const BLIT_GLSL_VERT = `#version 300 es
precision highp float;

layout(location = 0) out vec2 vUv;

void main() {
  vec2 p = vec2(-1.0, -1.0);
  if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  if (gl_VertexID == 2) p = vec2(-1.0, 3.0);
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}
`;

const BLIT_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 fragColor0;

layout(binding = 0) uniform sampler2D colorTex;
layout(binding = 2) uniform sampler samp;

void main() {
  fragColor0 = texture(colorTex, vUv);
}
`;

const SKYBOX_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform CameraUniforms {
  mat4 viewProj;
  mat4 invViewProj;
  vec3 cameraPos;
  float _pad0;
} camera;

layout(location = 0) out vec3 vDirection;

void main() {
  vec2 positions[6] = vec2[6](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0, -1.0),
    vec2( 1.0,  1.0)
  );
  vec2 pos = positions[gl_VertexID];
  gl_Position = vec4(pos, 1.0, 1.0);
  vec3 ndc = vec3(pos, 1.0);
  vec4 worldDir = camera.invViewProj * vec4(ndc, 1.0);
  vDirection = normalize(worldDir.xyz / worldDir.w - camera.cameraPos);
}
`;

const SKYBOX_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec3 vDirection;
layout(location = 0) out vec4 fragColor0;

layout(binding = 1) uniform samplerCube skyboxTex;
layout(binding = 2) uniform sampler skyboxSampler;

void main() {
  vec3 color = texture(skyboxTex, vDirection).rgb;
  fragColor0 = vec4(color, 1.0);
}
`;

const DEBUG_LINE_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform CameraUniforms {
  mat4 viewProj;
} camera;

layout(location = 0) in vec3 position;
layout(location = 1) in vec4 color;

layout(location = 0) out vec4 vColor;

void main() {
  gl_Position = camera.viewProj * vec4(position, 1.0);
  vColor = color;
}
`;

const DEBUG_LINE_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec4 vColor;
layout(location = 0) out vec4 fragColor0;

void main() {
  fragColor0 = vColor;
}
`;

const DEBUG_POINT_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform CameraUniforms {
  mat4 viewProj;
  vec3 cameraPos;
  float _pad;
} camera;

layout(location = 0) in vec3 position;
layout(location = 1) in vec4 color;
layout(location = 2) in float size;

layout(location = 0) out vec4 vColor;

void main() {
  gl_Position = camera.viewProj * vec4(position, 1.0);
  gl_PointSize = size;
  vColor = color;
}
`;

const DEBUG_POINT_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec4 vColor;
layout(location = 0) out vec4 fragColor0;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  if (length(coord) > 0.5) discard;
  fragColor0 = vColor;
}
`;

const DEPTH_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform DepthUniforms {
  float nearPlane;
  float farPlane;
} depthU;

layout(std140, binding = 1) uniform CameraUniforms {
  mat4 viewProj;
} camera;

layout(std140, binding = 2) uniform ModelUniforms {
  mat4 model;
} model;

layout(location = 0) in vec3 position;

layout(location = 0) out float vViewDepth;

void main() {
  vec4 worldPos = model.model * vec4(position, 1.0);
  gl_Position = camera.viewProj * worldPos;
  vViewDepth = gl_Position.z / gl_Position.w;
}
`;

const DEPTH_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in float vViewDepth;
layout(location = 0) out vec4 fragColor0;

void main() {
  float linearDepth = (vViewDepth - depthU.nearPlane) / (depthU.farPlane - depthU.nearPlane);
  float gray = clamp(linearDepth, 0.0, 1.0);
  fragColor0 = vec4(gray, gray, gray, 1.0);
}
`;

const SHADOW_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform CameraUniforms {
  mat4 lightViewProj;
} camera;

layout(binding = 1) uniform mat4 modelUniform;

layout(location = 0) in vec3 position;

void main() {
  vec4 worldPos = modelUniform * vec4(position, 1.0);
  gl_Position = camera.lightViewProj * worldPos;
}
`;

const SHADOW_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) out vec4 fragColor0;

void main() {
  // Depth-only pass — no color output needed
  fragColor0 = vec4(0.0);
}
`;

const FULLSCREEN_VS_GLSL = `#version 300 es
precision highp float;

layout(location = 0) out vec2 vUv;

void main() {
  vec2 p = vec2(-1.0, -1.0);
  if (gl_VertexID == 1) p = vec2(3.0, -1.0);
  if (gl_VertexID == 2) p = vec2(-1.0, 3.0);
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const FXAA_GLSL_VERT = FULLSCREEN_VS_GLSL;

const FXAA_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 fragColor0;

layout(binding = 0) uniform sampler2D colorTex;
layout(binding = 2) uniform sampler samp;

struct U { vec2 texelSize; float _p0; float _p1; float _p2; float _p3; float _p4; float _p5; float _p6; };
layout(std140, binding = 3) uniform U_block {
  U u;
};

float FxaaContrast(vec4 a, vec4 b) {
  vec4 d = abs(a - b);
  return max(max(max(d.r, d.g), d.b), d.a);
}

void main() {
  vec2 posM = vUv;
  vec2 rcpFrame = u.texelSize;

  vec4 rgbaM = texture(colorTex, posM);
  vec4 rgbaS = texture(colorTex, posM + vec2(0.0, rcpFrame.y));
  vec4 rgbaE = texture(colorTex, posM + vec2(rcpFrame.x, 0.0));
  vec4 rgbaN = texture(colorTex, posM + vec2(0.0, -rcpFrame.y));
  vec4 rgbaW = texture(colorTex, posM + vec2(-rcpFrame.x, 0.0));

  float earlyExit = max(max(max(
    FxaaContrast(rgbaM, rgbaN),
    FxaaContrast(rgbaM, rgbaS)),
    FxaaContrast(rgbaM, rgbaE)),
    FxaaContrast(rgbaM, rgbaW)) < 0.2;
  if (earlyExit) { fragColor0 = rgbaM; return; }

  float contrastN = FxaaContrast(rgbaM, rgbaN);
  float contrastS = FxaaContrast(rgbaM, rgbaS);
  float contrastE = FxaaContrast(rgbaM, rgbaE);
  float contrastW = FxaaContrast(rgbaM, rgbaW);

  float relativeVContrast = (contrastN + contrastS) - (contrastE + contrastW);
  relativeVContrast *= 5.0;

  bool horzSpan = relativeVContrast > 0.0;

  if (abs(relativeVContrast) < 0.3) {
    float dirToEdgeX = contrastE > contrastW ? 1.0 : -1.0;
    float dirToEdgeY = contrastS > contrastN ? 1.0 : -1.0;

    vec4 rgbaAlongH = textureLod(colorTex, posM + vec2(dirToEdgeX, -dirToEdgeY) * rcpFrame, 0.0);
    float matchAlongH = FxaaContrast(rgbaM, rgbaAlongH);

    vec4 rgbaAlongV = textureLod(colorTex, posM + vec2(-dirToEdgeX, dirToEdgeY) * rcpFrame, 0.0);
    float matchAlongV = FxaaContrast(rgbaM, rgbaAlongV);

    relativeVContrast = (matchAlongV - matchAlongH) * 5.0;
    if (abs(relativeVContrast) < 0.3) {
      fragColor0 = mix(rgbaM, (rgbaN + rgbaS + rgbaE + rgbaW) * 0.25, 0.4);
      return;
    }
    horzSpan = relativeVContrast > 0.0;
  }

  vec4 rgbaN2 = horzSpan ? rgbaW : rgbaN;
  vec4 rgbaS2 = horzSpan ? rgbaE : rgbaS;

  bool pairN = FxaaContrast(rgbaM, rgbaN2) > FxaaContrast(rgbaM, rgbaS2);
  if (!pairN) { rgbaN2 = rgbaS2; }

  float offNPX = horzSpan ? rcpFrame.x : 0.0;
  float offNPY = horzSpan ? 0.0 : rcpFrame.y;

  bool doneN = false;
  bool doneP = false;
  float nDist = 0.0;
  float pDist = 0.0;
  vec2 posN = posM;
  vec2 posP = posM;

  for (uint i = 0u; i < 5u; i++) {
    float inc = float(i + 1u);
    if (!doneN) {
      nDist += inc;
      posN = posM + vec2(offNPX, offNPY) * nDist;
      vec4 rgbaEndN = textureLod(colorTex, posN, 0.0);
      doneN = FxaaContrast(rgbaEndN, rgbaM) > FxaaContrast(rgbaEndN, rgbaN2);
    }
    if (!doneP) {
      pDist += inc;
      posP = posM - vec2(offNPX, offNPY) * pDist;
      vec4 rgbaEndP = textureLod(colorTex, posP, 0.0);
      doneP = FxaaContrast(rgbaEndP, rgbaM) > FxaaContrast(rgbaEndP, rgbaN2);
    }
    if (doneN || doneP) break;
  }

  if (!doneN && !doneP) { fragColor0 = rgbaM; return; }

  float span = nDist + pDist;
  float dist = min(nDist, pDist) / max(span, 0.001);
  dist = 1.0 - dist;
  dist = sqrt(dist);

  fragColor0 = mix(rgbaM, rgbaN2, dist * 0.5);
}
`;

const BLIT_GLSL_FRAG_SIMPLE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 fragColor0;

layout(binding = 0) uniform sampler2D colorTex;
layout(binding = 2) uniform sampler samp;

void main() {
  fragColor0 = texture(colorTex, vUv);
}
`;

const VERTEX_COLOR_GLSL_VERT = `#version 300 es
precision highp float;

layout(std140, binding = 0) uniform CameraUniforms {
  mat4 viewProj;
} camera;

layout(binding = 1) uniform mat4 modelUniform;

layout(location = 0) in vec3 position;
layout(location = 1) in vec4 color;

layout(location = 0) out vec4 vColor;

void main() {
  gl_Position = camera.viewProj * modelUniform * vec4(position, 1.0);
  vColor = color;
}
`;

const VERTEX_COLOR_GLSL_FRAG = `#version 300 es
precision highp float;

layout(location = 0) in vec4 vColor;
layout(location = 0) out vec4 fragColor0;

void main() {
  fragColor0 = vColor;
}
`;

// ─── Registry Setup ────────────────────────────────────────────────────────

let _transpiler: ShaderTranspiler | null = null;

/**
 * Get the shared ShaderTranspiler instance with all registered GLSL shaders.
 */
export function getTranspiler(): ShaderTranspiler {
  if (_transpiler) return _transpiler;

  _transpiler = new ShaderTranspiler();

  // Register hand-written GLSL for core passes
  _transpiler.register("blit", dualShader({
    wgsl: "",
    glslVertex: BLIT_GLSL_VERT,
    glslFragment: BLIT_GLSL_FRAG,
    label: "blit",
  }));

  _transpiler.register("blit-simple", dualShader({
    wgsl: "",
    glslVertex: BLIT_GLSL_VERT,
    glslFragment: BLIT_GLSL_FRAG_SIMPLE,
    label: "blit-simple",
  }));

  _transpiler.register("skybox", dualShader({
    wgsl: "",
    glslVertex: SKYBOX_GLSL_VERT,
    glslFragment: SKYBOX_GLSL_FRAG,
    label: "skybox",
  }));

  _transpiler.register("debug-line", dualShader({
    wgsl: "",
    glslVertex: DEBUG_LINE_GLSL_VERT,
    glslFragment: DEBUG_LINE_GLSL_FRAG,
    label: "debug-line",
  }));

  _transpiler.register("debug-point", dualShader({
    wgsl: "",
    glslVertex: DEBUG_POINT_GLSL_VERT,
    glslFragment: DEBUG_POINT_GLSL_FRAG,
    label: "debug-point",
  }));

  _transpiler.register("depth", dualShader({
    wgsl: "",
    glslVertex: DEPTH_GLSL_VERT,
    glslFragment: DEPTH_GLSL_FRAG,
    label: "depth",
  }));

  _transpiler.register("shadow", dualShader({
    wgsl: "",
    glslVertex: SHADOW_GLSL_VERT,
    glslFragment: SHADOW_GLSL_FRAG,
    label: "shadow",
  }));

  _transpiler.register("fullscreen-vs", dualShader({
    wgsl: "",
    glslVertex: FULLSCREEN_VS_GLSL,
    glslFragment: undefined,
    label: "fullscreen-vs",
  }));

  _transpiler.register("fxaa", dualShader({
    wgsl: "",
    glslVertex: FXAA_GLSL_VERT,
    glslFragment: FXAA_GLSL_FRAG,
    label: "fxaa",
  }));

  _transpiler.register("vertex-color", dualShader({
    wgsl: "",
    glslVertex: VERTEX_COLOR_GLSL_VERT,
    glslFragment: VERTEX_COLOR_GLSL_FRAG,
    label: "vertex-color",
  }));

  return _transpiler;
}

/**
 * Register a custom shader with the shared transpiler.
 */
export function registerShader(name: string, source: ShaderSource): void {
  getTranspiler().register(name, source);
}

/**
 * Get a shader source by name from the shared transpiler registry.
 */
export function getShaderSource(name: string): ShaderSource | null {
  return getTranspiler().getShaderSource(name);
}

/**
 * Transpile WGSL to GLSL using the shared transpiler instance.
 */
export function transpileShader(wgsl: string, name?: string) {
  return getTranspiler().transpile(wgsl, name);
}
