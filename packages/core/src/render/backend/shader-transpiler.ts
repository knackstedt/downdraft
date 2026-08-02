// ============================================================================
// ShaderTranspiler — WGSL → GLSL ES 3.00 transpiler
//
// Converts WGSL shader source to GLSL ES 3.00 for WebGL2 fallback.
// Uses pattern-based transformation (not a full parser) which handles the
// common constructs in this codebase. Complex shaders can be registered as
// hand-written GLSL via the shader registry, which takes precedence.
// ============================================================================

import type { ShaderSource } from "./shader-source.ts";

export interface TranspileResult {
  vertexShader: string | null;
  fragmentShader: string | null;
  computeShader: string | null;
  warnings: string[];
  errors: string[];
}

interface StructInfo {
  name: string;
  fields: { name: string; type: string; originalType: string; builtin: string | null }[];
}

interface GlobalBinding {
  name: string;
  group: number;
  binding: number;
  kind: "uniform" | "storage" | "texture" | "sampler" | "sampler_comparison" | "storage_texture";
  typeName: string;
  access?: "read" | "write" | "read_write";
}

interface EntryPoint {
  stage: "vertex" | "fragment" | "compute";
  name: string;
  inputType: string | null;
  outputType: string | null;
  body: string;
}

const GLSL_VERSION = "#version 300 es";

// ─── Type Mapping ──────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  "f32": "float",
  "u32": "uint",
  "i32": "int",
  "f16": "float16_t",
  "u16": "uint16_t",
  "i16": "int16_t",
  "bool": "bool",
  "vec2<f32>": "vec2",
  "vec3<f32>": "vec3",
  "vec4<f32>": "vec4",
  "vec2<u32>": "uvec2",
  "vec3<u32>": "uvec3",
  "vec4<u32>": "uvec4",
  "vec2<i32>": "ivec2",
  "vec3<i32>": "ivec3",
  "vec4<i32>": "ivec4",
  "vec2<f16>": "f16vec2",
  "vec3<f16>": "f16vec3",
  "vec4<f16>": "f16vec4",
  "mat2x2<f32>": "mat2",
  "mat3x3<f32>": "mat3",
  "mat4x4<f32>": "mat4",
  "mat2x3<f32>": "mat2x3",
  "mat2x4<f32>": "mat2x4",
  "mat3x2<f32>": "mat3x2",
  "mat3x4<f32>": "mat3x4",
  "mat4x2<f32>": "mat4x2",
  "mat4x3<f32>": "mat4x3",
};

function mapType(wgslType: string): string {
  const trimmed = wgslType.trim();
  if (TYPE_MAP[trimmed]) return TYPE_MAP[trimmed];
  // array<T, N> → T[N] (handled separately in struct context)
  // texture types handled by convertTextures
  return trimmed;
}

function mapTypeInDeclaration(wgslType: string): string {
  const trimmed = wgslType.trim();
  // Handle array<type, count>
  const arrayMatch = trimmed.match(/^array<(.+),\s*(\d+)>$/);
  if (arrayMatch) {
    const elemType = mapType(arrayMatch[1]);
    return `${elemType}[${arrayMatch[2]}]`;
  }
  return mapType(trimmed);
}

// ─── Utility ───────────────────────────────────────────────────────────────

function stripComments(code: string): string {
  // Remove block comments
  let result = code.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments
  result = result.replace(/\/\/.*$/gm, "");
  return result;
}

// ─── Parser: Structs ───────────────────────────────────────────────────────

function parseStructs(code: string): StructInfo[] {
  const structs: StructInfo[] = [];
  const structRegex = /struct\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = structRegex.exec(code)) !== null) {
    const name = match[1];
    const body = match[2];
    const fields: StructInfo["fields"] = [];
    // Split by comma, but handle nested generics
    const fieldParts = splitFields(body);
    for (const part of fieldParts) {
      // Strip @location(N) and @builtin(...) decorators from field
      const cleaned = part.replace(/@\w+\([^)]*\)\s*/g, "").trim();
      if (!cleaned) continue;
      // Extract @builtin(...) before stripping decorators
      const builtinMatch = part.match(/@builtin\(\s*(\w+)\s*\)/);
      const builtin = builtinMatch ? builtinMatch[1] : null;
      const fieldMatch = cleaned.match(/^(\w+)\s*:\s*(.+)$/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const fieldType = fieldMatch[2].trim();
        fields.push({
          name: fieldName,
          type: mapTypeInDeclaration(fieldType),
          originalType: fieldType,
          builtin,
        });
      }
    }
    structs.push({ name, fields });
  }
  return structs;
}

function splitFields(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let parenDepth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "(") parenDepth++;
    if (ch === ")") parenDepth--;
    if (ch === "," && depth === 0 && parenDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// ─── Parser: Global Bindings ───────────────────────────────────────────────

function parseGlobalBindings(code: string): GlobalBinding[] {
  const bindings: GlobalBinding[] = [];
  // Match @group(N) @binding(M) var<kind> name: Type;
  // Also match @group(N) @binding(M) var name: Type;
  const bindingRegex =
    /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<\s*(\w+)\s*(?:,\s*(\w+)\s*)?>)?\s+(\w+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = bindingRegex.exec(code)) !== null) {
    const group = parseInt(match[1]);
    const binding = parseInt(match[2]);
    const addrSpace = match[3] ?? null;
    const access = match[4] ?? undefined;
    const name = match[5];
    const typeName = match[6].trim();

    let kind: GlobalBinding["kind"];
    if (addrSpace === "uniform") {
      kind = "uniform";
    } else if (addrSpace === "storage") {
      kind = "storage";
    } else if (typeName.startsWith("texture_") || typeName.startsWith("texture_depth")) {
      if (typeName.startsWith("texture_storage")) {
        kind = "storage_texture";
      } else {
        kind = "texture";
      }
    } else if (typeName === "sampler_comparison") {
      kind = "sampler_comparison";
    } else if (typeName === "sampler") {
      kind = "sampler";
    } else {
      kind = "uniform"; // default assumption
    }

    bindings.push({ name, group, binding, kind, typeName, access: access as GlobalBinding["access"] });
  }
  return bindings;
}

// ─── Parser: Entry Points ──────────────────────────────────────────────────

function parseEntryPoints(code: string): EntryPoint[] {
  const entries: EntryPoint[] = [];
  // Find @vertex/@fragment/@compute, skip any additional @decorators (like @workgroup_size),
  // then match fn name(params) -> ReturnType {
  // We can't use [^)]* for params because params may contain nested parens like @builtin(vertex_index)
  const stageRegex = /@(vertex|fragment|compute)\b/g;
  let match: RegExpExecArray | null;
  while ((match = stageRegex.exec(code)) !== null) {
    const stage = match[1] as EntryPoint["stage"];
    const afterStage = code.substring(match.index + match[0].length);

    // Skip any additional @decorator(...) clauses (e.g. @workgroup_size(64))
    let offset = 0;
    let rest = afterStage;
    while (rest.length > 0) {
      const trimmed = rest.replace(/^\s+/, "");
      const wsRemoved = rest.length - trimmed.length;
      const decMatch = trimmed.match(/^@\w+\([^)]*\)\s*/);
      if (decMatch) {
        offset += wsRemoved + decMatch[0].length;
        rest = trimmed.substring(decMatch[0].length);
      } else {
        offset += wsRemoved;
        rest = trimmed;
        break;
      }
    }

    // Now match fn name(params) -> ReturnType {
    const fnMatch = rest.match(/^fn\s+(\w+)\s*\(/);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    offset += fnMatch[0].length;

    // Find matching closing paren for params using paren matching
    const paramStart = match.index + match[0].length + offset;
    let parenDepth = 1;
    let paramEnd = paramStart;
    for (let i = paramStart; i < code.length; i++) {
      if (code[i] === "(") parenDepth++;
      if (code[i] === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          paramEnd = i;
          break;
        }
      }
    }
    const params = code.substring(paramStart, paramEnd).trim();

    // Find return type and opening brace
    const afterParams = code.substring(paramEnd + 1);
    const braceMatch = afterParams.match(/^\s*(?:->\s*([^{]+?))?\s*\{/);
    if (!braceMatch) continue;
    const returnType = braceMatch[1]?.trim() ?? null;

    // Find the matching closing brace
    const bodyStart = paramEnd + 1 + braceMatch[0].length;
    const body = extractBraceBody(code, bodyStart);

    entries.push({
      stage,
      name,
      inputType: params || null,
      outputType: returnType || null,
      body,
    });

    // Advance stageRegex past this entry point
    stageRegex.lastIndex = bodyStart + body.length + 1;
  }
  return entries;
}

function extractBraceBody(code: string, start: number): string {
  let depth = 1;
  let end = start;
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    if (code[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return code.substring(start, end);
}

// ─── Parser: Regular Functions ─────────────────────────────────────────────

function parseRegularFunctions(code: string): { name: string; body: string; fullText: string }[] {
  const funcs: { name: string; body: string; fullText: string }[] = [];
  // Match fn name(params) -> ReturnType { ... } (without @stage)
  const funcRegex = /fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(code)) !== null) {
    // Check if this is preceded by @vertex/@fragment/@compute
    const before = code.substring(Math.max(0, match.index - 30), match.index);
    if (/@(vertex|fragment|compute)\s*$/.test(before)) continue;

    const name = match[1];
    const bodyStart = match.index + match[0].length;
    const body = extractBraceBody(code, bodyStart);
    const fullText = code.substring(match.index, bodyStart + body.length + 1);
    funcs.push({ name, body, fullText });
  }
  return funcs;
}

// ─── Parser: Private Variables ─────────────────────────────────────────────

function parsePrivateVars(code: string): { name: string; type: string }[] {
  const vars: { name: string; type: string }[] = [];
  const varRegex = /var<private>\s+(\w+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = varRegex.exec(code)) !== null) {
    vars.push({ name: match[1], type: match[2].trim() });
  }
  return vars;
}

// ─── Parser: Constants ─────────────────────────────────────────────────────

function parseConstants(code: string): { name: string; value: string }[] {
  const consts: { name: string; value: string }[] = [];
  const constRegex = /const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = constRegex.exec(code)) !== null) {
    consts.push({ name: match[1], value: match[2].trim() });
  }
  return consts;
}

// ─── Code Transformation ───────────────────────────────────────────────────

function transformTypes(code: string): string {
  let result = code;
  // Replace vec types with template syntax → GLSL types
  // Order matters: longer patterns first
  const sortedTypes = Object.keys(TYPE_MAP).sort((a, b) => b.length - a.length);
  for (const wgslType of sortedTypes) {
    const glslType = TYPE_MAP[wgslType];
    // Use word-boundary-safe replacement
    const escaped = wgslType.replace(/[<>]/g, (c) => `\\${c}`);
    result = result.replace(new RegExp(escaped, "g"), glslType);
  }
  // Handle array<T, N> → T[N] in variable declarations (not in struct fields, already handled)
  // This is tricky — skip for now, handled in struct parsing
  return result;
}

function transformTextureFunctions(code: string): string {
  let result = code;
  // textureSample(tex, samp, uv) → texture(tex, uv)
  result = result.replace(/textureSample\s*\(\s*(\w+)\s*,\s*\w+\s*,\s*/g, "texture($1, ");
  // textureSampleLevel(tex, samp, uv, level) → textureLod(tex, uv, level)
  result = result.replace(/textureSampleLevel\s*\(\s*(\w+)\s*,\s*\w+\s*,\s*/g, "textureLod($1, ");
  // textureSampleCompare(tex, samp, uv, depth) → texture(samp, vec3(uv, depth))
  result = result.replace(
    /textureSampleCompare\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*([^,)]+)\s*,\s*([^,)]+)\s*\)/g,
    "texture($2, vec3($3, $4))",
  );
  // textureSampleCompareLevel(tex, samp, uv, ref) → texture(samp, vec3(uv, ref))
  result = result.replace(
    /textureSampleCompareLevel\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*([^,)]+)\s*,\s*([^,)]+)\s*(?:,\s*([^,)]+))?\s*\)/g,
    "texture($2, vec3($3, $4))",
  );
  // textureLoad(tex, coord, level) → texelFetch(tex, coord, level)
  result = result.replace(/textureLoad\s*\(/g, "texelFetch(");
  // textureDimensions(tex, level) → textureSize(tex, level)
  result = result.replace(/textureDimensions\s*\(/g, "textureSize(");
  return result;
}

function transformControlFlow(code: string): string {
  let result = code;
  // for (var i = 0u; ...) → for (i = 0u; ...)
  result = result.replace(/for\s*\(\s*var\s+(\w+)\s*=/g, "for ($1 =");
  // var x: type = value; → type x = value; (swap order for GLSL)
  result = result.replace(/\bvar\s+(\w+)\s*:\s*(\S+)\s*=\s*/g, "$2 $1 = ");
  // var x: type; → type x; (declaration without init)
  result = result.replace(/\bvar\s+(\w+)\s*:\s*(\S+)\s*;/g, "$2 $1;");
  // var x = value; → infer type from initializer
  // float for 0.0, uint for 0u, int for 0i, bool for true/false
  result = result.replace(/\bvar\s+(\w+)\s*=\s*(0u|\d+u)\s*;/g, "uint $1 = $2;");
  result = result.replace(/\bvar\s+(\w+)\s*=\s*(0i|\d+i)\s*;/g, "int $1 = $2;");
  result = result.replace(/\bvar\s+(\w+)\s*=\s*(true|false)\s*;/g, "bool $1 = $2;");
  result = result.replace(/\bvar\s+(\w+)\s*=\s*(-?\d+\.\d+)\s*;/g, "float $1 = $2;");
  // Remaining var x = value; → just remove var keyword (type inferred by GLSL compiler in most cases)
  result = result.replace(/\bvar\s+(\w+)\s*=\s*([^;]+);/g, "$1 = $2;");
  // let x = value; → const x = value;
  result = result.replace(/\blet\s+(\w+)\s*=/g, "const $1 =");
  // i = i + 1u → i++ (common pattern)
  result = result.replace(/(\w+)\s*=\s*\1\s*\+\s*1u/g, "$1++");
  result = result.replace(/(\w+)\s*=\s*\1\s*\+\s*1i/g, "$1++");
  // i = i - 1u → i--
  result = result.replace(/(\w+)\s*=\s*\1\s*-\s*1u/g, "$1--");
  return result;
}

function transformBuiltins(code: string): string {
  let result = code;
  // @builtin(position) in vertex output → gl_Position
  result = result.replace(/@builtin\s*\(\s*position\s*\)/g, "gl_Position");
  // @builtin(vertex_index) → gl_VertexID
  result = result.replace(/@builtin\s*\(\s*vertex_index\s*\)/g, "gl_VertexID");
  // @builtin(instance_index) → gl_InstanceID
  result = result.replace(/@builtin\s*\(\s*instance_index\s*\)/g, "gl_InstanceID");
  // @builtin(frag_depth) → gl_FragDepth
  result = result.replace(/@builtin\s*\(\s*frag_depth\s*\)/g, "gl_FragDepth");
  // @builtin(front_facing) → gl_FrontFacing
  result = result.replace(/@builtin\s*\(\s*front_facing\s*\)/g, "gl_FrontFacing");
  // @builtin(local_invocation_id) → gl_LocalInvocationID (compute, not in WebGL2)
  result = result.replace(/@builtin\s*\(\s*local_invocation_id\s*\)/g, "gl_LocalInvocationID");
  // @builtin(workgroup_id) → gl_WorkGroupID
  result = result.replace(/@builtin\s*\(\s*workgroup_id\s*\)/g, "gl_WorkGroupID");
  // @builtin(global_invocation_id) → gl_GlobalInvocationID
  result = result.replace(/@builtin\s*\(\s*global_invocation_id\s*\)/g, "gl_GlobalInvocationID");
  return result;
}

function transformMisc(code: string): string {
  let result = code;
  // select(false_val, true_val, condition) → mix(false_val, true_val, condition)
  // WGSL select is (false_val, true_val, cond) — GLSL mix is (a, b, t) = mix(a, b, t)
  // So select(f, t, c) → mix(f, t, c) — same semantics!
  result = result.replace(/\bselect\s*\(/g, "mix(");
  // mix(a, b, t) stays the same in GLSL
  // clamp, max, min, abs, sqrt, pow, sin, cos, etc. are the same
  // normalize, length, dot, cross, reflect, refract are the same
  // smoothstep is the same
  // f32(x) → float(x)
  result = result.replace(/\bf32\s*\(/g, "float(");
  result = result.replace(/\bu32\s*\(/g, "uint(");
  result = result.replace(/\bi32\s*\(/g, "int(");
  // vec2<f32>(x, y) → vec2(x, y) — already handled by type map, but handle constructor calls
  result = result.replace(/vec[234]<f32>\s*\(/g, (m) => m.replace(/<f32>/, ""));
  result = result.replace(/vec[234]<u32>\s*\(/g, (m) => m.replace(/<u32>/, "uvec".substring(0, 4) + m[3]));
  result = result.replace(/vec[234]<i32>\s*\(/g, (m) => m.replace(/<i32>/, "ivec".substring(0, 4) + m[3]));
  // mat4x4<f32>(...) → mat4(...)
  result = result.replace(/mat(\d)x(\d)<f32>\s*\(/g, "mat$1x$2(");
  // true/false stay the same
  // 0u → 0u (valid in GLSL ES 3.00)
  // 1.0 + 2.0 stays the same
  return result;
}

// ─── GLSL Generation ───────────────────────────────────────────────────────

function generateStruct(struct: StructInfo, isUniform: boolean): string {
  if (isUniform) {
    // Generate as a uniform block
    const fieldLines = struct.fields
      .map((f) => `  ${f.type} ${f.name};`)
      .join("\n");
    return `struct ${struct.name} {\n${fieldLines}\n};`;
  } else {
    // Regular struct
    const fieldLines = struct.fields
      .map((f) => `  ${f.type} ${f.name};`)
      .join("\n");
    return `struct ${struct.name} {\n${fieldLines}\n};`;
  }
}

function generateUniformBlock(binding: GlobalBinding, struct: StructInfo | null): string {
  const bindingNum = binding.binding;
  if (struct) {
    const fieldLines = struct.fields
      .map((f) => `  ${f.type} ${f.name};`)
      .join("\n");
    return `layout(std140, binding = ${bindingNum}) uniform ${struct.name} {\n${fieldLines}\n} ${binding.name};`;
  } else {
    // Simple uniform (e.g. mat4x4<f32>)
    const glslType = mapType(binding.typeName);
    return `layout(std140, binding = ${bindingNum}) uniform ${binding.name}_block {\n  ${glslType} ${binding.name};\n} ${binding.name};`;
  }
}

function generateStorageBuffer(binding: GlobalBinding): string {
  const bindingNum = binding.binding;
  const access = binding.access === "write" ? "" : "readonly ";
  const typeName = binding.typeName;
  // array<vec4<f32>> → vec4 name[]
  const arrayMatch = typeName.match(/^array<(.+)>$/);
  if (arrayMatch) {
    const elemType = mapType(arrayMatch[1]);
    return `layout(std430, binding = ${bindingNum}) ${access}buffer ${binding.name}_block {\n  ${elemType} ${binding.name}[];\n} ${binding.name};`;
  }
  return `layout(std430, binding = ${bindingNum}) ${access}buffer ${binding.name}_block {\n  ${mapType(typeName)} ${binding.name};\n} ${binding.name};`;
}

function generateTextureDeclaration(binding: GlobalBinding): string {
  const typeName = binding.typeName;
  const bindingNum = binding.binding;
  // Map WGSL texture types to GLSL sampler types
  const textureMap: Record<string, string> = {
    "texture_2d<f32>": "sampler2D",
    "texture_2d<i32>": "isampler2D",
    "texture_2d<u32>": "usampler2D",
    "texture_cube<f32>": "samplerCube",
    "texture_2d_array<f32>": "sampler2DArray",
    "texture_3d<f32>": "sampler3D",
    "texture_depth_2d": "sampler2D",
    "texture_depth_2d_array": "sampler2DArray",
    "texture_depth_cube": "samplerCube",
    "texture_depth_cube_array": "samplerCubeArray",
  };
  const glslType = textureMap[typeName] ?? "sampler2D";
  return `layout(binding = ${bindingNum}) uniform ${glslType} ${binding.name};`;
}

function generateSamplerDeclaration(binding: GlobalBinding): string {
  const bindingNum = binding.binding;
  if (binding.kind === "sampler_comparison") {
    return `layout(binding = ${bindingNum}) uniform sampler2DShadow ${binding.name};`;
  }
  return `layout(binding = ${bindingNum}) uniform sampler ${binding.name};`;
}

function generateVertexInput(params: string, structs: StructInfo[]): string {
  if (!params.trim()) return "";
  // Parse the input parameter — could be a struct or inline
  const paramMatch = params.match(/(?:@location\(\d+\)\s+)?(\w+)\s*:\s*(\w+)/);
  if (!paramMatch) return "";

  const inputTypeName = paramMatch[2];
  const struct = structs.find((s) => s.name === inputTypeName);
  if (struct) {
    const lines = struct.fields
      .map((f, i) => {
        if (f.name === "clipPosition" || f.name === "clipPos") return null; // builtin
        return `layout(location = ${i}) in ${f.type} ${f.name};`;
      })
      .filter(Boolean);
    return lines.join("\n");
  }
  return "";
}

function generateFragmentInput(entryPoint: EntryPoint, structs: StructInfo[]): string {
  // The fragment input is typically a struct passed from the vertex shader
  const inputType = entryPoint.inputType;
  if (!inputType) return "";

  // Try to find the struct reference
  const paramMatch = inputType.match(/(?:@location\(\d+\)\s+)?(\w+)\s*:\s*(\w+)/);
  if (!paramMatch) return "";

  const inputTypeName = paramMatch[2];
  const struct = structs.find((s) => s.name === inputTypeName);
  if (struct) {
    const lines = struct.fields
      .map((f, i) => {
        if (f.name === "clipPosition" || f.name === "clipPos") return null;
        return `layout(location = ${i}) in ${f.type} ${f.name};`;
      })
      .filter(Boolean);
    return lines.join("\n");
  }
  // Could be inline @location params
  const locMatch = inputType.match(/@location\((\d+)\)\s+(\w+)\s*:\s*(\S+)/);
  if (locMatch) {
    return `layout(location = ${locMatch[1]}) in ${mapType(locMatch[3])} ${locMatch[2]};`;
  }
  return "";
}

function generateFragmentOutput(entryPoint: EntryPoint, structs: StructInfo[]): string {
  const outputType = entryPoint.outputType;
  if (!outputType) return "";

  // @location(0) vec4<f32> → layout(location=0) out vec4 color;
  const locMatch = outputType.match(/@location\((\d+)\)\s*(\S+)/);
  if (locMatch) {
    return `layout(location = ${locMatch[1]}) out ${mapType(locMatch[2])} fragColor${locMatch[1]};`;
  }

  // Struct output
  const structMatch = outputType.match(/^(\w+)$/);
  if (structMatch) {
    const struct = structs.find((s) => s.name === structMatch[1]);
    if (struct) {
      return struct.fields
        .map((f, i) => `layout(location = ${i}) out ${f.type} ${f.name};`)
        .join("\n");
    }
  }

  // Tuple return: (@builtin(position) vec4<f32>, @location(0) vec2<f32>)
  if (outputType.startsWith("(")) {
    const parts = splitFields(outputType.slice(1, -1));
    const lines: string[] = [];
    for (const part of parts) {
      const trimmed = part.trim();
      const locMatch2 = trimmed.match(/@location\((\d+)\)\s*(\S+)/);
      if (locMatch2) {
        lines.push(`layout(location = ${locMatch2[1]}) out ${mapType(locMatch2[2])} fragColor${locMatch2[1]};`);
      }
    }
    return lines.join("\n");
  }

  return "";
}

// ─── Main Transpiler Class ─────────────────────────────────────────────────

export class ShaderTranspiler {
  private registry = new Map<string, ShaderSource>();
  private warnings: string[] = [];
  private errors: string[] = [];

  /**
   * Register a hand-written GLSL shader. Takes precedence over auto-transpilation.
   */
  register(name: string, source: ShaderSource): void {
    this.registry.set(name, source);
  }

  /**
   * Get a registered shader source by name.
   */
  getShaderSource(name: string): ShaderSource | null {
    return this.registry.get(name) ?? null;
  }

  /**
   * Check if a shader is registered with hand-written GLSL.
   */
  hasRegistered(name: string): boolean {
    const source = this.registry.get(name);
    return source?.glslVertex !== undefined || source?.glslFragment !== undefined;
  }

  /**
   * Transpile WGSL source to GLSL ES 3.00.
   * If a registered GLSL variant exists for the given name, it is returned directly.
   */
  transpile(wgsl: string, name?: string): TranspileResult {
    this.warnings = [];
    this.errors = [];

    // Check registry first
    if (name) {
      const registered = this.registry.get(name);
      if (registered?.glslVertex && registered?.glslFragment) {
        return {
          vertexShader: registered.glslVertex,
          fragmentShader: registered.glslFragment,
          computeShader: registered.glslCompute ?? null,
          warnings: [],
          errors: [],
        };
      }
    }

    return this.doTranspile(wgsl);
  }

  private doTranspile(wgsl: string): TranspileResult {
    const cleaned = stripComments(wgsl);

    // Parse all components
    const structs = parseStructs(cleaned);
    const bindings = parseGlobalBindings(cleaned);
    const entryPoints = parseEntryPoints(cleaned);
    const regularFuncs = parseRegularFunctions(cleaned);
    const privateVars = parsePrivateVars(cleaned);
    const constants = parseConstants(cleaned);

    // Find vertex and fragment entry points
    const vertexEntry = entryPoints.find((e) => e.stage === "vertex");
    const fragmentEntry = entryPoints.find((e) => e.stage === "fragment");
    const computeEntry = entryPoints.find((e) => e.stage === "compute");

    if (computeEntry) {
      this.warnings.push(
        "Compute shaders are not supported in WebGL2. A CPU fallback is required.",
      );
    }

    // Generate declarations (shared between vertex and fragment)
    const declarations = this.generateDeclarations(structs, bindings, constants, privateVars);

    // Generate regular functions (shared)
    const funcText = this.generateRegularFunctions(regularFuncs, structs);

    // Generate vertex shader
    let vertexShader: string | null = null;
    if (vertexEntry) {
      vertexShader = this.generateVertexShader(
        vertexEntry,
        structs,
        bindings,
        declarations,
        funcText,
      );
    }

    // Generate fragment shader
    let fragmentShader: string | null = null;
    if (fragmentEntry) {
      fragmentShader = this.generateFragmentShader(
        fragmentEntry,
        vertexEntry,
        structs,
        bindings,
        declarations,
        funcText,
      );
    }

    // Generate compute shader (flagged as unsupported)
    let computeShader: string | null = null;
    if (computeEntry) {
      this.errors.push("Compute shaders cannot be transpiled to GLSL ES 3.00.");
    }

    return { vertexShader, fragmentShader, computeShader, warnings: this.warnings, errors: this.errors };
  }

  private generateDeclarations(
    structs: StructInfo[],
    bindings: GlobalBinding[],
    constants: { name: string; value: string }[],
    privateVars: { name: string; type: string }[],
  ): string {
    const lines: string[] = [];

    // Constants
    for (const c of constants) {
      const transformedValue = transformMisc(transformTypes(c.value));
      lines.push(`const ${c.name} = ${transformedValue};`);
    }

    // Structs (non-uniform, used as I/O types)
    for (const struct of structs) {
      // Check if this struct is used as a uniform
      const isUniform = bindings.some(
        (b) => b.kind === "uniform" && b.typeName === struct.name,
      );
      if (!isUniform) {
        lines.push(generateStruct(struct, false));
      }
    }

    // Uniform blocks
    for (const binding of bindings) {
      if (binding.kind === "uniform") {
        const struct = structs.find((s) => s.name === binding.typeName);
        lines.push(generateUniformBlock(binding, struct ?? null));
      } else if (binding.kind === "storage") {
        lines.push(generateStorageBuffer(binding));
        this.warnings.push(
          `Storage buffer '${binding.name}' may not be supported on all WebGL2 devices.`,
        );
      } else if (binding.kind === "texture" || binding.kind === "storage_texture") {
        lines.push(generateTextureDeclaration(binding));
      } else if (binding.kind === "sampler" || binding.kind === "sampler_comparison") {
        lines.push(generateSamplerDeclaration(binding));
      }
    }

    // Private variables
    for (const v of privateVars) {
      lines.push(`${mapType(v.type)} ${v.name};`);
    }

    return lines.join("\n");
  }

  private generateRegularFunctions(
    funcs: { name: string; body: string; fullText: string }[],
    _structs: StructInfo[],
  ): string {
    const lines: string[] = [];
    for (const func of funcs) {
      // Transform the full function text
      let transformed = func.fullText;
      transformed = transformTypes(transformed);
      transformed = transformTextureFunctions(transformed);
      transformed = transformBuiltins(transformed);
      transformed = transformControlFlow(transformed);
      transformed = transformMisc(transformed);
      // Remove WGSL-specific decorators
      transformed = transformed.replace(/@group\(\d+\)/g, "");
      transformed = transformed.replace(/@binding\(\d+\)/g, "");
      transformed = transformed.replace(/@location\(\d+\)/g, "");
      // fn → void or type
      transformed = transformed.replace(/\bfn\b/g, "void");
      lines.push(transformed);
    }
    return lines.join("\n\n");
  }

  private generateVertexShader(
    entry: EntryPoint,
    structs: StructInfo[],
    bindings: GlobalBinding[],
    declarations: string,
    funcText: string,
  ): string {
    const lines: string[] = [GLSL_VERSION, ""];
    lines.push("precision highp float;");
    lines.push("precision highp int;");
    lines.push("");

    // Declarations
    lines.push(declarations);
    lines.push("");

    // Vertex inputs
    if (entry.inputType) {
      const inputDecls = generateVertexInput(entry.inputType, structs);
      if (inputDecls) {
        lines.push(inputDecls);
        lines.push("");
      }
    }

    // Vertex outputs (from the output struct)
    if (entry.outputType) {
      const outputDecls = this.generateVertexOutputs(entry.outputType, structs);
      if (outputDecls) {
        lines.push(outputDecls);
        lines.push("");
      }
    }

    // Regular functions
    if (funcText) {
      lines.push(funcText);
      lines.push("");
    }

    // Main function
    lines.push("void main() {");
    // Transform the body
    let body = entry.body;
    body = transformTypes(body);
    body = transformTextureFunctions(body);
    body = transformBuiltins(body);
    body = transformControlFlow(body);
    body = transformMisc(body);

    // Handle struct I/O flattening and builtin variable replacement
    body = this.flattenStructIO(body, entry, structs, "vertex");

    lines.push(body);
    lines.push("}");

    return lines.join("\n");
  }

  private generateFragmentShader(
    entry: EntryPoint,
    vertexEntry: EntryPoint | undefined,
    structs: StructInfo[],
    bindings: GlobalBinding[],
    declarations: string,
    funcText: string,
  ): string {
    const lines: string[] = [GLSL_VERSION, ""];
    lines.push("precision highp float;");
    lines.push("precision highp int;");
    lines.push("");

    // Declarations
    lines.push(declarations);
    lines.push("");

    // Fragment inputs (must match vertex outputs)
    if (entry.inputType) {
      const inputDecls = generateFragmentInput(entry, structs);
      if (inputDecls) {
        lines.push(inputDecls);
        lines.push("");
      }
    }

    // Fragment outputs
    if (entry.outputType) {
      const outputDecls = generateFragmentOutput(entry, structs);
      if (outputDecls) {
        lines.push(outputDecls);
        lines.push("");
      }
    }

    // Regular functions
    if (funcText) {
      lines.push(funcText);
      lines.push("");
    }

    // Main function
    lines.push("void main() {");
    let body = entry.body;
    body = transformTypes(body);
    body = transformTextureFunctions(body);
    body = transformBuiltins(body);
    body = transformControlFlow(body);
    body = transformMisc(body);

    // Handle struct I/O flattening and builtin variable replacement
    body = this.flattenStructIO(body, entry, structs, "fragment");

    lines.push(body);
    lines.push("}");

    return lines.join("\n");
  }

  // ─── Struct I/O Flattening ───────────────────────────────────────────────

  private flattenStructIO(
    body: string,
    entry: EntryPoint,
    structs: StructInfo[],
    stage: "vertex" | "fragment",
  ): string {
    let result = body;

    // Map of WGSL builtin names to GLSL builtin variables
    const builtinMap: Record<string, string> = {
      position: "gl_Position",
      vertex_index: "gl_VertexID",
      instance_index: "gl_InstanceID",
      frag_depth: "gl_FragDepth",
      front_facing: "gl_FrontFacing",
    };

    // Handle input struct: replace `inputVar.field` with `field` (or GLSL builtin)
    if (entry.inputType) {
      // Check for @builtin in params: @builtin(vertex_index) vi: u32
      const builtinParamMatch = entry.inputType.match(/@builtin\(\s*(\w+)\s*\)\s+(\w+)/);
      if (builtinParamMatch) {
        const builtinName = builtinParamMatch[1];
        const paramName = builtinParamMatch[2];
        const glslBuiltin = builtinMap[builtinName];
        if (glslBuiltin) {
          result = result.replace(new RegExp(`\\b${paramName}\\b`, "g"), glslBuiltin);
        }
      }

      // Check for struct param: input: StructName
      const paramMatch = entry.inputType.match(/(\w+)\s*:\s*(\w+)/);
      if (paramMatch) {
        const inputVarName = paramMatch[1];
        const inputTypeName = paramMatch[2];
        const inputStruct = structs.find((s) => s.name === inputTypeName);
        if (inputStruct) {
          // Replace inputVar.field with field (or GLSL builtin for @builtin fields)
          for (const field of inputStruct.fields) {
            if (field.builtin && builtinMap[field.builtin]) {
              result = result.replace(
                new RegExp(`\\b${inputVarName}\\.${field.name}\\b`, "g"),
                builtinMap[field.builtin],
              );
            }
          }
          // Remove all remaining inputVar. prefixes
          result = result.replace(new RegExp(`\\b${inputVarName}\\.`, "g"), "");
        }
      }
    }

    // Handle output struct
    if (entry.outputType) {
      const structMatch = entry.outputType.match(/^(\w+)$/);
      if (structMatch) {
        const outputStruct = structs.find((s) => s.name === structMatch[1]);
        if (outputStruct) {
          // Find the output variable name (typically "var output: StructName;")
          const outputVarMatch = result.match(/\b\w+\s+(\w+)\s*;/);
          // Also try the original WGSL pattern: var output: StructName;
          const wgslVarMatch = body.match(/var\s+(\w+)\s*:/);
          const outputVarName = wgslVarMatch?.[1] ?? outputVarMatch?.[1];
          if (outputVarName) {
            // Replace outputVar.field with field (or GLSL builtin for @builtin fields)
            for (const field of outputStruct.fields) {
              if (field.builtin && builtinMap[field.builtin]) {
                result = result.replace(
                  new RegExp(`\\b${outputVarName}\\.${field.name}\\b`, "g"),
                  builtinMap[field.builtin],
                );
              }
            }
            // Remove all remaining outputVar. prefixes
            result = result.replace(new RegExp(`\\b${outputVarName}\\.`, "g"), "");
            // Remove the struct declaration: "Type outputVarName;" or "outputVarName StructName;"
            result = result.replace(new RegExp(`^\\s*\\w+\\s+${outputVarName}\\s*;\\s*$`, "gm"), "");
          }
          // Remove "return outputVarName;" — in GLSL main() outputs are via out variables
          if (outputVarName) {
            result = result.replace(new RegExp(`return\\s+${outputVarName}\\s*;`, "g"), "");
          }
        }
      }

      // Handle tuple return: (@builtin(position) vec4<f32>, @location(0) vec2<f32>)
      if (entry.outputType.startsWith("(")) {
        const parts = splitFields(entry.outputType.slice(1, -1));
        for (const part of parts) {
          const trimmed = part.trim();
          const builtinMatch = trimmed.match(/@builtin\(\s*(\w+)\s*\)/);
          if (builtinMatch && builtinMap[builtinMatch[1]]) {
            // Replace return value position with gl_Position assignment
            // This is complex — for now, just handle the common case
          }
        }
      }

      // Handle struct constructor return: return StructName(...)
      const structCtorMatch = entry.outputType.match(/^(\w+)$/);
      if (structCtorMatch) {
        const structName = structCtorMatch[1];
        // return StructName(vec4(...)) → fragColor0 = vec4(...);
        result = result.replace(
          new RegExp(`return\\s+${structName}\\s*\\(`, "g"),
          "fragColor0 = (",
        );
        // Remove trailing return; that might be left
        result = result.replace(/return\s*;/g, "");
      }
    }

    return result;
  }

  private generateVertexOutputs(outputType: string, structs: StructInfo[]): string {
    // Struct output
    const structMatch = outputType.match(/^(\w+)$/);
    if (structMatch) {
      const struct = structs.find((s) => s.name === structMatch[1]);
      if (struct) {
        return struct.fields
          .map((f, i) => {
            if (f.name === "clipPosition" || f.name === "clipPos") return null; // gl_Position
            return `layout(location = ${i}) out ${f.type} ${f.name};`;
          })
          .filter(Boolean)
          .join("\n");
      }
    }

    // Tuple return: (@builtin(position) vec4<f32>, @location(0) vec2<f32>)
    if (outputType.startsWith("(")) {
      const parts = splitFields(outputType.slice(1, -1));
      const lines: string[] = [];
      for (const part of parts) {
        const trimmed = part.trim();
        const locMatch = trimmed.match(/@location\((\d+)\)\s*(\S+)/);
        if (locMatch) {
          lines.push(`layout(location = ${locMatch[1]}) out ${mapType(locMatch[2])} ${locMatch[2].replace(/[<>]/g, "")}_${locMatch[1]};`);
        }
      }
      return lines.join("\n");
    }

    return "";
  }
}
