// ============================================================================
// ComputeGraphCompiler — compiles a ComputeGraph to WGSL @compute shader
// Mirrors GraphCompiler but emits compute-specific constructs: storage/uniform
// buffer declarations, @compute @workgroup_size entry point, buffer_store
// output nodes, atomic operations, workgroup shared memory, and barriers.
// ============================================================================

import { getChunk } from "./chunks";
import type { ComputeGraph, StructField } from "./compute-graph";
import type { ComputeProfile } from "./compute-profiles";
import type { GraphNode } from "./graph";

interface Connection {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

interface NodeContext {
  profile: ComputeProfile;
}

type ComputeNodeGenerator = (node: GraphNode, inputs: string[], ctx: NodeContext) => string;

// ── Compute-specific node generators ────────────────────────────────────────
// Math nodes (multiply, add, sin, etc.) are shared with the material compiler
// since they produce the same WGSL expressions. Compute-specific nodes handle
// built-ins, buffer I/O, atomics, and synchronization.
const COMPUTE_NODE_WGSL: Record<string, ComputeNodeGenerator> = {
  // --- Constants ---
  constant: (node) => {
    const v = node.properties.value ?? 0;
    return `f32(${v})`;
  },
  u32_constant: (node) => {
    const v = node.properties.value ?? 0;
    return `u32(${v})u`;
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

  // --- Compute built-in inputs ---
  global_id: (node) => {
    const comp = node.properties.component ?? "x";
    return `gid.${comp}`;
  },
  global_id_vec: () => "gid",
  local_id: (node) => {
    const comp = node.properties.component ?? "x";
    return `lid.${comp}`;
  },
  local_id_vec: () => "lid",
  workgroup_id: (node) => {
    const comp = node.properties.component ?? "x";
    return `wid.${comp}`;
  },
  num_workgroups: (node) => {
    const comp = node.properties.component ?? "x";
    return `numWorkgroups.${comp}`;
  },

  // --- Buffer I/O ---
  buffer_load: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    return `${bufferName}[${idx}].${field}`;
  },
  buffer_store: (_node, inputs) => {
    // Output node — handled specially in compile loop (returns the store statement)
    // The generator returns the value expression; the compile loop wraps it in a store.
    return inputs[0] ?? "vec4<f32>(0.0)";
  },
  buffer_load_element: (node, inputs) => {
    // Direct array element access (no struct field)
    const bufferName = node.properties.buffer ?? "buffer0";
    const idx = inputs[0] ?? "0u";
    return `${bufferName}[${idx}]`;
  },

  // --- Atomics ---
  atomic_add: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    const value = inputs[1] ?? "1u";
    return `atomicAdd(&${bufferName}[${idx}].${field}, ${value})`;
  },
  atomic_sub: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    const value = inputs[1] ?? "1u";
    return `atomicSub(&${bufferName}[${idx}].${field}, ${value})`;
  },
  atomic_min: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    const value = inputs[1] ?? "0u";
    return `atomicMin(&${bufferName}[${idx}].${field}, ${value})`;
  },
  atomic_max: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    const value = inputs[1] ?? "0u";
    return `atomicMax(&${bufferName}[${idx}].${field}, ${value})`;
  },
  atomic_exchange: (node, inputs) => {
    const bufferName = node.properties.buffer ?? "buffer0";
    const field = node.properties.field ?? "value";
    const idx = inputs[0] ?? "0u";
    const value = inputs[1] ?? "0u";
    return `atomicExchange(&${bufferName}[${idx}].${field}, ${value})`;
  },

  // --- Barriers ---
  workgroup_barrier: () => "workgroupBarrier()",
  storage_barrier: () => "storageBarrier()",
  all_barrier: () => "workgroupBarrier(); storageBarrier()",

  // --- Math ops (shared with material compiler — same WGSL) ---
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
  length: (_n, inputs) => `length(${inputs[0] ?? "vec3<f32>(0.0)"})`,
  exp: (_n, inputs) => `exp(${inputs[0] ?? "0.0"})`,

  // --- Noise (shared) ---
  value_noise: (_n, inputs) => `valueNoise3D(${inputs[0] ?? "vec3<f32>(0.0)"})`,
  fbm: (_n, inputs) => {
    const p = inputs[0] ?? "vec3<f32>(0.0)";
    const octaves = inputs[1] ?? "4u";
    return `fbm3D(${p}, ${octaves})`;
  },

  // --- Input/Output pass-through (for graph connectivity) ---
  input: (_n, inputs) => inputs[0] ?? "vec4<f32>(0.0)",
};

export interface ComputeCompileResult {
  wgsl: string;
  errors: string[];
}

export interface ComputeCompileOptions {
  profile?: ComputeProfile;
}

export class ComputeGraphCompiler {
  compile(graph: ComputeGraph, options?: ComputeCompileOptions): string {
    return this.compileDetailed(graph, options).wgsl;
  }

  compileDetailed(graph: ComputeGraph, options?: ComputeCompileOptions): ComputeCompileResult {
    const profile = options?.profile;
    const errors: string[] = [];
    const nodes = graph.getNodes();
    const connections = graph.getConnections();

    const nodeMap = new Map<string, GraphNode>();
    nodes.forEach((n) => { nodeMap.set(n.id, n);; });

    const inputConnections = new Map<string, Map<string, Connection>>();
    connections.forEach((conn) => {
      if (!inputConnections.has(conn.to)) inputConnections.set(conn.to, new Map());
      inputConnections.get(conn.to)!.set(conn.toPort, conn);
    });

    // Output nodes are buffer_store nodes — they produce side-effect writes.
    const outputNodes = nodes.filter((n) => n.type === "buffer_store");
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const statements: string[] = [];
    const ctx: NodeContext = { profile: profile ?? { name: "default", chunks: [], workgroupSize: [64, 1, 1] } };

    const compileNode = (nodeId: string): string => {
      if (visited.has(nodeId)) return `var_${nodeId}`;
      if (visiting.has(nodeId)) {
        errors.push(`Cycle detected at node: ${nodeId}`);
        return "vec4<f32>(1.0, 0.0, 1.0, 1.0)";
      }
      visiting.add(nodeId);

      const node = nodeMap.get(nodeId);
      if (!node) {
        errors.push(`Unknown node: ${nodeId}`);
        return "vec4<f32>(0.0)";
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

      // buffer_store is an output node — emit a store statement.
      if (node.type === "buffer_store") {
        const bufferName = node.properties.buffer ?? "buffer0";
        const field = node.properties.field ?? "value";
        const idx = inputExprs[0] ?? "0u";
        const value = inputExprs[1] ?? "vec4<f32>(0.0)";
        statements.push(`${bufferName}[${idx}].${field} = ${value};`);
        return value;
      }

      const generator = COMPUTE_NODE_WGSL[node.type];
      if (!generator) {
        if (node.type === "input") return inputExprs[0] ?? "vec4<f32>(0.0)";
        if (node.type === "output") {
          const expr = inputExprs[0] ?? "vec4<f32>(0.0)";
          statements.push(`// output: ${expr}`);
          return expr;
        }
        errors.push(`Unknown node type: ${node.type}`);
        return "vec4<f32>(0.0)";
      }

      const expr = generator(node, inputExprs, ctx);

      // Barrier and atomic nodes produce side-effect statements, not just expressions.
      const sideEffectTypes = [
        "workgroup_barrier", "storage_barrier", "all_barrier",
        "atomic_add", "atomic_sub", "atomic_min", "atomic_max", "atomic_exchange",
      ];
      if (sideEffectTypes.includes(node.type)) {
        statements.push(`${expr};`);
      }

      return expr;
    };

    outputNodes.forEach((outNode) => {
      compileNode(outNode.id);
    });

    // Also compile any standalone side-effect nodes (barriers, atomics) not
    // connected to a buffer_store output.
    nodes.forEach((node) => {
      const sideEffectTypes = [
        "workgroup_barrier", "storage_barrier", "all_barrier",
        "atomic_add", "atomic_sub", "atomic_min", "atomic_max", "atomic_exchange",
      ];
      if (sideEffectTypes.includes(node.type) && !visited.has(node.id)) {
        compileNode(node.id);
      }
    });

    const wgsl = this.buildComputeShader(graph, profile, statements, errors);
    return { wgsl, errors };
  }

  private getPortOrder(node: GraphNode): string[] {
    const known: Record<string, string[]> = {
      buffer_load: ["index"],
      buffer_load_element: ["index"],
      buffer_store: ["index", "value"],
      atomic_add: ["index", "value"],
      atomic_sub: ["index", "value"],
      atomic_min: ["index", "value"],
      atomic_max: ["index", "value"],
      atomic_exchange: ["index", "value"],
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
      length: ["v"],
      exp: ["v"],
      value_noise: ["p"],
      fbm: ["p", "octaves"],
      input: ["value"],
      output: ["value"],
    };
    return known[node.type] ?? [];
  }

  private defaultInput(portName: string, _node: GraphNode): string {
    const defaults: Record<string, string> = {
      index: "0u",
      value: "vec4<f32>(0.0)",
      a: "vec4<f32>(1.0)",
      b: "vec4<f32>(1.0)",
      t: "0.5",
      v: "vec3<f32>(0.0, 1.0, 0.0)",
      base: "1.0",
      exp: "1.0",
      p: "vec3<f32>(0.0)",
      octaves: "4u",
      edge0: "0.0",
      edge1: "1.0",
      x: "0.0",
      y: "0.0",
      z: "0.0",
      w: "1.0",
    };
    return defaults[portName] ?? "vec4<f32>(0.0)";
  }

  private buildComputeShader(
    graph: ComputeGraph,
    profile: ComputeProfile | undefined,
    statements: string[],
    errors: string[],
  ): string {
    const chunks = (profile?.chunks ?? []).map((c) => getChunk(c)).filter((c) => c.length > 0).join("\n\n");
    const structDecls = this.buildStructDeclarations(graph);
    const bufferDecls = this.buildBufferDeclarations(graph);
    const sharedVarDecls = this.buildSharedVarDeclarations(graph);
    const workgroupSize = profile?.workgroupSize ?? graph.getDispatchConfig().workgroupSize;
    const entryPoint = graph.getEntryPoint();
    const body = statements.length > 0 ? statements.join("\n  ") : "// no buffer stores in graph";

    const errorComments = errors.length > 0
      ? `\n// COMPILATION ERRORS:\n// ${errors.join("\n// ")}\n`
      : "";

    return `// Auto-generated WGSL from compute graph${profile ? ` (profile: ${profile.name})` : ""}
${errorComments}
${chunks}

${structDecls}

${bufferDecls}

${sharedVarDecls}

@compute @workgroup_size(${workgroupSize[0]}, ${workgroupSize[1]}, ${workgroupSize[2]})
fn ${entryPoint}(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  ${body}
}`;
  }

  private buildStructDeclarations(graph: ComputeGraph): string {
    const decls: string[] = [];
    const seen = new Set<string>();

    for (const sb of graph.getStorageBuffers()) {
      if (seen.has(sb.structName)) continue;
      seen.add(sb.structName);
      decls.push(this.buildStruct(sb.structName, sb.structFields));
    }

    for (const ub of graph.getUniformBuffers()) {
      if (seen.has(ub.structName)) continue;
      seen.add(ub.structName);
      decls.push(this.buildStruct(ub.structName, ub.structFields));
    }

    return decls.join("\n\n");
  }

  private buildStruct(name: string, fields: StructField[]): string {
    const fieldLines = fields.map((f) => `  ${f.name}: ${f.type},`).join("\n");
    return `struct ${name} {
${fieldLines}
};`;
  }

  private buildBufferDeclarations(graph: ComputeGraph): string {
    const lines: string[] = [];

    for (const sb of graph.getStorageBuffers()) {
      const accessStr = sb.access === "read" ? "read" : sb.access === "write" ? "write" : "read_write";
      const arrayType = sb.elementCount !== undefined
        ? `array<${sb.structName}, ${sb.elementCount}>`
        : `array<${sb.structName}>`;
      lines.push(
        `@group(${sb.group}) @binding(${sb.binding}) var<storage, ${accessStr}> ${sb.name}: ${arrayType};`,
      );
    }

    for (const ub of graph.getUniformBuffers()) {
      lines.push(
        `@group(${ub.group}) @binding(${ub.binding}) var<uniform> ${ub.name}: ${ub.structName};`,
      );
    }

    return lines.join("\n");
  }

  private buildSharedVarDeclarations(graph: ComputeGraph): string {
    // Workgroup shared memory declarations from node properties.
    // Nodes of type "shared_var" are not in the generator (they're declarations,
    // not expressions). We scan for them here.
    const lines: string[] = [];
    for (const node of graph.getNodes()) {
      if (node.type === "shared_var") {
        const name = node.properties.name ?? "shared";
        const elemType = node.properties.elemType ?? "f32";
        const count = node.properties.count ?? 64;
        lines.push(`var<workgroup> ${name}: array<${elemType}, ${count}>;`);
      }
    }
    return lines.join("\n");
  }
}
