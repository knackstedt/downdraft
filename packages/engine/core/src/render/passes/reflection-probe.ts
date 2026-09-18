import type { Vec3 } from "wgpu-matrix";

export interface ReflectionProbeData {
  id: string;
  position: Vec3;
  boxMin: Vec3;
  boxMax: Vec3;
  cubemapTexture: GPUTexture | null;
  cubemapView: GPUTextureView | null;
  irradianceTexture: GPUTexture | null;
  prefilteredTexture: GPUTexture | null;
  weight: number;
  lastUpdated: number;
  resolution: number;
  priority: number;
}

export interface ReflectionProbeConfig {
  maxProbes: number;
  resolution: number;
  refreshRate: number;
  blendDistance: number;
}

export const DEFAULT_REFLECTION_PROBE_CONFIG: ReflectionProbeConfig = {
  maxProbes: 8,
  resolution: 256,
  refreshRate: 30,
  blendDistance: 5.0,
};

export class ReflectionProbeManager {
  private probes: Map<string, ReflectionProbeData> = new Map();
  private config: ReflectionProbeConfig;
  private device: GPUDevice | null = null;

  constructor(config?: Partial<ReflectionProbeConfig>, device?: GPUDevice | null) {
    this.config = { ...DEFAULT_REFLECTION_PROBE_CONFIG, ...config };
    this.device = device ?? null;
  }

  addProbe(id: string, position: Vec3, boxMin: Vec3, boxMax: Vec3, priority: number = 0): ReflectionProbeData | null {
    if (this.probes.size >= this.config.maxProbes) {
      return null;
    }

    let cubemapTexture: GPUTexture | null = null;
    let cubemapView: GPUTextureView | null = null;

    if (this.device) {
      cubemapTexture = this.device.createTexture({
        label: `reflection-probe-${id}`,
        size: [this.config.resolution, this.config.resolution, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      cubemapView = cubemapTexture.createView({ dimension: "cube" });
    }

    const probe: ReflectionProbeData = {
      id,
      position,
      boxMin,
      boxMax,
      cubemapTexture,
      cubemapView,
      irradianceTexture: null,
      prefilteredTexture: null,
      weight: 0,
      lastUpdated: 0,
      resolution: this.config.resolution,
      priority,
    };

    this.probes.set(id, probe);
    return probe;
  }

  removeProbe(id: string): void {
    const probe = this.probes.get(id);
    if (probe) {
      probe.cubemapTexture?.destroy();
      probe.irradianceTexture?.destroy();
      probe.prefilteredTexture?.destroy();
      this.probes.delete(id);
    }
  }

  getProbe(id: string): ReflectionProbeData | null {
    return this.probes.get(id) ?? null;
  }

  getProbes(): ReflectionProbeData[] {
    return Array.from(this.probes.values()).sort((a, b) => b.priority - a.priority);
  }

  findProbesForPosition(pos: Vec3): ReflectionProbeData[] {
    const inside: ReflectionProbeData[] = [];
    for (const probe of this.probes.values()) {
      if (
        pos[0] >= probe.boxMin[0] && pos[0] <= probe.boxMax[0] &&
        pos[1] >= probe.boxMin[1] && pos[1] <= probe.boxMax[1] &&
        pos[2] >= probe.boxMin[2] && pos[2] <= probe.boxMax[2]
      ) {
        inside.push(probe);
      }
    }
    return inside.sort((a, b) => b.priority - a.priority);
  }

  computeProbeWeights(pos: Vec3): Array<{ probe: ReflectionProbeData; weight: number }> {
    const probes = this.findProbesForPosition(pos);
    if (probes.length === 0) return [];

    const weights = probes.map((probe) => {
      const dx = Math.max(probe.boxMin[0] - pos[0], 0, pos[0] - probe.boxMax[0]);
      const dy = Math.max(probe.boxMin[1] - pos[1], 0, pos[1] - probe.boxMax[1]);
      const dz = Math.max(probe.boxMin[2] - pos[2], 0, pos[2] - probe.boxMax[2]);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return { probe, weight: 1.0 / (1.0 + dist * dist) };
    });

    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    if (totalWeight === 0) return [];

    return weights.map((w) => ({
      probe: w.probe,
      weight: w.weight / totalWeight,
    }));
  }

  destroy(): void {
    for (const probe of this.probes.values()) {
      probe.cubemapTexture?.destroy();
      probe.irradianceTexture?.destroy();
      probe.prefilteredTexture?.destroy();
    }
    this.probes.clear();
  }
}
