// ============================================================================
// EntitySimWorkerHost — shared skeleton for entity-sim worker hosts.
//
// Entity games (to-the-ocean, andrews-sandbox) manage a long-lived sim worker
// that owns a full entity simulation. Their host classes re-implemented the
// same skeleton on top of the raw RPC layer:
//   - sim + input SAB allocation (allocateSimBuffer / allocateInputBuffer)
//   - extra SABs (water, boats, ...) forwarded to the worker's init RPC
//   - config-driven start(config) → spawnWorker → init(buffers, config)
//   - save/load/initSaveStore/restoreFromState null-safe RPC wrappers
//   - sendCommand fire-and-forget
//   - hotReload() via HotReloadPipeline (dev cache-bust worker URL)
//   - getDevToolsProxy() for devtools manifest sync
//
// This base class centralizes that. Subclasses provide:
//   - spawnWorker(cacheBust?): MUST contain the inline
//     `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`
//     pattern (Vite static analysis — see base-worker-host.ts). When
//     `cacheBust` is set (dev hot reload), append `?t=<cacheBust>` to the URL.
//   - buildWorkerConfig(): optional — map the host config to the worker's
//     init config argument. Default: identity.
//
// The init RPC is invoked as:
//   init(simBuffer, inputBuffer, ...extraBufferValues, workerConfig)
// where extraBufferValues are Object.values(extraBuffers) in insertion order.
// Games whose worker init takes a different shape override onInit().
// ============================================================================

import { isDevMode } from "../platform/runtime";
import { allocateInputBuffer, allocateSimBuffer } from "../sab/sim-channel";
import { HotReloadPipeline } from "../sim/hot-reload-pipeline";
import type { IHotReloadable } from "../sim/types";
import type { WorkerApi } from "./rpc";
import { SimWorkerHost, type SimWorkerSaveApi } from "./sim-worker-host";

/** Minimal worker-side API the entity sim host relies on. */
export interface EntitySimApi extends WorkerApi, SimWorkerSaveApi {
  init(
    simBuffer: SharedArrayBuffer,
    inputBuffer: SharedArrayBuffer,
    ...rest: any[]
  ): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface EntitySimHostOptions {
  /** Pre-allocated sim SAB (default: allocateSimBuffer()). */
  simBuffer?: SharedArrayBuffer;
  /** Pre-allocated input SAB (default: allocateInputBuffer()). */
  inputBuffer?: SharedArrayBuffer;
  /** Extra SABs forwarded to init() between inputBuffer and the config arg. */
  extraBuffers?: Record<string, SharedArrayBuffer>;
}

export abstract class EntitySimWorkerHost<
    TApi extends EntitySimApi,
    TConfig,
  >
  extends SimWorkerHost<TApi>
  implements IHotReloadable
{
  protected readonly inputBuffer: SharedArrayBuffer;
  protected readonly extraBuffers: Record<string, SharedArrayBuffer>;
  private simConfig: TConfig | null = null;
  private cacheBust: number | undefined;
  private pipeline: HotReloadPipeline | null = null;

  constructor(opts?: EntitySimHostOptions) {
    super(opts?.simBuffer ?? allocateSimBuffer());
    this.inputBuffer = opts?.inputBuffer ?? allocateInputBuffer();
    this.extraBuffers = opts?.extraBuffers ?? {};
  }

  override getInputBuffer(): SharedArrayBuffer {
    return this.inputBuffer;
  }

  /** Extra SABs exposed to the renderer (e.g. via GameContext.extraBuffers). */
  getExtraBuffers(): Record<string, SharedArrayBuffer> {
    return this.extraBuffers;
  }

  /** Look up a single extra SAB by name. */
  getExtraBuffer(name: string): SharedArrayBuffer | undefined {
    return this.extraBuffers[name];
  }

  /**
   * Spawn the worker with the given config. In dev mode the worker URL is
   * cache-busted so Vite re-serves the (possibly hot-reloaded) module.
   */
  async start(config?: TConfig): Promise<void> {
    this.simConfig = config ?? null;
    this.cacheBust = isDevMode ? Date.now() : undefined;
    await super.start();
    // Entity sim workers don't emit "ready" themselves — the host marks
    // ready + dispatches the event after the init RPC resolves.
    this.onEvent("ready", {});
  }

  /**
   * BaseWorkerHost hook — delegates to spawnWorker so the subclass can apply
   * the cache-bust param. Subclasses implement spawnWorker(), not this.
   */
  protected override createWorker(): Worker {
    return this.spawnWorker(this.cacheBust);
  }

  /**
   * MUST return `new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`.
   * The URL must be inline (not a variable) for Vite's worker bundling to work
   * in production. When `cacheBust` is set, build the URL in a variable and
   * append `?t=<cacheBust>` — dev-only path, so the non-literal form is fine.
   */
  protected abstract spawnWorker(cacheBust?: number): Worker;

  /**
   * Default init RPC: init(simBuffer, inputBuffer, ...extraBuffers, config).
   * Override for workers with a different init signature.
   */
  protected override async onInit(): Promise<void> {
    const cfg = this.buildWorkerConfig(this.simConfig as TConfig);
    await this.getProxy()!.proxy.init(
      this.getSimBuffer(),
      this.inputBuffer,
      ...Object.values(this.extraBuffers),
      cfg,
    );
  }

  /** Map the host config to the worker's init config argument. Default: identity. */
  protected buildWorkerConfig(config: TConfig): unknown {
    return config;
  }

  // --- Hot reload ---

  /** Save → stop → spawn fresh worker → restore. Dev-mode only. */
  async hotReload(config: TConfig, preserveState: boolean): Promise<void> {
    if (!isDevMode) return;
    this.pipeline ??= new HotReloadPipeline(this);
    await this.pipeline.hotReload(config, preserveState);
  }

  // --- DevTools ---

  /**
   * Returns the worker's RPC proxy for devtools manifest sync
   * (exposeDevToolsApi adds __devtoolsGetManifest etc. to the api type).
   */
  getDevToolsProxy(): TApi | null {
    return this.getProxy()?.proxy ?? null;
  }
}
