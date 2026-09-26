// ============================================================================
// session-tracker.ts — per-HMR-session bookkeeping for the native dev shell
//
// The native HMR system keeps the process, SDL window, wgpu host device,
// bridge, and MCP server alive across source edits. What changes is the
// *session*: the game module graph, its workers, timers, listeners, and
// renderer-created GPU devices.
//
// SessionTracker is the registry that makes session teardown deterministic:
// it wraps the global registration surfaces (timers, RAF, event listeners,
// Worker construction) while a session runs, and tears everything down on
// session end — including for bespoke entries (to-the-ocean) that never
// learned the GameModule lifecycle.
//
// Lifecycle:
//   installSessionTracker()  — once per process (idempotent, survives reloads)
//   attachHost(host)         — wraps window/surface/Worker/RAF; captures the
//                              host-internal baseline so teardown only kills
//                              session-owned registrations
//   beginSession()           — start accumulating (before entry eval)
//   teardown()               — dispose chain → listeners → timers → workers →
//                              session GPU devices → transient state reset
//
// Registered sim handles (registerSim — auto-called by EntitySimWorkerHost)
// power the Tier-2 "sim worker swap" and give state save/restore a generic
// surface that works without game cooperation.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { getLiveDevices } from "../gpu/wgpu-device";

const log = createLogger("info");

/** Save slot used for session-restart state preservation (matches the
 *  renderer hot-reload flow). */
export const HOT_RELOAD_SLOT = "hot-reload";
/** sessionStorage flag marking a pending hot-reload restore. */
export const HOT_RELOAD_PENDING_KEY = "hot-reload-pending";

/** A sim worker host registered for hot-swaps + state preservation. */
export interface SessionSim {
  /** Human-readable name for logs (e.g. "SimWebWorker"). */
  label?: string;
  /** Back-reference to the underlying host object — used to dedupe the
   *  EntitySimWorkerHost auto-registration vs explicit installSimHotReload
   *  registrations wrapping the same sim. */
  host?: any;
  /** Swap the worker's code while preserving state (EntitySimWorkerHost.hotReload). */
  hotReload?(preserveState: boolean): Promise<void>;
  /** Serialize current sim state; null when unsupported/not started. */
  save?(): Promise<string | null>;
  /** Restore a previously saved state json. */
  restore?(stateJson: string): Promise<void>;
  /** Stop/terminate the worker. Called on session teardown. */
  stop?(): Promise<void> | void;
}

/** Renderer/meta state contribution grafted onto the hot-reload save. */
export interface SessionMetaProvider {
  serialize(): unknown;
  restore?(meta: unknown): void;
}

interface TrackedListener {
  type: string;
  listener: any;
  remove: () => void;
}

interface SessionSnapshot {
  disposeCallbacks: Array<() => void | Promise<void>>;
  listeners: TrackedListener[];
  timeouts: Set<any>;
  intervals: Set<any>;
  immediates: Set<any>;
  rafIds: Set<number>;
  workers: Set<any>;
  deviceBaseline: Set<any>;
}

export class SessionTracker {
  private session: SessionSnapshot | null = null;
  private sims = new Set<SessionSim>();
  private metaProviders = new Set<SessionMetaProvider>();
  private tearingDown: Promise<void> | null = null;
  private wrapsInstalled = false;
  private pendingStateJson: string | null = null;
  private restoredHosts = new Set<any>();

  /** Registrations made before attachHost() ran — host-internal, exempt
   *  from session teardown. */
  private baseline = {
    timeouts: new Set<any>(),
    intervals: new Set<any>(),
    immediates: new Set<any>(),
  };
  private baselineCaptured = false;

  /** Originals captured at wrap time so wrapped globals delegate correctly. */
  private orig = {
    setTimeout: undefined as any,
    setInterval: undefined as any,
    setImmediate: undefined as any,
  };
  private trackedTargets = new Set<any>();
  private __rafWrap: any = null;
  private __workerWrap: any = null;

  // ── Registration API ──────────────────────────────────────────────────

  /** Register a dispose callback for session teardown. Returns unregister fn. */
  onDispose(fn: () => void | Promise<void>): () => void {
    this.ensureSession();
    const list = this.session!.disposeCallbacks;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Register a sim worker host (auto-called by EntitySimWorkerHost). */
  registerSim(sim: SessionSim): void {
    if (sim.host && this.hasSimFor(sim.host)) return;
    this.sims.add(sim);
  }

  /** True when a registered sim wraps this underlying host object. */
  hasSimFor(host: any): boolean {
    for (const s of this.sims) if (s.host === host) return true;
    return false;
  }

  /** Remove a sim host (permanent shutdown, not session teardown). */
  unregisterSim(sim: SessionSim): void {
    this.sims.delete(sim);
  }

  /**
   * Register a renderer/meta state provider. If a previous session left a
   * pending save, the provider is restored immediately (startGame registers
   * post-init, which is exactly when renderer meta should be applied).
   */
  registerMetaProvider(provider: SessionMetaProvider): () => void {
    this.metaProviders.add(provider);
    const pending = this.pendingStateJson;
    if (pending && provider.restore) {
      try {
        const meta = JSON.parse(pending)?.renderer?.data;
        if (meta !== undefined) provider.restore(meta);
      } catch { /* ignore malformed */ }
    }
    return () => this.metaProviders.delete(provider);
  }

  /** Called by EntitySimWorkerHost.start() — restores pending state onto a
   *  freshly started sim after a session restart. */
  async notifySimStarted(sim: SessionSim): Promise<boolean> {
    if (!this.pendingStateJson || !sim.restore) return false;
    try {
      await sim.restore(this.pendingStateJson);
      if (sim.host) this.restoredHosts.add(sim.host);
      log.info("hmr-session", `${sim.label ?? "sim"} restored after session restart`);
      return true;
    } catch (e) {
      log.error("hmr-session", `sim restore failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** True when this sim host already received a session-restart restore
   *  (guards explicit restoreHotReloadState calls against a second apply). */
  wasRestored(host: any): boolean {
    return this.restoredHosts.has(host);
  }

  /** True when a previous session saved state for restore. */
  get hasPendingState(): boolean {
    return this.pendingStateJson != null
      || !!(globalThis as any).sessionStorage?.getItem?.(HOT_RELOAD_PENDING_KEY);
  }

  // ── Save / restore ────────────────────────────────────────────────────

  /**
   * Persist the session state for the next session: iterates registered sims
   * (stateJson merge) plus meta providers, stores via the downdraft bridge,
   * and sets the sessionStorage pending flag — the same "hot-reload" slot
   * contract the renderer reload flow uses.
   */
  async saveState(): Promise<boolean> {
    const dd = (globalThis as any).downdraft;
    if (!dd?.saveGameState) return false;
    try {
      const components: Record<string, any> = {};
      let anySaved = false;
      for (const sim of this.sims) {
        try {
          const json = await sim.save?.();
          if (json) {
            // Sim save payloads are already component-maps; merge them.
            try { Object.assign(components, JSON.parse(json)); } catch { /* non-JSON state */ }
            this.pendingStateJson = json;
            anySaved = true;
          }
        } catch (e) {
          log.warn("hmr-session", `sim save failed (${sim.label ?? "?"}): ${(e as Error).message}`);
        }
      }
      for (const provider of this.metaProviders) {
        try {
          const data = provider.serialize();
          if (data !== undefined) components.renderer = { v: 1, data };
        } catch { /* best-effort */ }
      }
      if (!anySaved && this.metaProviders.size === 0) return false;
      const merged = JSON.stringify(components);
      if (anySaved) this.pendingStateJson = merged;
      await dd.saveGameState(HOT_RELOAD_SLOT, merged);
      (globalThis as any).sessionStorage?.setItem?.(HOT_RELOAD_PENDING_KEY, "1");
      return true;
    } catch (e) {
      log.warn("hmr-session", `session saveState failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Load the pending merged-state json (for entries that restore explicitly
   * instead of relying on notifySimStarted). Consumes the pending flag.
   */
  async loadPendingState(): Promise<string | null> {
    const storage = (globalThis as any).sessionStorage;
    if (this.pendingStateJson) {
      storage?.removeItem?.(HOT_RELOAD_PENDING_KEY);
      return this.pendingStateJson;
    }
    if (!storage?.getItem?.(HOT_RELOAD_PENDING_KEY)) return null;
    storage?.removeItem?.(HOT_RELOAD_PENDING_KEY);
    const dd = (globalThis as any).downdraft;
    return (await dd?.loadGameState?.(HOT_RELOAD_SLOT)) ?? null;
  }

  /** Restore renderer meta providers from a pending merged-state json. */
  restoreMeta(stateJson: string): void {
    try {
      const meta = JSON.parse(stateJson)?.renderer?.data;
      if (meta !== undefined) {
        for (const provider of this.metaProviders) provider.restore?.(meta);
      }
    } catch { /* ignore malformed */ }
  }

  /** Clear the stored pending save (after successful restore). */
  clearPendingState(): void {
    this.pendingStateJson = null;
    void (globalThis as any).downdraft?.deleteGameState?.(HOT_RELOAD_SLOT);
  }

  // ── Sim hot reload (Tier 2) ───────────────────────────────────────────

  /**
   * Hot-swap all registered sims (save → terminate+respawn → restore).
   * Returns the number of sims that swapped. Errors propagate to the caller
   * (the dev runtime), which escalates to a session restart.
   */
  async hotReloadSims(preserveState: boolean): Promise<number> {
    let swapped = 0;
    for (const sim of this.sims) {
      if (!sim.hotReload) continue;
      await sim.hotReload(preserveState);
      swapped++;
    }
    return swapped;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────

  /** Mark session boot complete — clears the pending-state marker so sims
   *  spawned later (mid-session restarts, not session restarts) don't pick
   *  up stale restore data. Called by the supervisor after the entry import
   *  resolves. */
  finishSessionBoot(): void {
    this.pendingStateJson = null;
    this.restoredHosts.clear();
    (globalThis as any).sessionStorage?.removeItem?.(HOT_RELOAD_PENDING_KEY);
  }

  /** Begin accumulating tracked registrations (called before entry eval). */
  beginSession(): void {
    if (this.session) return; // already active
    this.session = {
      disposeCallbacks: [],
      listeners: [],
      timeouts: new Set(),
      intervals: new Set(),
      immediates: new Set(),
      rafIds: new Set(),
      workers: new Set(),
      deviceBaseline: new Set(),
    };
  }

  /** Mark the device baseline — devices created after this are session-owned. */
  snapshotDevices(devices: Iterable<any>): void {
    this.ensureSession();
    this.session!.deviceBaseline = new Set(devices);
  }

  private ensureSession(): void {
    if (!this.session) this.beginSession();
  }

  /** Register a worker instance for teardown (used by the Worker wrapper). */
  trackWorker(w: any): void {
    this.ensureSession();
    this.session!.workers.add(w);
  }

  /**
   * Attach the tracker to a (possibly reused) native host:
   *  - captures the timer baseline so host-internal intervals survive teardown
   *  - wraps event targets + RAF + Worker for session tracking
   *  - snapshots the live GPU device set
   *  - installs the permanent window-close → supervisor shutdown hook
   * Safe to call repeatedly (e.g. per session via createNativeHost reuse).
   */
  attachHost(host: any): void {
    if (!host?.window) return;
    if (!this.baselineCaptured) {
      this.baselineCaptured = true;
      const s = this.session;
      if (s) {
        for (const id of s.timeouts) this.baseline.timeouts.add(id);
        for (const id of s.intervals) this.baseline.intervals.add(id);
        for (const id of s.immediates) this.baseline.immediates.add(id);
      }
    }

    // Window-close → supervisor shutdown. Registered through the ORIGINAL
    // addEventListener (pre-wrap) so it survives session teardown.
    if (!host.__ddCloseHooked) {
      host.__ddCloseHooked = true;
      const rawAdd = host.window.addEventListener?.bind(host.window);
      rawAdd?.("close", () => {
        try { (globalThis as any).__ddSupervisor?.shutdown?.(); } catch { /* already down */ }
      });
    }

    this.trackEventTarget(host.window);
    this.trackEventTarget(host.surface);
    this.trackEventTarget((globalThis as any).window);
    this.trackEventTarget((globalThis as any).document);
    if (typeof (globalThis as any).addEventListener === "function") {
      this.trackEventTarget(globalThis);
    }
    this.attachRuntimeGlobals();
    this.snapshotDevices(getLiveDevices());
  }

  /**
   * Tear down the current session: run the dispose chain (LIFO), detach
   * tracked listeners, cancel session timers/RAF, terminate tracked workers,
   * destroy session-created GPU devices. Idempotent + reentrant (concurrent
   * callers join the same teardown).
   */
  async teardown(opts: { destroyDevices?: boolean } = {}): Promise<void> {
    if (this.tearingDown) return this.tearingDown;
    this.tearingDown = this.teardownInner(opts).finally(() => {
      this.tearingDown = null;
    });
    return this.tearingDown;
  }

  private async teardownInner(opts: { destroyDevices?: boolean }): Promise<void> {
    const s = this.session;
    if (!s) return;
    // NOTE: `this.session` stays live through the whole teardown so callbacks
    // that fire during the awaited steps — a render loop rescheduling its
    // setImmediate, a listener added by a dispose hook — still register into
    // `s` and get killed by the final sweep. Nulling it up here lets those
    // stragglers escape tracking and become zombie loops forever.

    // 1. Dispose chain (LIFO) — engine dispose()/onHotReloadDispose hooks land here.
    for (let i = s.disposeCallbacks.length - 1; i >= 0; i--) {
      try { await s.disposeCallbacks[i](); } catch (e) {
        log.warn("hmr-session", `dispose callback threw: ${(e as Error).message}`);
      }
    }

    // 2. Registered sims — stop workers via their shutdown protocol before
    //    the blunt tracked-worker terminate pass (clean exit > SIGKILL),
    //    then drop the registrations: they reference the dying module graph.
    for (const sim of this.sims) {
      try { await sim.stop?.(); } catch { /* already stopped */ }
    }
    this.sims.clear();
    // Meta providers likewise belong to the old graph — the pending save
    // (pendingStateJson) keeps their data until the next session registers
    // fresh providers and restores via registerMetaProvider.
    this.metaProviders.clear();

    // 3. Tracked listeners.
    for (const l of s.listeners) {
      try { l.remove(); } catch { /* target gone */ }
    }
    s.listeners.length = 0;

    // 4. Timers + immediates + RAF (session-owned only — host baseline survives).
    for (const id of s.timeouts) {
      if (!this.baseline.timeouts.has(id)) { try { clearTimeout(id); } catch {} }
    }
    for (const id of s.intervals) {
      if (!this.baseline.intervals.has(id)) { try { clearInterval(id); } catch {} }
    }
    for (const id of s.immediates) {
      if (!this.baseline.immediates.has(id)) { try { (globalThis as any).clearImmediate?.(id); } catch {} }
    }
    for (const id of s.rafIds) {
      try { (globalThis as any).cancelAnimationFrame?.(id); } catch {}
    }

    // 5. Tracked workers (belt — sims already stopped via step 2).
    for (const w of s.workers) {
      try { w.terminate?.(); } catch { /* already dead */ }
    }
    s.workers.clear();

    // 6. Session-created GPU devices (delta vs the baseline snapshot).
    if (opts.destroyDevices) {
      for (const d of getLiveDevices()) {
        if (!s.deviceBaseline.has(d)) {
          try { d.destroy(); } catch { /* best-effort */ }
        }
      }
    }

    // 7. Transient sim state registry (engine) — stale system maps/flags must
    //    not freeze into the next session. Exposed as a global so this file
    //    doesn't import engine internals statically.
    try {
      (globalThis as any).__ddTransientStateRegistry?.resetAll?.();
    } catch { /* optional */ }

    // 8. Final synchronous sweep — anything registered while the awaited
    //    steps above ran is still in `s` and dies here. After this point no
    //    user callback can interleave (synchronous tail), so the session is
    //    airtight when nulled.
    for (const l of s.listeners) {
      try { l.remove(); } catch { /* target gone */ }
    }
    s.listeners.length = 0;
    for (const id of s.timeouts) {
      if (!this.baseline.timeouts.has(id)) { try { clearTimeout(id); } catch {} }
    }
    for (const id of s.intervals) {
      if (!this.baseline.intervals.has(id)) { try { clearInterval(id); } catch {} }
    }
    for (const id of s.immediates) {
      if (!this.baseline.immediates.has(id)) { try { (globalThis as any).clearImmediate?.(id); } catch {} }
    }
    for (const id of s.rafIds) {
      try { (globalThis as any).cancelAnimationFrame?.(id); } catch {}
    }
    for (const w of s.workers) {
      try { w.terminate?.(); } catch { /* already dead */ }
    }
    s.workers.clear();

    this.session = null;
  }

  /** Diagnostics counters (strict-mode leak checks). */
  stats(): { listeners: number; timers: number; workers: number; disposes: number; sims: number } {
    const s = this.session;
    return {
      listeners: s?.listeners.length ?? 0,
      timers: (s?.timeouts.size ?? 0) + (s?.intervals.size ?? 0) + (s?.immediates.size ?? 0) + (s?.rafIds.size ?? 0),
      workers: s?.workers.size ?? 0,
      disposes: s?.disposeCallbacks.length ?? 0,
      sims: this.sims.size,
    };
  }

  // ── Global wrapping ───────────────────────────────────────────────────

  /** Wrap process-global timers once. Idempotent. */
  installGlobalWraps(): void {
    if (this.wrapsInstalled) return;
    this.wrapsInstalled = true;
    const g = globalThis as any;
    const self = this;

    if (typeof g.setTimeout === "function") {
      this.orig.setTimeout = g.setTimeout;
      const origClear = g.clearTimeout?.bind(g);
      g.setTimeout = function (fn: any, ms?: number, ...rest: any[]) {
        const id = self.orig.setTimeout(fn, ms, ...rest);
        if (self.session) self.session.timeouts.add(id);
        return id;
      };
      g.clearTimeout = function (id: any) {
        if (self.session) self.session.timeouts.delete(id);
        return origClear?.(id);
      };
    }
    if (typeof g.setInterval === "function") {
      this.orig.setInterval = g.setInterval;
      const origClear = g.clearInterval?.bind(g);
      g.setInterval = function (fn: any, ms?: number, ...rest: any[]) {
        const id = self.orig.setInterval(fn, ms, ...rest);
        if (self.session) self.session.intervals.add(id);
        return id;
      };
      g.clearInterval = function (id: any) {
        if (self.session) self.session.intervals.delete(id);
        return origClear?.(id);
      };
    }
    if (typeof g.setImmediate === "function") {
      this.orig.setImmediate = g.setImmediate;
      const origClear = g.clearImmediate?.bind(g);
      g.setImmediate = function (fn: any, ...rest: any[]) {
        const id = self.orig.setImmediate(fn, ...rest);
        if (self.session) self.session.immediates.add(id);
        return id;
      };
      g.clearImmediate = function (id: any) {
        if (self.session) self.session.immediates.delete(id);
        return origClear?.(id);
      };
    }
  }

  /**
   * Wrap the current requestAnimationFrame + Worker globals (installed by
   * createNativeHost — call via attachHost after host creation; safe to
   * re-call after a host restart replaces them).
   */
  attachRuntimeGlobals(): void {
    const g = globalThis as any;
    const self = this;

    if (typeof g.requestAnimationFrame === "function" && g.requestAnimationFrame !== this.__rafWrap) {
      const origRaf = g.requestAnimationFrame;
      const origCancel = g.cancelAnimationFrame?.bind(g);
      g.requestAnimationFrame = function (cb: any) {
        const id = origRaf(cb);
        if (self.session) self.session.rafIds.add(id);
        return id;
      };
      g.cancelAnimationFrame = function (id: number) {
        if (self.session) self.session.rafIds.delete(id);
        return origCancel?.(id);
      };
      this.__rafWrap = g.requestAnimationFrame;
    }

    if (typeof g.Worker === "function" && g.Worker !== this.__workerWrap) {
      const OrigWorker = g.Worker;
      const tracker = self;
      const Wrapped = class extends OrigWorker {
        constructor(...args: any[]) {
          super(...args);
          tracker.trackWorker(this);
        }
      };
      // Preserve statics + prototype chain for instanceof checks.
      Object.setPrototypeOf(Wrapped, OrigWorker);
      g.Worker = Wrapped;
      this.__workerWrap = Wrapped;
    }
  }

  /**
   * Wrap addEventListener/removeEventListener on a target so listeners are
   * detached on session teardown. Idempotent per target object; re-attach
   * after a host restart via resetTrackedTargets() + attachHost().
   */
  trackEventTarget(target: any): void {
    if (!target || typeof target.addEventListener !== "function") return;
    if (this.trackedTargets.has(target)) return;
    if ((target.addEventListener as any).__ddTracked) return;
    this.trackedTargets.add(target);
    const self = this;
    const origAdd = target.addEventListener.bind(target);
    const origRemove = target.removeEventListener?.bind(target);
    const wrappedAdd = function (type: string, listener: any, opts?: any) {
      origAdd(type, listener, opts);
      if (self.session) {
        self.session.listeners.push({
          type,
          listener,
          remove: () => { try { origRemove?.(type, listener, opts); } catch {} },
        });
      }
    };
    (wrappedAdd as any).__ddTracked = true;
    try {
      target.addEventListener = wrappedAdd;
      if (origRemove) {
        target.removeEventListener = function (type: string, listener: any, opts?: any) {
          origRemove(type, listener, opts);
          const s = self.session;
          if (s) {
            // Drop the matching tracking entry (last-registered wins).
            for (let j = s.listeners.length - 1; j >= 0; j--) {
              const l = s.listeners[j];
              if (l.type === type && l.listener === listener) { s.listeners.splice(j, 1); break; }
            }
          }
        };
      }
    } catch { /* non-writable — skip tracking for this target */ }
  }

  /** Reset tracked-target bookkeeping after a host restart (new objects). */
  resetTrackedTargets(): void {
    this.trackedTargets.clear();
    this.__rafWrap = null;
    this.__workerWrap = null;
    this.baselineCaptured = false;
    this.baseline = { timeouts: new Set(), intervals: new Set(), immediates: new Set() };
  }
}

const SESSION_KEY = "__ddSession";

/** Install (or fetch) the global session tracker. Idempotent across re-evals. */
export function installSessionTracker(): SessionTracker {
  const g = globalThis as any;
  if (g[SESSION_KEY] instanceof SessionTracker) return g[SESSION_KEY];
  const tracker = new SessionTracker();
  tracker.installGlobalWraps();
  g[SESSION_KEY] = tracker;
  return tracker;
}

/** Current session tracker (null outside the dev shell). */
export function getSessionTracker(): SessionTracker | null {
  return (globalThis as any)[SESSION_KEY] ?? null;
}
