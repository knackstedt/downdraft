import { Material } from "../material/material";
import type { MeshData } from "../mesh/builder";
import { createLogger } from "../util/logger";
import { PipelineCache } from "./pipeline";

const log = createLogger();

export interface WatchedShader {
  path: string;
  material: Material;
  lastModified: number;
}

export interface WatchedMesh {
  path: string;
  lastModified: number;
  onReload: (mesh: MeshData) => void;
}

export interface WatchedTexture {
  path: string;
  lastModified: number;
  onReload: (texture: GPUTexture) => void;
  device: GPUDevice;
  format?: GPUTextureFormat;
  generateMips: boolean;
}

export type HotReloadCallback<T> = (resource: T) => void;

export class MaterialHotReloader {
  private watchedShaders: Map<string, WatchedShader> = new Map();
  private watchedMeshes: Map<string, WatchedMesh> = new Map();
  private watchedTextures: Map<string, WatchedTexture> = new Map();
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
    this.watchedShaders.set(shaderPath, {
      path: shaderPath,
      material,
      lastModified: 0,
    });
  }

  unwatch(shaderPath: string): void {
    this.watchedShaders.delete(shaderPath);
  }

  watchMesh(path: string, onReload: HotReloadCallback<MeshData>): void {
    this.watchedMeshes.set(path, {
      path,
      lastModified: 0,
      onReload,
    });
  }

  unwatchMesh(path: string): void {
    this.watchedMeshes.delete(path);
  }

  watchTexture(
    path: string,
    device: GPUDevice,
    onReload: HotReloadCallback<GPUTexture>,
    options?: { format?: GPUTextureFormat; generateMips?: boolean },
  ): void {
    this.watchedTextures.set(path, {
      path,
      lastModified: 0,
      onReload,
      device,
      format: options?.format,
      generateMips: options?.generateMips ?? true,
    });
  }

  unwatchTexture(path: string): void {
    this.watchedTextures.delete(path);
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

  async checkNow(): Promise<void> {
    await this.check();
  }

  private async check(): Promise<void> {
    await this.checkShaders();
    await this.checkMeshes();
    await this.checkTextures();
  }

  private async checkShaders(): Promise<void> {
    for (const [path, watched] of this.watchedShaders) {
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

  private async checkMeshes(): Promise<void> {
    for (const [path, watched] of this.watchedMeshes) {
      try {
        const response = await fetch(path, { method: "HEAD" });
        const lastMod = response.headers.get("last-modified");
        if (!lastMod) continue;

        const modTime = new Date(lastMod).getTime();
        if (modTime > watched.lastModified) {
          watched.lastModified = modTime;
          await this.reloadMesh(path, watched.onReload);
        }
      } catch {
        // File might not be accessible via fetch in all environments
      }
    }
  }

  private async checkTextures(): Promise<void> {
    for (const [path, watched] of this.watchedTextures) {
      try {
        const response = await fetch(path, { method: "HEAD" });
        const lastMod = response.headers.get("last-modified");
        if (!lastMod) continue;

        const modTime = new Date(lastMod).getTime();
        if (modTime > watched.lastModified) {
          watched.lastModified = modTime;
          await this.reloadTexture(path, watched);
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
      log.warn("HotReloader", `Failed to reload shader: ${path} ${e}`);
    }
  }

  private async reloadMesh(path: string, onReload: HotReloadCallback<MeshData>): Promise<void> {
    try {
      const { GLBLoader } = await import("../assets/loader-mesh");
      const response = await fetch(path);
      const buffer = await response.arrayBuffer();
      const loader = new GLBLoader();
      const result = loader.parseGLB(buffer);
      if (result.meshes.length > 0) {
        onReload(result.meshes[0]);
      }
    } catch (e) {
      log.warn("HotReloader", `Failed to reload mesh: ${path} ${e}`);
    }
  }

  private async reloadTexture(path: string, watched: WatchedTexture): Promise<void> {
    try {
      const { loadTexture } = await import("../assets/loader-texture");
      const textureData = await loadTexture(path, {
        format: watched.format,
        generateMips: watched.generateMips,
      });
      const gpuTexture = watched.device.createTexture({
        size: [textureData.width, textureData.height],
        format: watched.format ?? "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      watched.device.queue.writeTexture(
        { texture: gpuTexture },
        textureData.data as unknown as BufferSource,
        {
          bytesPerRow: textureData.width * 4,
          rowsPerImage: textureData.height,
        },
        [textureData.width, textureData.height],
      );
      watched.onReload(gpuTexture);
    } catch (e) {
      log.warn("HotReloader", `Failed to reload texture: ${path} ${e}`);
    }
  }

  async reloadNow(path: string): Promise<boolean> {
    const shaderWatched = this.watchedShaders.get(path);
    if (shaderWatched) {
      await this.reloadShader(path, shaderWatched.material);
      return true;
    }
    const meshWatched = this.watchedMeshes.get(path);
    if (meshWatched) {
      await this.reloadMesh(path, meshWatched.onReload);
      return true;
    }
    const textureWatched = this.watchedTextures.get(path);
    if (textureWatched) {
      await this.reloadTexture(path, textureWatched);
      return true;
    }
    return false;
  }

  getWatchedPaths(): string[] {
    return [
      ...this.watchedShaders.keys(),
      ...this.watchedMeshes.keys(),
      ...this.watchedTextures.keys(),
    ];
  }

  getWatchedShaderPaths(): string[] {
    return [...this.watchedShaders.keys()];
  }

  getWatchedMeshPaths(): string[] {
    return [...this.watchedMeshes.keys()];
  }

  getWatchedTexturePaths(): string[] {
    return [...this.watchedTextures.keys()];
  }

  destroy(): void {
    this.stop();
    this.watchedShaders.clear();
    this.watchedMeshes.clear();
    this.watchedTextures.clear();
  }
}
