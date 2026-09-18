// ============================================================================
// ComputeGraph — node-based compute kernel authoring
// Separate from MaterialGraph: compute shaders have storage/uniform buffer
// declarations, workgroup dispatch config, and buffer-store output semantics
// that don't fit the vertex/fragment material pipeline.
// ============================================================================

import type { GraphNode } from "./graph";

export interface StructField {
  name: string;
  type: string;
}

export interface StorageBufferDecl {
  name: string;
  binding: number;
  group: number;
  access: "read" | "write" | "read_write";
  structName: string;
  structFields: StructField[];
  /** Fixed element count for `array<Struct, N>`. If undefined, runtime-sized `array<Struct>`. */
  elementCount?: number;
  /** Default allocation size in bytes when auto-allocated by GraphComputePass (runtime-sized only). */
  defaultSize?: number;
}

export interface UniformBufferDecl {
  name: string;
  binding: number;
  group: number;
  structName: string;
  structFields: StructField[];
}

export interface ComputeDispatchConfig {
  /** `@workgroup_size(x, y, z)` — threads per workgroup. */
  workgroupSize: [number, number, number];
  /** Number of workgroups to dispatch. Use "runtime" for indirect dispatch. */
  dispatchCount: [number, number, number] | "runtime";
}

export interface ComputeGraphConnection {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export class ComputeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private connections: ComputeGraphConnection[] = [];
  private storageBuffers: StorageBufferDecl[] = [];
  private uniformBuffers: UniformBufferDecl[] = [];
  private dispatch: ComputeDispatchConfig = {
    workgroupSize: [64, 1, 1],
    dispatchCount: [1, 1, 1],
  };
  private entryPoint: string = "cs_main";

  // ── Node management (mirrors MaterialGraph API) ──────────────────────────

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  connect(from: string, fromPort: string, to: string, toPort: string): void {
    this.connections.push({ from, fromPort, to, toPort });
  }

  getNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  getConnections(): ComputeGraphConnection[] {
    return [...this.connections];
  }

  // ── Compute-specific declarations ────────────────────────────────────────

  addStorageBuffer(decl: StorageBufferDecl): void {
    this.storageBuffers.push(decl);
  }

  addUniformBuffer(decl: UniformBufferDecl): void {
    this.uniformBuffers.push(decl);
  }

  getStorageBuffers(): StorageBufferDecl[] {
    return [...this.storageBuffers];
  }

  getUniformBuffers(): UniformBufferDecl[] {
    return [...this.uniformBuffers];
  }

  setDispatchConfig(config: ComputeDispatchConfig): void {
    this.dispatch = config;
  }

  getDispatchConfig(): ComputeDispatchConfig {
    return this.dispatch;
  }

  getEntryPoint(): string {
    return this.entryPoint;
  }

  setEntryPoint(name: string): void {
    this.entryPoint = name;
  }
}
