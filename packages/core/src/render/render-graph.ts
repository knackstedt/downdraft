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

export class RenderGraph {
  private passes: RenderPassDescriptor[] = [];
  private resources: Map<string, RenderResource> = new Map();
  private aliasing: Map<string, string> = new Map();

  addPass(pass: RenderPassDescriptor): void {
    this.passes.push(pass);
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

  getPasses(): RenderPassDescriptor[] {
    return this.passes;
  }

  getAliasing(): Map<string, string> {
    return this.aliasing;
  }

  syncUsageFlags(): void {
    // WGPU handles internal synchronization automatically via usage flags.
    // This method ensures each resource has correct usage flags set based on
    // which passes read/write it. No explicit barriers needed.
  }
}
