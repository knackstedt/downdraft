import { getChunk } from "./chunks";
import type { GraphNode, MaterialGraph } from "./graph";
import type { BindGroupEntry, ShaderGraphProfile } from "./profiles";
import { SIMPLE_PROFILE } from "./profiles";

interface Connection {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

// Node generators produce WGSL expressions from inputs.
// ctx provides profile info for context-aware generation.
interface NodeContext {
  profile: ShaderGraphProfile;
  uniformVar: string;
}

type NodeGenerator = (node: GraphNode, inputs: string[], ctx: NodeContext) => string;

const NODE_WGSL: Record<string, NodeGenerator> = {
  // --- Constants ---
  constant: (node) => {
    const v = node.properties.value ?? 0;
    return `f32(${v})`;
  },
  vec3_constant: (node) => {
    const v = node.properties.value ?? [0, 0, 0];
    const arr = Array.isArray(v) ? v : [0, 0, 0];
    return `vec3<f32>(${arr[0]}, ${arr[1]}, ${arr[2]})`;
  },
  vec4_constant: (node) => {
    const v = node.properties.value ?? [0, 0, 0, 1];
    const arr = Array.isArray(v) ? v : [0, 0, 0, 1];
    return `vec4<f32>(${arr[0]}, ${arr[1]}, ${arr[2]}, ${arr[3]})`;
  },

  // --- Built-in inputs ---
  uv: () => "input.uv",
  normal: () => "input.worldNormal",
  world_pos: () => "input.worldPos",
  camera_pos: (_n, _i, ctx) => `${ctx.uniformVar}.cameraPos`,
  time: (_n, _i, ctx) => `${ctx.uniformVar}.time`,
  vertex_color: () => "input.color",
  entity_type: (_n, _i, ctx) => `${ctx.uniformVar}.entityType`,
  entity_flags: (_n, _i, ctx) => `${ctx.uniformVar}.entityFlags`,

  // --- Texture sampling ---
  texture_sample: (_node, inputs) => {
    const uv = inputs[0] ?? "input.uv";
    return `textureSample(albedoMap, albedoSampler, ${uv})`;
  },

  // --- Math ops ---
  multiply: (_n, inputs) => `(${inputs[0] ?? "vec4<f32>(1.0)"} * ${inputs[1] ?? "vec4<f32>(1.0)"})`,
  add: (_n, inputs) => `(${inputs[0] ?? "vec4<f32>(0.0)"} + ${inputs[1] ?? "vec4<f32>(0.0)"})`,
  subtract: (_n, inputs) => `(${inputs[0] ?? "vec4<f32>(0.0)"} - ${inputs[1] ?? "vec4<f32>(0.0)"})`,
  lerp: (_n, inputs) => `mix(${inputs[0] ?? "vec4<f32>(0.0)"}, ${inputs[1] ?? "vec4<f32>(1.0)"}, ${inputs[2] ?? "0.0"})`,
  normalize: (_n, inputs) => `normalize(${inputs[0] ?? "vec3<f32>(0.0, 1.0, 0.0)"})`,
  dot: (_n, inputs) => `dot(${inputs[0] ?? "vec3<f32>(0.0)"}, ${inputs[1] ?? "vec3<f32>(0.0)"})`,
  cross: (_n, inputs) => `cross(${inputs[0] ?? "vec3<f32>(1.0, 0.0, 0.0)"}, ${inputs[1] ?? "vec3<f32>(0.0, 1.0, 0.0)"})`,
  power: (_n, inputs) => `pow(${inputs[0] ?? "1.0"}, ${inputs[1] ?? "1.0"})`,
  saturate: (_n, inputs) => `clamp(${inputs[0] ?? "0.0"}, 0.0, 1.0)`,
  max: (_n, inputs) => `max(${inputs[0] ?? "0.0"}, ${inputs[1] ?? "0.0"})`,
  min: (_n, inputs) => `min(${inputs[0] ?? "0.0"}, ${inputs[1] ?? "0.0"})`,
  abs: (_n, inputs) => `abs(${inputs[0] ?? "0.0"})`,
  sin: (_n, inputs) => `sin(${inputs[0] ?? "0.0"})`,
  cos: (_n, inputs) => `cos(${inputs[0] ?? "0.0"})`,
  fract: (_n, inputs) => `fract(${inputs[0] ?? "0.0"})`,
  floor: (_n, inputs) => `floor(${inputs[0] ?? "0.0"})`,
  smoothstep: (_n, inputs) => `smoothstep(${inputs[0] ?? "0.0"}, ${inputs[1] ?? "1.0"}, ${inputs[2] ?? "0.0"})`,
  mix3: (_n, inputs) => `mix(${inputs[0] ?? "vec3<f32>(0.0)"}, ${inputs[1] ?? "vec3<f32>(1.0)"}, ${inputs[2] ?? "0.5"})`,
  swizzle_xyz: (_n, inputs) => `(${inputs[0] ?? "vec4<f32>(0.0)"}).xyz`,
  swizzle_rgb: (_n, inputs) => `(${inputs[0] ?? "vec4<f32>(0.0)"}).rgb`,
  vec3_from_xy: (_n, inputs) => `vec3<f32>(${inputs[0] ?? "0.0"}, ${inputs[1] ?? "0.0"}, ${inputs[2] ?? "0.0"})`,
  vec4_from_xyzw: (_n, inputs) => `vec4<f32>(${inputs[0] ?? "0.0"}, ${inputs[1] ?? "0.0"}, ${inputs[2] ?? "0.0"}, ${inputs[3] ?? "1.0"})`,

  // --- PBR nodes ---
  pbr_lighting: (_n, inputs, ctx) => {
    const N = inputs[0] ?? "input.worldNormal";
    const worldPos = inputs[1] ?? "input.worldPos";
    const baseColor = inputs[2] ?? "vec3<f32>(1.0)";
    const metallic = inputs[3] ?? "0.0";
    const roughness = inputs[4] ?? "0.5";
    const u = ctx.uniformVar;
    return `pbrLighting(${N}, ${worldPos}, ${baseColor}, ${metallic}, ${roughness}, ${u}.sunDirIntensity, ${u}.ambientParams, ${u}.fogColor, ${u}.cameraPos, ${u}.time, ${u}.entityFlags)`;
  },
  pbr_params: (_n, _i, ctx) => {
    const u = ctx.uniformVar;
    return `getPBRParams(${u}.entityType)`;
  },
  metallic_roughness: (node) => {
    const m = node.properties.metallic ?? 0.0;
    const r = node.properties.roughness ?? 0.5;
    return `vec2<f32>(${m}, ${r})`;
  },

  // --- Dynamic lights (non-PBR) ---
  dynamic_lights: (_n, inputs, ctx) => {
    const N = inputs[0] ?? "input.worldNormal";
    const worldPos = inputs[1] ?? "input.worldPos";
    const viewDir = inputs[2] ?? `normalize(${ctx.uniformVar}.cameraPos - input.worldPos)`;
    const specPower = inputs[3] ?? "32.0";
    const specIntensity = inputs[4] ?? "1.0";
    return `applyDynamicLights(${N}, ${worldPos}, ${viewDir}, ${specPower}, ${specIntensity})`;
  },

  // --- Fog ---
  fog: (_n, inputs, ctx) => {
    const color = inputs[0] ?? `${ctx.uniformVar}.fogColor.xyz`;
    const dist = inputs[1] ?? `length(${ctx.uniformVar}.cameraPos - input.worldPos)`;
    return `mix(${inputs[2] ?? "vec3<f32>(1.0)"}, ${color}, min(${dist} / 1000.0, 1.0))`;
  },

  // --- Noise ---
  value_noise: (_n, inputs) => `valueNoise3D(${inputs[0] ?? "vec3<f32>(0.0)"})`,
  fbm: (_n, inputs) => {
    const p = inputs[0] ?? "vec3<f32>(0.0)";
    const octaves = inputs[1] ?? "4u";
    return `fbm3D(${p}, ${octaves})`;
  },
  fbm_warp: (_n, inputs) => {
    const p = inputs[0] ?? "vec3<f32>(0.0)";
    const octaves = inputs[1] ?? "4u";
    const warpScale = inputs[2] ?? "8.0";
    const warpStrength = inputs[3] ?? "2.0";
    return `fbm3DWarp(${p}, ${octaves}, ${warpScale}, ${warpStrength})`;
  },

  // --- Sand sparkle (island-specific) ---
  sand_sparkle: (_n, inputs) => {
    const worldPos = inputs[0] ?? "input.worldPos";
    const N = inputs[1] ?? "input.worldNormal";
    const V = inputs[2] ?? "normalize(uniforms.cameraPos - input.worldPos)";
    const L = inputs[3] ?? "normalize(uniforms.sunDirIntensity.xyz)";
    const sandMask = inputs[4] ?? "1.0";
    return `sandSparkle(${worldPos}, ${N}, ${V}, ${L}, ${sandMask})`;
  },
};

export interface CompileResult {
  wgsl: string;
  errors: string[];
}

export interface CompileOptions {
  profile?: ShaderGraphProfile;
}

export class GraphCompiler {
  compile(graph: MaterialGraph, options?: CompileOptions): string {
    return this.compileDetailed(graph, options).wgsl;
  }

  compileDetailed(graph: MaterialGraph, options?: CompileOptions): CompileResult {
    const profile = options?.profile ?? SIMPLE_PROFILE;
    const errors: string[] = [];
    const nodes = graph.getNodes();
    const connections = graph.getConnections();

    const nodeMap = new Map<string, GraphNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const inputConnections = new Map<string, Map<string, Connection>>();
    for (const conn of connections) {
      if (!inputConnections.has(conn.to)) inputConnections.set(conn.to, new Map());
      inputConnections.get(conn.to)!.set(conn.toPort, conn);
    }

    const outputNodes = nodes.filter((n) => n.type === "output");
    if (outputNodes.length === 0) {
      errors.push("No output node found in graph");
      return { wgsl: this.fallbackShader(profile), errors };
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const expressions: string[] = [];
    const ctx: NodeContext = { profile, uniformVar: "uniforms" };

    const compileNode = (nodeId: string): string => {
      if (visited.has(nodeId)) {
        return `var_${nodeId}`;
      }
      if (visiting.has(nodeId)) {
        errors.push(`Cycle detected at node: ${nodeId}`);
        return "vec4<f32>(1.0, 0.0, 1.0, 1.0)";
      }
      visiting.add(nodeId);

      const node = nodeMap.get(nodeId);
      if (!node) {
        errors.push(`Unknown node: ${nodeId}`);
        return "vec4<f32>(1.0)";
      }

      const portOrder = this.getPortOrder(node);
      const inputExprs: string[] = portOrder.map((portName) => {
        const conns = inputConnections.get(nodeId);
        const conn = conns?.get(portName);
        if (conn) return compileNode(conn.from);
        return this.defaultInput(portName, node);
      });

      visiting.delete(nodeId);
      visited.add(nodeId);

      const generator = NODE_WGSL[node.type];
      if (!generator) {
        if (node.type === "input") return inputExprs[0] ?? "vec4<f32>(1.0)";
        if (node.type === "output") {
          const expr = inputExprs[0] ?? "vec4<f32>(1.0)";
          expressions.push(expr);
          return expr;
        }
        errors.push(`Unknown node type: ${node.type}`);
        return "vec4<f32>(1.0)";
      }

      return generator(node, inputExprs, ctx);
    };

    for (const outNode of outputNodes) {
      compileNode(outNode.id);
    }

    if (expressions.length === 0) {
      expressions.push("vec4<f32>(1.0)");
    }

    const fragmentExpr = expressions[0];
    const wgsl = this.buildShader(fragmentExpr, profile);
    return { wgsl, errors };
  }

  private getPortOrder(node: GraphNode): string[] {
    const known: Record<string, string[]> = {
      texture_sample: ["uv"],
      multiply: ["a", "b"],
      add: ["a", "b"],
      subtract: ["a", "b"],
      lerp: ["a", "b", "t"],
      normalize: ["v"],
      dot: ["a", "b"],
      cross: ["a", "b"],
      power: ["base", "exp"],
      saturate: ["v"],
      max: ["a", "b"],
      min: ["a", "b"],
      abs: ["v"],
      sin: ["v"],
      cos: ["v"],
      fract: ["v"],
      floor: ["v"],
      smoothstep: ["edge0", "edge1", "x"],
      mix3: ["a", "b", "t"],
      swizzle_xyz: ["v"],
      swizzle_rgb: ["v"],
      vec3_from_xy: ["x", "y", "z"],
      vec4_from_xyzw: ["x", "y", "z", "w"],
      pbr_lighting: ["N", "worldPos", "baseColor", "metallic", "roughness"],
      pbr_params: [],
      metallic_roughness: [],
      dynamic_lights: ["N", "worldPos", "viewDir", "specPower", "specIntensity"],
      fog: ["color", "dist", "source"],
      value_noise: ["p"],
      fbm: ["p", "octaves"],
      fbm_warp: ["p", "octaves", "warpScale", "warpStrength"],
      sand_sparkle: ["worldPos", "N", "V", "L", "sandMask"],
      output: ["value"],
      input: ["value"],
    };
    return known[node.type] ?? [];
  }

  private defaultInput(portName: string, _node: GraphNode): string {
    const defaults: Record<string, string> = {
      uv: "input.uv",
      a: "vec4<f32>(1.0)",
      b: "vec4<f32>(1.0)",
      t: "0.5",
      v: "vec3<f32>(0.0, 1.0, 0.0)",
      base: "1.0",
      exp: "1.0",
      value: "vec4<f32>(1.0)",
      N: "input.worldNormal",
      worldPos: "input.worldPos",
      baseColor: "vec3<f32>(1.0)",
      metallic: "0.0",
      roughness: "0.5",
      viewDir: "normalize(uniforms.cameraPos - input.worldPos)",
      specPower: "32.0",
      specIntensity: "1.0",
      color: "uniforms.fogColor.xyz",
      dist: "length(uniforms.cameraPos - input.worldPos)",
      source: "vec3<f32>(1.0)",
      p: "vec3<f32>(0.0)",
      octaves: "4u",
      warpScale: "8.0",
      warpStrength: "2.0",
      edge0: "0.0",
      edge1: "1.0",
      x: "0.0",
      y: "0.0",
      z: "0.0",
      w: "1.0",
      sandMask: "1.0",
      L: "normalize(uniforms.sunDirIntensity.xyz)",
    };
    return defaults[portName] ?? "vec4<f32>(1.0)";
  }

  private buildShader(fragmentExpr: string, profile: ShaderGraphProfile): string {
    const chunks = profile.chunks.map((c) => getChunk(c)).filter((c) => c.length > 0).join("\n\n");
    const uniformStruct = this.buildUniformStruct(profile);
    const bindGroupDecls = this.buildBindGroupDecls(profile);
    const vertexInput = this.buildVertexInput(profile);
    const vertexOutput = this.buildVertexOutput(profile);
    const vertexMain = this.buildVertexMain(profile);
    const preMain = profile.preMain ?? "";

    return `// Auto-generated WGSL from material graph (profile: ${profile.name})
${chunks}

${uniformStruct}

${bindGroupDecls}

${vertexInput}

${vertexOutput}

${preMain}

${vertexMain}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return ${fragmentExpr};
}`;
  }

  private buildUniformStruct(profile: ShaderGraphProfile): string {
    const fields = profile.uniformFields.map((f) => `  ${f.name}: ${f.type},`).join("\n");
    return `struct Uniforms {
${fields}
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;`;
  }

  private buildBindGroupDecls(profile: ShaderGraphProfile): string {
    const lines: string[] = [];
    for (const bg of profile.bindGroups) {
      for (const entry of bg.entries) {
        if (entry.binding === 0 && bg.group === 0) continue; // Already declared in uniform struct
        const label = entry.label ?? `binding_${entry.binding}`;
        const visStr = this.visibilityStr(entry);
        switch (entry.type) {
          case "uniform":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var<uniform> ${label}: Uniforms;`);
            break;
          case "storage-read":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var<storage, read> ${label}: array<vec4<f32>>;`);
            break;
          case "storage-write":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var<storage, read_write> ${label}: array<vec4<f32>>;`);
            break;
          case "texture-2d":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var ${label}: texture_2d<f32>;`);
            break;
          case "texture-cube":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var ${label}: texture_cube<f32>;`);
            break;
          case "sampler":
            lines.push(`@group(${bg.group}) @binding(${entry.binding}) ${visStr} var ${label}: sampler;`);
            break;
        }
      }
    }
    return lines.join("\n");
  }

  private visibilityStr(_entry: BindGroupEntry): string {
    // WGSL doesn't use visibility annotations on var declarations
    return "";
  }

  private buildVertexInput(profile: ShaderGraphProfile): string {
    const attrs = profile.vertexLayout.attributes.map((a) => {
      const wgslType = this.vertexFormatToWGSL(a.format);
      return `  @location(${a.location}) ${a.name}: ${wgslType},`;
    }).join("\n");

    if (profile.instanced) {
      return `struct InstanceData {
  pos: vec3<f32>,
  scale: f32,
  rot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,
  _pad: vec2<f32>,
};

@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;

struct VertexInput {
${attrs}
};`;
    }

    if (profile.skinned) {
      const maxBones = profile.maxBones ?? 256;
      return `@group(0) @binding(3) var<storage, read> boneMatrices: array<mat4x4<f32>, ${maxBones}>;

struct VertexInput {
${attrs}
};`;
    }

    return `struct VertexInput {
${attrs}
};`;
  }

  private buildVertexOutput(profile: ShaderGraphProfile): string {
    const hasUV = profile.vertexLayout.attributes.some((a) => a.name === "uv");
    const hasColor = profile.vertexLayout.attributes.some((a) => a.name === "color");

    const lines: string[] = [
      "  @builtin(position) clipPos: vec4<f32>,",
      "  @location(0) worldPos: vec3<f32>,",
      "  @location(1) worldNormal: vec3<f32>,",
    ];
    let loc = 2;
    if (hasUV) {
      lines.push(`  @location(${loc}) uv: vec2<f32>,`);
      loc++;
    }
    if (hasColor) {
      lines.push(`  @location(${loc}) color: vec3<f32>,`);
      loc++;
    }
    if (profile.instanced) {
      lines.push(`  @location(${loc}) @interpolate(flat) entityType: u32,`);
      loc++;
      lines.push(`  @location(${loc}) @interpolate(flat) entityFlags: u32,`);
    }

    return `struct VertexOutput {
${lines.join("\n")}
};`;
  }

  private buildVertexMain(profile: ShaderGraphProfile): string {
    const hasUV = profile.vertexLayout.attributes.some((a) => a.name === "uv");
    const hasColor = profile.vertexLayout.attributes.some((a) => a.name === "color");

    if (profile.instanced) {
      return this.buildInstancedVertexMain(profile, hasUV, hasColor);
    }
    if (profile.skinned) {
      return this.buildSkinnedVertexMain(profile, hasUV, hasColor);
    }
    return this.buildStandardVertexMain(profile, hasUV, hasColor);
  }

  private buildStandardVertexMain(profile: ShaderGraphProfile, hasUV: boolean, hasColor: boolean): string {
    const hasModelMatrix = profile.uniformFields.some((f) => f.name === "modelMatrix");
    const hasEntityTransform = profile.uniformFields.some((f) => f.name === "entityPos");

    let transformCode: string;
    if (hasEntityTransform) {
      transformCode = `
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldNormal = normalize(qrotate(uniforms.entityRot, input.normal));`;
    } else if (hasModelMatrix) {
      transformCode = `
  let worldPos = (uniforms.modelMatrix * vec4<f32>(input.position, 1.0)).xyz;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldNormal = normalize((uniforms.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz);`;
    } else {
      transformCode = `
  output.worldPos = input.position;
  output.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  output.worldNormal = input.normal;`;
    }

    const passThrough: string[] = [];
    if (hasUV) passThrough.push("  output.uv = input.uv;");
    if (hasColor) passThrough.push("  output.color = input.color;");

    return `@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;${transformCode}
${passThrough.join("\n")}
  return output;
}`;
  }

  private buildSkinnedVertexMain(profile: ShaderGraphProfile, hasUV: boolean, hasColor: boolean): string {
    const passThrough: string[] = [];
    if (hasUV) passThrough.push("  output.uv = input.uv;");
    if (hasColor) passThrough.push("  output.color = input.color;");

    return `@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let skinMat =
    boneMatrices[input.joints.x] * input.weights.x +
    boneMatrices[input.joints.y] * input.weights.y +
    boneMatrices[input.joints.z] * input.weights.z +
    boneMatrices[input.joints.w] * input.weights.w;

  let skinnedPos = (skinMat * vec4<f32>(input.position, 1.0)).xyz;
  let skinnedNormal = mat3x3<f32>(
    skinMat[0].xyz,
    skinMat[1].xyz,
    skinMat[2].xyz,
  ) * input.normal;

  let scaled = skinnedPos * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldNormal = normalize(qrotate(uniforms.entityRot, normalize(skinnedNormal)));
${passThrough.join("\n")}
  return output;
}`;
  }

  private buildInstancedVertexMain(profile: ShaderGraphProfile, hasUV: boolean, hasColor: boolean): string {
    const passThrough: string[] = [];
    if (hasUV) passThrough.push("  output.uv = input.uv;");
    if (hasColor) passThrough.push("  output.color = input.color;");

    return `@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instIdx: u32) -> VertexOutput {
  var output: VertexOutput;
  let inst = instances[instIdx];
  let scaled = input.position * inst.scale;
  let rotated = qrotate(inst.rot, scaled);
  let worldPos = rotated + inst.pos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.worldNormal = normalize(qrotate(inst.rot, input.normal));
${passThrough.join("\n")}
  output.entityType = inst.entityType;
  output.entityFlags = inst.entityFlags;
  return output;
}`;
  }

  private vertexFormatToWGSL(format: string): string {
    switch (format) {
      case "float32x3": return "vec3<f32>";
      case "float32x2": return "vec2<f32>";
      case "float32x4": return "vec4<f32>";
      case "uint32x4": return "vec4<u32>";
      default: return "vec3<f32>";
    }
  }

  private fallbackShader(profile: ShaderGraphProfile): string {
    return this.buildShader("vec4<f32>(1.0, 0.0, 1.0, 1.0)", profile);
  }
}
