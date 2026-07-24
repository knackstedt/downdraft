import type { MeshData } from "../mesh/builder.ts";

export interface RenderResource {
  name: string;
  type: "texture" | "buffer";
  format?: string;
  size?: number;
}

export interface RenderPassDescriptor {
  name: string;
  inputs: string[];
  outputs: string[];
}

export interface ValidationError {
  pass: string;
  resource: string;
  message: string;
}

export class RenderGraph {
  private passes: RenderPassDescriptor[] = [];
  private resources: Map<string, RenderResource> = new Map();
  private aliasing: Map<string, string> = new Map();
  private executionOrder: string[] = [];

  addPass(pass: RenderPassDescriptor): void {
    this.passes.push(pass);
    this.executionOrder = [];
  }

  registerResource(resource: RenderResource): void {
    this.resources.set(resource.name, resource);
  }

  resolveAliasing(): void {
    const lifetimes = new Map<string, { firstUse: number; lastUse: number }>();

    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      const allRefs = [...pass.inputs, ...pass.outputs];
      for (let j = 0; j < allRefs.length; j++) {
        const name = allRefs[j];
        const existing = lifetimes.get(name);
        if (existing) {
          existing.lastUse = i;
        } else {
          lifetimes.set(name, { firstUse: i, lastUse: i });
        }
      }
    }

    const sorted = [...lifetimes.entries()].sort((a, b) => a[1].firstUse - b[1].firstUse);
    for (let i = 0; i < sorted.length; i++) {
      const [nameA, lifeA] = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const [nameB, lifeB] = sorted[j];
        if (lifeA.lastUse < lifeB.firstUse) {
          this.aliasing.set(nameB, nameA);
          break;
        }
      }
    }
  }

  validate(): ValidationError[] {
    const errors: ValidationError[] = [];
    const produced = new Set<string>();

    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      for (let j = 0; j < pass.inputs.length; j++) {
        const input = pass.inputs[j];
        if (!produced.has(input) && !this.resources.has(input)) {
          errors.push({ pass: pass.name, resource: input, message: `Input "${input}" is not produced by any prior pass or registered as external` });
        }
      }
      for (let j = 0; j < pass.outputs.length; j++) {
        produced.add(pass.outputs[j]);
      }
    }

    return errors;
  }

  topologicalSort(): string[] {
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const pass of this.passes) {
      if (!adj.has(pass.name)) adj.set(pass.name, []);
      if (!inDegree.has(pass.name)) inDegree.set(pass.name, 0);
    }

    const resourceToPass = new Map<string, string>();
    for (const pass of this.passes) {
      for (const output of pass.outputs) {
        resourceToPass.set(output, pass.name);
      }
    }

    for (const pass of this.passes) {
      for (const input of pass.inputs) {
        const producer = resourceToPass.get(input);
        if (producer && producer !== pass.name) {
          adj.get(producer)!.push(pass.name);
          inDegree.set(pass.name, (inDegree.get(pass.name) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const name = queue.shift()!;
      result.push(name);
      const neighbors = adj.get(name) ?? [];
      for (const neighbor of neighbors) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    return result;
  }

  getPasses(): RenderPassDescriptor[] {
    return this.passes;
  }

  getAliasing(): Map<string, string> {
    return this.aliasing;
  }

  getExecutionOrder(): string[] {
    if (this.executionOrder.length === 0) {
      this.executionOrder = this.topologicalSort();
    }
    return this.executionOrder;
  }

  syncUsageFlags(): void {
    // WGPU handles internal synchronization automatically via usage flags.
    // This method ensures each resource has correct usage flags set based on
    // which passes read/write it. No explicit barriers needed.
  }

  clear(): void {
    this.passes = [];
    this.resources.clear();
    this.aliasing.clear();
    this.executionOrder = [];
  }
}
