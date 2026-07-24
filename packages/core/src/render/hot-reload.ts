import { PipelineCache } from "./pipeline.ts";
import { Material } from "../material/material.ts";

export interface WatchedShader {
  path: string;
  material: Material;
  lastModified: number;
}

export class MaterialHotReloader {
  private watched: Map<string, WatchedShader> = new Map();
  private pipelineCache: PipelineCache | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private checkInterval: number = 1000;

  constructor(pipelineCache?: PipelineCache) {
    this.pipelineCache = pipelineCache ?? null;
  }

  setPipelineCache(cache: PipelineCache): void {
    this.pipelineCache = cache;
  }

  watch(material: Material, shaderPath: string): void {
    this.watched.set(shaderPath, {
      path: shaderPath,
      material,
      lastModified: 0,
    });
  }

  unwatch(shaderPath: string): void {
    this.watched.delete(shaderPath);
  }

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.check(), this.checkInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async check(): Promise<void> {
    for (const [path, watched] of this.watched) {
      try {
        const response = await fetch(path, { method: "HEAD" });
        const lastMod = response.headers.get("last-modified");
        if (!lastMod) continue;

        const modTime = new Date(lastMod).getTime();
        if (modTime > watched.lastModified) {
          watched.lastModified = modTime;
          await this.reloadShader(path, watched.material);
        }
      } catch {
        // File might not be accessible via fetch in all environments
      }
    }
  }

  private async reloadShader(path: string, material: Material): Promise<void> {
    try {
      const response = await fetch(path);
      const wgsl = await response.text();
      material.shader = wgsl;

      if (this.pipelineCache) {
        this.pipelineCache.invalidate(material.pipelineKey);
      }
    } catch (e) {
      console.warn(`[HotReloader] Failed to reload shader: ${path}`, e);
    }
  }

  async reloadNow(path: string): Promise<boolean> {
    const watched = this.watched.get(path);
    if (!watched) return false;
    await this.reloadShader(path, watched.material);
    return true;
  }

  getWatchedPaths(): string[] {
    return [...this.watched.keys()];
  }

  destroy(): void {
    this.stop();
    this.watched.clear();
  }
}
