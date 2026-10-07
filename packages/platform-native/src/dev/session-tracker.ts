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
  /** Set the moment teardown starts: subsequent registrations are dropped
   *  (or zombie-tracked for timers) instead of being swept by the teardown
   *  already in flight. Without this, a reimported session racing a slow
   *  teardown registers into the dying snapshot and its listeners/timers are
   *  killed by the final sweep — a born-dead session. */
  dead?: boolean;
  disposeCallbacks: Array<() => void | Promise<void>>;
  listeners: TrackedListener[];
  timeouts: Set<any>;
  intervals: Set<any>;
  immediates: Set<any>;
  rafIds: Set<number>;
  workers: Set<any>;
  deviceBaseline: Set<any>;
  /** Sims registered while this snapshot was live — teardown must only
   *  stop/clear its own generation's sims, not a newer session's (the
   *  tracker-level `sims` set spans generations). */
  sims: Set<SessionSim>;
  /** Meta providers registered while this snapshot was live — same
   *  generation-scoping as `sims`. */
  metaProviders: Set<SessionMetaProvider>;
}

export class SessionTracker {
  private session: SessionSnapshot | null = null;
  private host: any = null;
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
  private __warnOrphan: ((kind: string) => void) | null = null;
  /** Registrations that arrived while no session was live at all (between
   *  teardown completion and the next beginSession) — swept at the start
   *  of every teardown so they can't outlive their generation. */
  private zombies = { timeouts: new Set<any>(), intervals: new Set<any>(), immediates: new Set<any>() };

  // ── Registration API ──────────────────────────────────────────────────

  /** Register a dispose callback for session teardown. Returns unregister fn.
   *  Registrations landing in a dead/null-session gap belong to a stale
   *  generation's async continuation — creating a session for them would
   *  orphan a snapshot no supervisor ever begins/tears down, so they're
   *  dropped (their cleanup is moot: teardown already ran). */
  onDispose(fn: () => void | Promise<void>): () => void {
    const s = this.session;
    if (!s || s.dead) {
      this.__warnOrphan?.("onDispose(dead/null-session)");
      return () => {};
    }
    const list = s.disposeCallbacks;
    // Tag each callback with its registration site so the
    // teardown timeout warnings name the culprit instead of "wrapped".
    try {
      (fn as any).__ddSite = (new Error().stack ?? "")
        .split("\n").slice(2, 5).map((l) => l.trim()).join(" | ");
    } catch {}
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Register a sim worker host (auto-called by EntitySimWorkerHost). */
  registerSim(sim: SessionSim): void {
    if (sim.host && this.hasSimFor(sim.host)) return;
    const s = this.session;
    // Gap registration = stale continuation spawning a worker after its
    // generation died — stop it now; nothing else will ever sweep it.
    if (!s || s.dead) {
      this.__warnOrphan?.("registerSim(dead/null-session)");
      try { void (sim.stop?.() as Promise<void> | undefined)?.catch?.(() => {}); } catch {}
      return;
    }
    this.sims.add(sim);
    // Track the owning snapshot so teardown only stops/clears sims from its
    // own generation — a racing reimport's sim must survive this teardown.
    (sim as any).__ddSessionSnap = s;
    s.sims.add(sim);
  }

  /** True when a registered sim wraps this underlying host object. */
  hasSimFor(host: any): boolean {
    for (const s of this.sims.values()) if (s.host === host) return true;
    return false;
  }

  /** Remove a sim host (permanent shutdown, not session teardown). */
  unregisterSim(sim: SessionSim): void {
    this.sims.delete(sim);
    ((sim as any).__ddSessionSnap as SessionSnapshot | null)?.sims.delete(sim);
    (sim as any).__ddSessionSnap = null;
  }

  /**
   * Register a renderer/meta state provider. If a previous session left a
   * pending save, the provider is restored immediately (startGame registers
   * post-init, which is exactly when renderer meta should be applied).
   */
  registerMetaProvider(provider: SessionMetaProvider): () => void {
    const s = this.session;
    if (!s || s.dead) {
      this.__warnOrphan?.("registerMetaProvider(dead/null-session)");
      return () => {};
    }
    this.metaProviders.add(provider);
    (provider as any).__ddSessionSnap = s;
    s.metaProviders.add(provider);
    const pending = this.pendingStateJson;
    if (pending && provider.restore) {
      try {
        const meta = JSON.parse(pending)?.renderer?.data;
        if (meta !== undefined) provider.restore(meta);
      } catch { /* ignore malformed */ }
    }
    return () => {
      this.metaProviders.delete(provider);
      ((provider as any).__ddSessionSnap as SessionSnapshot | null)?.metaProviders?.delete(provider);
    };
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
      for (const sim of this.sims.values()) {
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
      for (const provider of this.metaProviders.values()) {
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
        for (const provider of this.metaProviders.values()) provider.restore?.(meta);
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
    for (const sim of this.sims.values()) {
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
    if (this.session && !this.session.dead) return; // already active
    // Sweep zombie timers armed in the dead/null-session gap — they belong
    // to the previous generation's async continuations and pin its module
    // graph (renderer → sim → workers) while armed. Host/supervisor code
    // uses untracked helpers or rawSetTimeout, so nothing here is legit.
    this.sweepZombies();
    this.session = {
      disposeCallbacks: [],
      listeners: [],
      timeouts: new Set(),
      intervals: new Set(),
      immediates: new Set(),
      rafIds: new Set(),
      workers: new Set(),
      deviceBaseline: new Set(),
      sims: new Set(),
      metaProviders: new Set(),
    };
  }

  /** Mark the device baseline — devices created after this are session-owned. */
  snapshotDevices(devices: Iterable<any>): void {
    const s = this.session;
    if (!s || s.dead) return; // no live session to own a baseline
    s.deviceBaseline = new Set(devices);
  }

  private sweepZombies(): void {
    for (const id of this.zombies.timeouts.values()) { try { clearTimeout(id); } catch {} }
    for (const id of this.zombies.intervals.values()) { try { clearInterval(id); } catch {} }
    for (const id of this.zombies.immediates.values()) { try { (globalThis as any).clearImmediate?.(id); } catch {} }
    this.zombies.timeouts.clear();
    this.zombies.intervals.clear();
    this.zombies.immediates.clear();
  }

  /** Register a worker instance for teardown (used by the Worker wrapper).
   *  Workers spawned in a dead/null-session gap stay UNTRACKED: host-internal
   *  workers (services, MCP) legitimately spawn there during host restart and
   *  must never be killed by session teardown. A stale-generation worker that
   *  slips through untracked is the lesser evil — warn so it's visible. */
  trackWorker(w: any): void {
    const s = this.session;
    if (!s || s.dead) {
      this.__warnOrphan?.("Worker(dead/null-session)");
      return;
    }
    s.workers.add(w);
  }

  /** Remove a worker from session tracking — for host-internal workers that
   *  spawn while a session is live (createNativeHost runs after beginSession,
   *  so the services worker would otherwise be killed by the NEXT session
   *  teardown, stranding every in-flight RPC deferred forever). */
  untrackWorker(w: any): void {
    this.session?.workers.delete(w);
  }

  /**
   * Terminate a session-tracked worker AND settle JS-side waiters that only
   * resolve via worker events. A terminated worker never posts again and any
   * "ready"-style arming timeout was already swept, so without a synthetic
   * terminal event an `await ready`/`await firstMessage` frame (e.g.
   * WorkerPluginLoader.load) suspends forever — the suspended frame pins the
   * entire dead module graph (renderer, registries, every module env).
   * `error` covers DOM-style waiters (addEventListener/onerror), `exit`
   * covers EventEmitter-style (node worker_threads interop).
   */
  private terminateTrackedWorker(w: any): void {
    // Settle event-based waiters BEFORE terminating: terminate() can tear
    // down the worker's JS-side listener surface, making a post-terminate
    // dispatchEvent a no-op — the "ready"-style promise then never settles
    // and its suspended frame pins the whole dead module graph.
    try {
      if (typeof w.dispatchEvent === "function" && typeof Event === "function") {
        w.dispatchEvent(new Event("error"));
        // Belt: dispatchEvent may not route to the onerror property handler
        // on non-DOM worker shims — a second invoke is harmless (the waiter's
        // reject is already settled or idempotent).
        try { (w as any).onerror?.({ type: "error", message: "worker terminated by session teardown" }); } catch { /* handler threw */ }
      } else {
        w.emit?.("error", new Error("worker terminated by session teardown"));
        w.emit?.("exit", 1);
        try { (w as any).onerror?.({ type: "error" }); } catch { /* handler threw */ }
      }
      try { (w as any).onerror = null; } catch { /* read-only */ }
    } catch { /* event surface absent or a listener threw — nothing to settle */ }
    // Prefer the tagged RPC proxy — its terminate() also rejects pending
    // calls, so awaiters don't pin the dead session until RPC timeout.
    try { (w.__ddWorkerProxy ?? w).terminate?.(); } catch { /* already dead */ }
    // Bun natively retains terminated Worker wrappers — any JS surface left
    // on the wrapper (property handlers, the tagged proxy, EventEmitter-style
    // listener maps) keeps its dead-generation closures reachable forever.
    // Scrub them so the retained wrapper pins only itself.
    try { (w as any).onmessage = null; } catch { /* read-only */ }
    try { (w as any).onmessageerror = null; } catch { /* read-only */ }
    try { delete (w as any).__ddWorkerProxy; } catch { /* non-configurable */ }
    try { (w as any).removeAllListeners?.(); } catch { /* not an emitter */ }
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
    this.host = host;
    if (!this.baselineCaptured) {
      this.baselineCaptured = true;
      const s = this.session;
      if (s) {
        for (const id of s.timeouts.values()) this.baseline.timeouts.add(id);
        for (const id of s.intervals.values()) this.baseline.intervals.add(id);
        for (const id of s.immediates.values()) this.baseline.immediates.add(id);
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
    this.trackBridgeSubscriptions();
    this.snapshotDevices(getLiveDevices());
  }

  /**
   * Tear down the current session: run the dispose chain (LIFO), detach
   * tracked listeners, cancel session timers/RAF, terminate tracked workers,
   * destroy session-created GPU devices. Idempotent + reentrant (concurrent
   * callers join the same teardown).
   */
  async teardown(opts: { destroyDevices?: boolean } = {}): Promise<void> {
    // Snapshot the session this call is responsible for. If a teardown is
    // already in flight for an OLDER snapshot, wait for it and re-check —
    // a newer session may have begun in the meantime (reimport racing a
    // slow teardown), and it must not be killed by this call.
    while (true) {
      const s = this.session;
      if (!s || s.dead) {
        try { await this.tearingDown; } catch {}
        return;
      }
      if (this.tearingDown) {
        try { await this.tearingDown; } catch {}
        continue;
      }
      // Mark dead synchronously so every registration path (onDispose,
      // the wrapped timers/listeners below) stops routing into this
      // snapshot — a racing reimport's beginSession() then builds a fresh
      // session instead of feeding the final sweep.
      s.dead = true;
      this.tearingDown = this.teardownInner(s, opts).finally(() => {
        this.tearingDown = null;
      });
      return this.tearingDown;
    }
  }

  private async teardownInner(s: SessionSnapshot, opts: { destroyDevices?: boolean }): Promise<void> {
    // NOTE: `this.session` still points at `s` (marked dead) through the
    // whole teardown — callbacks that fire during the awaited steps get
    // dropped by the dead-checks, and a new session may already be live on
    // `this.session` by the time we finish; only null it if it's still ours.

    // 0. Zombie sweep — registrations that arrived while no session was
    //    live (late async continuations of a previous teardown, host code
    //    between sessions) belong to a dead graph. Clear them with this
    //    teardown so nothing armed survives a restart.
    this.sweepZombies();

    // 1. Quiesce first: cancel session timers/RAF and terminate workers
    //    BEFORE running the dispose chain. Dispose callbacks routinely await
    //    sim-worker RPCs and event replies — if workers are still "alive but
    //    detached" those awaits hang until the per-callback bound, and the
    //    still-pending promise pins the whole module env. Terminating first
    //    rejects pending RPCs so disposers settle immediately.
    for (const id of s.timeouts.values()) {
      if (!this.baseline.timeouts.has(id)) { try { clearTimeout(id); } catch {} }
    }
    for (const id of s.intervals.values()) {
      if (!this.baseline.intervals.has(id)) { try { clearInterval(id); } catch {} }
    }
    for (const id of s.immediates.values()) {
      if (!this.baseline.immediates.has(id)) { try { (globalThis as any).clearImmediate?.(id); } catch {} }
    }
    for (const id of s.rafIds.values()) {
      try { (globalThis as any).cancelAnimationFrame?.(id); } catch {}
    }
    // Drop the id sets as we go — anything that retains the dead snapshot
    // (an armed native handle whose wrapped callback still holds a WeakRef
    // target, a pending RPC env) shouldn't drag the registration arrays too.
    s.timeouts.clear();
    s.intervals.clear();
    s.immediates.clear();
    s.rafIds.clear();

    // 2. This snapshot's sims — stop workers via their shutdown protocol
    //    before the blunt tracked-worker terminate pass (clean exit >
    //    SIGKILL), then drop the registrations: they reference the dying
    //    module graph. Match by __ddSessionSnap (not s.sims membership) so a
    //    sim whose snapshot was swapped mid-registration is still detached —
    //    a stale backref would pin the dead snapshot's whole listener set.
    //    Bounded per-sim: a wedged/terminated worker must not hang teardown.
    for (const sim of [...this.sims]) {
      if ((sim as any).__ddSessionSnap !== s) continue;
      try {
        const stop = sim.stop?.();
        if (stop) {
          let boundTimer: any;
          await Promise.race([
            Promise.resolve(stop).catch(() => {}),
            new Promise<void>((resolve) => {
              boundTimer = this.orig.setTimeout
                ? this.orig.setTimeout(resolve, 3_000)
                : (globalThis as any).setTimeout?.(() => resolve(), 3_000);
            }),
          ]);
          try { clearTimeout(boundTimer); } catch {}
        }
      } catch { /* already stopped */ }
      this.sims.delete(sim);
      (sim as any).__ddSessionSnap = null;
    }
    s.sims.clear();

    // 3. Tracked workers (belt — sims already stopped via step 2).
    for (const w of s.workers.values()) this.terminateTrackedWorker(w);
    s.workers.clear();

    // 4. Tracked listeners — cut event sources before dispose so pending
    //    "await next event" promises can't be re-armed mid-teardown.
    // Drain before iterating: listeners added through a doubly-wrapped
    // facade (e.g. globalThis.window forwarding to host.window) produce one
    // record per wrap level, and removing the outer record routes through
    // wrappedRemove, which splices s.listeners mid-iteration — forEach then
    // skips records, leaving `attached` wrappers in the persistent target's
    // listener set (pinning the dead generation's module graph).
    for (const l of s.listeners.splice(0)) {
      try { l.remove(); } catch { /* target gone */ }
    }

    // 5. Dispose chain (LIFO) — engine dispose()/onHotReloadDispose hooks
    //    land here. Bounded per-callback: a wedged dispose (dead worker RPC,
    //    stuck promise) must not hang the entire session teardown. The bound
    //    timer is CLEARED when the callback wins the race — otherwise it
    //    still fires 5s later and logs a false "timed out" warning.
    for (let i = s.disposeCallbacks.length - 1; i >= 0; i--) {
      const cb = s.disposeCallbacks[i];
      const cbName = (cb as any).name || `#${i}`;
      const cbSite = (cb as any).__ddSite ? ` — ${(cb as any).__ddSite}` : "";
      let boundTimer: any;
      const bound = new Promise<void>((resolve) => {
        boundTimer = this.orig.setTimeout
          ? this.orig.setTimeout(() => {
              log.warn("hmr-session", `dispose callback ${cbName} timed out (5s) — continuing teardown${cbSite}`);
              resolve();
            }, 5_000)
          : (globalThis as any).setTimeout?.(() => resolve(), 5_000);
      });
      try {
        const outcome = cb();
        if (outcome && typeof (outcome as Promise<void>).then === "function") {
          await Promise.race([Promise.resolve(outcome).catch((e) => {
            log.warn("hmr-session", `dispose callback threw: ${(e as Error).message}`);
          }), bound]);
        }
      } catch (e) {
        log.warn("hmr-session", `dispose callback threw: ${(e as Error).message}`);
      } finally {
        // Disarm the bound — the callback settled (or threw) before 5s.
        try { this.orig.setTimeout && clearTimeout(boundTimer); } catch {}
      }
    }
    // Release the callback refs — a snapshot pinned by an escaped retainer
    // must not drag every dispose closure's env (module graph) with it.
    s.disposeCallbacks.length = 0;
    // Meta providers likewise belong to the old graph — the pending save
    // (pendingStateJson) keeps their data until the next session registers
    // fresh providers and restores via registerMetaProvider. Only drop the
    // snapshot's own — a racing reimport's providers must survive.
    for (const provider of s.metaProviders.values()) {
      this.metaProviders.delete(provider);
      (provider as any).__ddSessionSnap = null;
    }
    s.metaProviders.clear();

    // 5b. `.lost` watchers on ALL live devices — a shared/persistent host
    //     device accumulates every generation's `device.lost.then()` reaction
    //     (the promise never resolves while the device is healthy), and each
    //     reaction pins its session's renderer + module graph. Clearing is
    //     safe: dead-session handlers are exactly what must never fire; the
    //     next session's renderer re-subscribes on init.
    for (const d of getLiveDevices()) {
      try { (d as any).__ddClearLostWatchers?.(); } catch { /* older device */ }
    }

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
    // Drain before iterating: listeners added through a doubly-wrapped
    // facade (e.g. globalThis.window forwarding to host.window) produce one
    // record per wrap level, and removing the outer record routes through
    // wrappedRemove, which splices s.listeners mid-iteration — forEach then
    // skips records, leaving `attached` wrappers in the persistent target's
    // listener set (pinning the dead generation's module graph).
    for (const l of s.listeners.splice(0)) {
      try { l.remove(); } catch { /* target gone */ }
    }
    for (const id of s.timeouts.values()) {
      if (!this.baseline.timeouts.has(id)) { try { clearTimeout(id); } catch {} }
    }
    for (const id of s.intervals.values()) {
      if (!this.baseline.intervals.has(id)) { try { clearInterval(id); } catch {} }
    }
    for (const id of s.immediates.values()) {
      if (!this.baseline.immediates.has(id)) { try { (globalThis as any).clearImmediate?.(id); } catch {} }
    }
    for (const id of s.rafIds.values()) {
      try { (globalThis as any).cancelAnimationFrame?.(id); } catch {}
    }
    for (const w of s.workers.values()) this.terminateTrackedWorker(w);
    s.workers.clear();

    // A cursor grab is session-owned too — the window/surface outlive the
    // session, so a lock held at teardown would otherwise carry into the
    // next session (fresh game boots with a trapped invisible cursor).
    // exitPointerLock also resets pointerLockElement + inputGrabWanted.
    try {
      const host = this.host;
      if (host?.surface?.pointerLocked) host.surface.exitPointerLock();
      else host?.window?.grabInput?.(false);
    } catch { /* best-effort */ }

    // A newer session may already be live (reimport raced a slow teardown)
    // — only clear if the pointer still names this snapshot.
    if (this.session === s) this.session = null;

    // Dump persistent collection state — anything still holding
    // dead-generation objects (sims, providers, restored hosts) leaks the
    // whole module graph via unmodeled Set/Map storage.
    try {
      const simInfo = [...this.sims].map((sim) =>
        `${sim.label ?? "?"}(snap=${(sim as any).__ddSessionSnap ? "live" : "dead/none"})`).join(",");
      log.info("session-tracker",
        `teardown done — sims=${this.sims.size} [${simInfo}] metaProviders=${this.metaProviders.size}` +
        ` restoredHosts=${this.restoredHosts.size} zombies=t${this.zombies.timeouts.size}/i${this.zombies.intervals.size}/im${this.zombies.immediates.size}`);
    } catch { /* diag only */ }
  }

  /**
   * Host-internal scheduling that must survive session teardown. The
   * NativeWindow run loop reschedules itself every iteration — routing it
   * through the wrapped setImmediate would let teardown cancel the event
   * pump entirely (dead window: no RAF dispatch, no SDL input, stale frame).
   */
  untrackedImmediate(fn: () => void): void {
    if (this.orig.setImmediate) { this.orig.setImmediate(fn); return; }
    this.orig.setTimeout?.(fn, 0);
  }

  /**
   * Host/supervisor-internal delayed scheduling that must survive session
   * teardown — e.g. bound timers on shutdown-critical awaits. A plain
   * setTimeout registers into the live session and teardown cancels it,
   * which silently disables whatever bound it was meant to enforce.
   * Returns the raw platform timer id; pair with untrackedClear().
   */
  untrackedTimeout(fn: () => void, ms: number): any {
    const schedule = this.orig.setTimeout ?? (globalThis as any).setTimeout;
    return schedule?.(fn, ms);
  }

  /** Clear an untrackedTimeout handle — the wrapped clearTimeout works here
   *  too (it removes the id from the session set, where it never was, then
   *  delegates to the platform clear). */
  untrackedClear(id: any): void {
    (globalThis as any).clearTimeout?.(id);
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

    // A registration into a dead/absent session escapes teardown
    // entirely — intervals stay armed, listeners stay attached, pinning the
    // dead module graph. Log the callsite (rate-limited) to find the leak.
    const orphanLog: Record<string, number> = (g.__ddOrphanLog ??= {});
    const warnOrphan = (kind: string) => {
      try {
        const n = (orphanLog[kind] = (orphanLog[kind] ?? 0) + 1);
        if (n <= 5) {
          const site = (new Error().stack ?? "").split("\n").slice(2, 6).map((l) => l.trim()).join(" | ");
          log.warn("session-tracker", `${kind} registered with no live session — escapes teardown (x${n}) — ${site}`);
        }
      } catch {}
    };
    if (typeof g.setTimeout === "function") {
      this.orig.setTimeout = g.setTimeout;
      const origClear = g.clearTimeout?.bind(g);
      g.setTimeout = function (fn: any, ms?: number, ...rest: any[]) {
        const s = self.session;
        // Wrap the callback with a self-disarm: if the owning snapshot dies
        // before the timer fires, the callback clears itself instead of
        // running dead-gen code. This is the belt under the set bookkeeping —
        // a timer that escaped s.timeouts/zombies still can't outlive its
        // generation by more than one fire. WeakRef: a strong capture of `s`
        // would let any armed/retained handle (e.g. Vite's crawl-end finder
        // keeps timeoutHandle forever) pin the whole dead snapshot.
        let id: any;
        const sref = s ? new WeakRef(s) : null;
        const wrappedFn = typeof fn === "function" && sref
          ? (...a: any[]) => {
              const ss = sref.deref();
              if (!ss || ss.dead) { try { origClear?.(id); } catch {} return; }
              return fn(...a);
            }
          : fn;
        id = self.orig.setTimeout(wrappedFn, ms, ...rest);
        if (s && !s.dead) s.timeouts.add(id);
        else if (s?.dead) { self.zombies.timeouts.add(id); warnOrphan("setTimeout(dead-session)"); }
        else self.zombies.timeouts.add(id);
        return id;
      };
      g.clearTimeout = function (id: any) {
        self.zombies.timeouts.delete(id);
        if (self.session) self.session.timeouts.delete(id);
        return origClear?.(id);
      };
    }
    if (typeof g.setInterval === "function") {
      this.orig.setInterval = g.setInterval;
      const origClear = g.clearInterval?.bind(g);
      g.setInterval = function (fn: any, ms?: number, ...rest: any[]) {
        const s = self.session;
        let id: any;
        const sref = s ? new WeakRef(s) : null;
        const wrappedFn = typeof fn === "function" && sref
          ? (...a: any[]) => {
              const ss = sref.deref();
              if (!ss || ss.dead) { try { origClear?.(id); } catch {} return; }
              return fn(...a);
            }
          : fn;
        id = self.orig.setInterval(wrappedFn, ms, ...rest);
        if (s && !s.dead) s.intervals.add(id);
        // Intervals are immortal until cleared — dead-session and
        // no-session registrations alike must never survive teardown.
        else if (s?.dead) { self.zombies.intervals.add(id); warnOrphan("setInterval(dead-session)"); }
        else self.zombies.intervals.add(id);
        return id;
      };
      g.clearInterval = function (id: any) {
        self.zombies.intervals.delete(id);
        if (self.session) self.session.intervals.delete(id);
        return origClear?.(id);
      };
    }
    if (typeof g.setImmediate === "function") {
      this.orig.setImmediate = g.setImmediate;
      const origClear = g.clearImmediate?.bind(g);
      g.setImmediate = function (fn: any, ...rest: any[]) {
        const id = self.orig.setImmediate(fn, ...rest);
        const s = self.session;
        if (s && !s.dead) s.immediates.add(id);
        else if (s?.dead) { self.zombies.immediates.add(id); warnOrphan("setImmediate(dead-session)"); }
        else self.zombies.immediates.add(id);
        return id;
      };
      g.clearImmediate = function (id: any) {
        self.zombies.immediates.delete(id);
        if (self.session) self.session.immediates.delete(id);
        return origClear?.(id);
      };
    }
    this.__warnOrphan = warnOrphan;
  }

  /**
   * Wrap `downdraft.onXxx(cb)` subscription methods on the persistent host
   * bridge so every returned unsubscribe lands in the live session's listener
   * list. Without this, each session's bootstrap/module code registers
   * callbacks into the bridge's emitter registry — host-level and therefore
   * immortal — and every one pins its session's closure env (renderer, ctx,
   * the whole module graph) forever. Idempotent per bridge object (a host
   * restart installs a fresh bridge that gets wrapped on its own attach).
   */
  trackBridgeSubscriptions(): void {
    const bridge = (globalThis as any).downdraft;
    if (!bridge || bridge.__ddOnWrapped) return;
    try { bridge.__ddOnWrapped = true; } catch { return; }
    const self = this;
    for (const key of Object.keys(bridge)) {
      if (!key.startsWith("on") || key.length < 3 || key[2] !== key[2].toUpperCase()) continue;
      const fn = bridge[key];
      if (typeof fn !== "function") continue;
      bridge[key] = function (this: any, ...args: any[]) {
        const s = self.session;
        // Dead or null session: don't register onto the persistent bridge at
        // all — the subscription would be untracked and pin the dead module
        // graph forever (stale continuations legitimately reach here when a
        // teardown races an in-flight boot; all real subscribers run inside
        // a live session).
        if (!s || s.dead) {
          self.__warnOrphan?.(`bridge:${key}(${s ? "dead" : "null"}-session)`);
          return undefined;
        }
        // Self-disarm: if the owning snapshot dies before the unsubscribe is
        // collected, the first event calls it instead of the dead-gen
        // callback. WeakRef — a strong `s` capture would pin the dead
        // snapshot through the persistent bridge's emitter registry.
        let off: any;
        if (s && typeof args[0] === "function") {
          const cb = args[0];
          const sref = new WeakRef(s);
          args = [...args];
          args[0] = function (this: any, ...a: any[]) {
            const ss = sref.deref();
            if (!ss || ss.dead) { try { off?.(); } catch {} return; }
            return cb.apply(this, a);
          };
        }
        off = fn.apply(this, args);
        // Only track functions — subscription APIs return an unsubscribe,
        // anything else (promise, void) isn't a listener registration.
        if (typeof off === "function" && s) {
          s.listeners.push({
            type: `bridge:${key}`,
            listener: args[0],
            remove: () => { try { off(); } catch { /* already gone */ } },
          });
        }
        return off;
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
        const s = self.session;
        // No live session: drop the frame. Session rAF users are re-arming
        // loops (render loop, frameSync) — scheduling with a dead session or
        // in the null-session gap produces an immortal ghost loop whose
        // callback env pins the entire dead module graph (renderer → sim →
        // workers) forever. Host-internal rAF goes through window.rAF, not
        // this global, so nothing legit is dropped here.
        if (!s || s.dead) { self.__warnOrphan?.("requestAnimationFrame(dead/null-session)"); return -1; }
        const id = origRaf(cb);
        s.rafIds.add(id);
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
      const s = self.session;
      // Dead session: do NOT attach. Targets here are persistent (window,
      // surface, document) — a dead-session listener would stay natively
      // attached forever, firing into a dead module graph and pinning it.
      if (s?.dead) {
        self.__warnOrphan?.(`listener:${type}(dead-session)`);
        return;
      }
      // Self-disarm: if the owning snapshot dies and this listener somehow
      // escaped the tracked sweep, the first delivered event detaches it and
      // drops the call instead of running dead-gen code. WeakRef on `s` so an
      // unattached-in-time straggler doesn't pin the dead snapshot itself.
      let attached = listener;
      if (typeof listener === "function" && s) {
        const sref = new WeakRef(s);
        attached = function (this: any, ...a: any[]) {
          const ss = sref.deref();
          if (!ss || ss.dead) { try { origRemove?.(type, attached, opts); } catch {} return; }
          return listener.apply(this, a);
        };
      }
      origAdd(type, attached, opts);
      if (s) {
        s.listeners.push({
          type,
          listener,
          remove: () => { try { origRemove?.(type, attached, opts); } catch {} },
        });
      }
      // No session (pre-first-session host boot): attach untracked — those
      // registrations are host-internal and must persist.
    };
    (wrappedAdd as any).__ddTracked = true;
    try {
      target.addEventListener = wrappedAdd;
      if (origRemove) {
        target.removeEventListener = function (type: string, listener: any, opts?: any) {
          const s = self.session;
          // The target holds the wrapped callback — resolve through the
          // tracking record so the correct function gets detached.
          if (s) {
            for (let j = s.listeners.length - 1; j >= 0; j--) {
              const l = s.listeners[j];
              if (l.type === type && l.listener === listener) { l.remove(); s.listeners.splice(j, 1); return; }
            }
          }
          origRemove(type, listener, opts);
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
/** Brand marker — this module re-evaluates on every dev session restart,
 *  so `instanceof SessionTracker` fails against a tracker created by the
 *  previous eval's class object. Without the brand check each restart
 *  installs a new tracker whose global wraps chain over the old ones while
 *  the ALREADY-wrapped event targets keep routing to the dead tracker
 *  (`__ddTracked` skip) — every listener registered from session 2 onward
 *  is then silently untracked and never removed at teardown. */
const TRACKER_BRAND = "__ddSessionTrackerBrand";

/** Install (or fetch) the global session tracker. Idempotent across re-evals. */
export function installSessionTracker(): SessionTracker {
  const g = globalThis as any;
  const existing = g[SESSION_KEY];
  if (existing && existing[TRACKER_BRAND] === true) return existing;
  const tracker = new SessionTracker();
  (tracker as any)[TRACKER_BRAND] = true;
  tracker.installGlobalWraps();
  g[SESSION_KEY] = tracker;
  return tracker;
}

/** Current session tracker (null outside the dev shell). */
export function getSessionTracker(): SessionTracker | null {
  return (globalThis as any)[SESSION_KEY] ?? null;
}
