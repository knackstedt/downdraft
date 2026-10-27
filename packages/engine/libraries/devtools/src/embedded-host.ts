// ============================================================================
// embedded-host.ts — EmbeddedDevtoolsHost: the headless devtools backend.
//
// Owns the CdpBridge + DevtoolsBackend without any UI surface — the frontend
// is the @downdraft/devtools overlay (in-window) or a remote viewer attached
// over DevToolsServer (mountDevtools' attachSelfMirror). bootstrap wires one
// per app when devtools are enabled so providers, collectors, and thread
// evals exist regardless of which frontend is showing.
//
// The backend only collects while a consumer is attached — emit() is a noop
// until attachRemote() adds a sink, and hasClient() ORs remote attachments,
// so an app with no viewer pays nothing beyond the pump call.
// ============================================================================

import { DevtoolsBackend, type EvalFn } from "./backend";
import { CdpBridge } from "./cdp-bridge";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface EmbeddedDevtoolsHostOptions {
  /** The app renderer — feeds GPU/scene/metrics collectors. */
  renderer: unknown;
  /** Optional scene-graph host — feeds the scene tree panel. */
  appScene?: unknown;
  /** Optional ProfilingSAB for per-worker performance metrics. */
  profilingSAB?: SharedArrayBuffer | null;
}

export class EmbeddedDevtoolsHost {
  private cdp = new CdpBridge();
  private backend: DevtoolsBackend;
  private disposed = false;

  constructor(opts: EmbeddedDevtoolsHostOptions) {
    this.backend = new DevtoolsBackend({
      emit: () => { /* sinks attach via backend.attachRemote() */ },
      hasClient: () => false, // remote attachments OR their own checks in
      cdp: this.cdp,
      renderer: opts.renderer,
      appScene: opts.appScene,
      profilingSAB: opts.profilingSAB ?? null,
    });
  }

  /** Provider/command registration surface — satisfies DevtoolsProviderTarget. */
  get devtoolsMirror(): DevtoolsBackend { return this.backend; }

  /** Start the backend + CDP session. */
  start(): void {
    this.backend.start();
    this.backend.attachLoggerBridge();
    this.cdp.start();
  }

  /** Per-frame pump — call from a frame hook. */
  update(): void {
    if (this.disposed) return;
    try {
      this.backend.update();
    } catch (err) {
      log.warn("devtools-host", `backend update error: ${err}`);
    }
  }

  registerThreadEval(name: string, fn: EvalFn): void {
    this.backend.registerThreadEval(name, fn);
  }

  setPerfRecording(on: boolean): void {
    this.backend.setPerfRecording(on);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.backend.dispose(); } catch { /* ignore */ }
    try { this.cdp.dispose(); } catch { /* ignore */ }
  }
}
