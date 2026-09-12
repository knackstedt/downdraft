// ============================================================================
// Plugin context — the tiered capability surface exposed to a plugin.
//
// A plugin's `register(ctx)` receives a context whose shape depends on its
// declared tier:
//   - `data`   → no context (asset plugins just register assets at load).
//   - `script` → ScriptPluginContext (events + KV state + tick + log).
//   - `native` → NativePluginContext (extends ModuleContext-shape: ECS
//                systems/components, typed-token provide/inject, SAB channels,
//                onDispose, devtools). GPU/render-pass access is deferred.
//
// The host constructs the appropriate facade and the TypeScript types ensure
// a script-tier plugin literally cannot call native-only APIs (the methods
// aren't on the narrower type). At runtime the facade simply doesn't expose
// them.
//
// For worker-js / wasm / quickjs plugins that run off-thread or in a VM,
// `ctx` is a `MessageChannel`- / marshal-backed proxy to the host's real
// context object. The interfaces below are the contract both sides share.
// ============================================================================

import type { ComponentId } from "../ecs/component";
import type { ResourceToken } from "../ecs/resource";
import type { Stage, SystemFn } from "../ecs/system";
import type { ModuleDevToolsAPI, SABChannel } from "../module/module";

// ── Event bus ──

/**
 * Game-defined event catalog. A game publishes a set of named events with
 * typed payloads that plugins may subscribe to / publish. The host validates
 * event names against this catalog (if provided) and rejects unknown events.
 */
export type PluginEventCatalog = Record<string, unknown>;

export type PluginEventHandler<E = unknown> = (data: E) => void;

export interface PluginEventBus {
  subscribe<E>(event: string, handler: PluginEventHandler<E>): () => void;
  publish<E>(event: string, data: E): void;
}

// ── Per-plugin KV state store ──

export interface PluginStateStore {
  get<T = unknown>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  keys(): string[];
  /** Persist current state to OPFS (only if `storage` permission granted). */
  save(): Promise<void>;
  /** Reload persisted state. */
  load(): Promise<void>;
}

// ── Logger ──

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ── Tick budget ──

/**
 * Register a per-frame tick callback. The host enforces a per-tick time
 * budget (worker-js: setTimeout watchdog; quickjs: interrupt handler). A
 * callback that overruns its budget is terminated and the plugin is unloaded
 * with an error reported to the doctor panel.
 */
export interface PluginTickApi {
  onTick(fn: (dt: number, elapsedTime: number) => void): () => void;
}

// ── Script tier context ──

export interface ScriptPluginContext {
  readonly id: string;
  readonly events: PluginEventBus;
  readonly state: PluginStateStore;
  readonly tick: PluginTickApi;
  readonly log: PluginLogger;
  onDispose(fn: () => void): void;
}

// ── Host-call bridge (game mutation API) ──
//
// Logic extensions (worker-js / wasm) mutate the game through a set of bridged
// host calls rather than touching renderer/sim internals directly. The game
// implements `PluginHostCalls` and injects it into the PluginHost; the host
// exposes the methods on `NativePluginContext`. Each call is gated by a
// permission (physics / assets / ecs). The bridge is game-agnostic — the host
// just forwards to the injected implementation.

/** A spawned prop descriptor (returned by spawnProp). */
export interface SpawnedProp {
  entityId: number;
}

/** Descriptor for spawning a prop via host call. */
export interface SpawnPropDesc {
  /** Content id of the prop to spawn (e.g. "my-mod:crate"). */
  contentId: string;
  /** World position [x, y, z]. */
  position: [number, number, number];
  /** Optional rotation quaternion [x, y, z, w]. Default: identity. */
  rotation?: [number, number, number, number];
  /** Optional scale. Default: 1. */
  scale?: number;
}

/** Descriptor for setting physics properties on a body. */
export interface PhysicsDesc {
  mass: number;
  restitution: number;
  friction: number;
  gravityScale: number;
}

/** The game-implemented host-call bridge. Injected into PluginHostOptions.
 *  All methods are optional — a game that doesn't support physics mutation
 *  simply omits them, and the host throws a clear error if a plugin calls one. */
export interface PluginHostCalls {
  /** Spawn a prop by content id at a world transform. Returns the entity id.
   *  Requires the `assets` + `ecs` permissions. */
  spawnProp?(desc: SpawnPropDesc): Promise<SpawnedProp>;
  /** Remove a spawned prop by entity id. Requires `ecs`. */
  removeProp?(entityId: number): Promise<void>;
  /** Set physics properties on a body. Requires `physics`. */
  setPhysics?(entityId: number, desc: Partial<PhysicsDesc>): Promise<void>;
  /** Get physics properties of a body. Requires `physics`. */
  getPhysics?(entityId: number): Promise<PhysicsDesc>;
  /** Apply a linear impulse to a body. Requires `physics`. */
  applyImpulse?(entityId: number, impulse: [number, number, number]): Promise<void>;
  /** Apply a torque to a body. Requires `physics`. */
  applyTorque?(entityId: number, torque: [number, number, number]): Promise<void>;
  /** Resolve an asset id to an opaque handle the plugin can pass back to host
   *  calls. Requires `assets`. The handle is a stable integer. */
  getAssetRef?(assetId: string): Promise<number>;
}

// ── Native tier context ──
//
// Mirrors ModuleContext (ECS + typed DI + SAB + devtools + dispose) so a
// native plugin can register systems, provide/inject typed tokens, and
// allocate SAB channels exactly like a compile-time module. The host bridges
// these calls into the real ModuleHost on the plugin's thread.
//
// Also exposes the host-call bridge (spawnProp, setPhysics, etc.) for game
// mutation. These are gated by permissions and forwarded to the game's
// PluginHostCalls implementation.

export interface NativePluginContext extends ScriptPluginContext {
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: SystemFn): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  provide<T>(token: ResourceToken<T>, value: T): void;
  inject<T>(token: ResourceToken<T>): T;
  injectOptional<T>(token: ResourceToken<T>): T | undefined;
  readonly devtools: ModuleDevToolsAPI;
  // ── Host-call bridge (game mutation) ──
  spawnProp(desc: SpawnPropDesc): Promise<SpawnedProp>;
  removeProp(entityId: number): Promise<void>;
  setPhysics(entityId: number, desc: Partial<PhysicsDesc>): Promise<void>;
  getPhysics(entityId: number): Promise<PhysicsDesc>;
  applyImpulse(entityId: number, impulse: [number, number, number]): Promise<void>;
  applyTorque(entityId: number, torque: [number, number, number]): Promise<void>;
  getAssetRef(assetId: string): Promise<number>;
}

// ── Plugin definition (the shape a plugin's entry module exports) ──

export type PluginRegisterFn<C extends ScriptPluginContext = ScriptPluginContext> = (
  ctx: C,
) => void | Promise<void>;

/**
 * A plugin's entry module default-exports this (or the module itself is the
 * function). The host calls `register(ctx)` after sandboxing + context setup.
 *
 * For `native` tier the host passes a `NativePluginContext`; for `script`
 * tier a `ScriptPluginContext`. The plugin author types its entry against the
 * tier it declared.
 */
export interface PluginEntry<C extends ScriptPluginContext = ScriptPluginContext> {
  register: PluginRegisterFn<C>;
  /** Optional: declare resources this plugin provides/requires at the typed
   *  token level (in addition to the stringly-typed manifest provides/requires). */
  provides?: ResourceToken<unknown>[];
  requires?: ResourceToken<unknown>[];
}

// ── Tiered facade factory ──
//
// The host builds the appropriate context object. These factory signatures
// let the host code stay type-safe while returning the narrower type for
// script-tier plugins.

export interface PluginContextBacking {
  id: string;
  events: PluginEventBus;
  state: PluginStateStore;
  tick: PluginTickApi;
  log: PluginLogger;
  // native-only backing (undefined for script tier):
  registerComponent?: <T>(name: string, schema: T) => ComponentId;
  registerSystem?: (stage: Stage, system: SystemFn) => void;
  allocateSABChannel?: (name: string, size: number) => SABChannel;
  provide?: <T>(token: ResourceToken<T>, value: T) => void;
  inject?: <T>(token: ResourceToken<T>) => T;
  injectOptional?: <T>(token: ResourceToken<T>) => T | undefined;
  devtools?: ModuleDevToolsAPI;
  // host-call bridge (game mutation). Undefined when the game didn't inject
  // a PluginHostCalls impl; calling a host-call method then throws.
  hostCalls?: PluginHostCalls;
  onDispose: (fn: () => void) => void;
}

/** Build a ScriptPluginContext facade from the backing object. */
export function makeScriptContext(b: PluginContextBacking): ScriptPluginContext {
  return {
    id: b.id,
    events: b.events,
    state: b.state,
    tick: b.tick,
    log: b.log,
    onDispose: b.onDispose,
  };
}

/** Build a NativePluginContext facade. Throws if native backing is missing. */
export function makeNativeContext(b: PluginContextBacking): NativePluginContext {
  if (
    !b.registerComponent ||
    !b.registerSystem ||
    !b.allocateSABChannel ||
    !b.provide ||
    !b.inject ||
    !b.injectOptional ||
    !b.devtools
  ) {
    throw new Error(
      `makeNativeContext: backing is missing native APIs (plugin "${b.id}" declared native tier but host didn't wire them).`,
    );
  }
  return {
    id: b.id,
    events: b.events,
    state: b.state,
    tick: b.tick,
    log: b.log,
    onDispose: b.onDispose,
    registerComponent: b.registerComponent,
    registerSystem: b.registerSystem,
    allocateSABChannel: b.allocateSABChannel,
    provide: b.provide,
    inject: b.inject,
    injectOptional: b.injectOptional,
    devtools: b.devtools,
    // Host-call bridge: forward to the game's PluginHostCalls impl. Each
    // method throws a clear error if the game didn't wire host calls.
    spawnProp: (d) => b.hostCalls?.spawnProp
      ? b.hostCalls.spawnProp(d)
      : Promise.reject(new Error(`spawnProp: no host-call bridge wired (plugin "${b.id}")`)),
    removeProp: (id) => b.hostCalls?.removeProp
      ? b.hostCalls.removeProp(id)
      : Promise.reject(new Error(`removeProp: no host-call bridge wired (plugin "${b.id}")`)),
    setPhysics: (id, d) => b.hostCalls?.setPhysics
      ? b.hostCalls.setPhysics(id, d)
      : Promise.reject(new Error(`setPhysics: no host-call bridge wired (plugin "${b.id}")`)),
    getPhysics: (id) => b.hostCalls?.getPhysics
      ? b.hostCalls.getPhysics(id)
      : Promise.reject(new Error(`getPhysics: no host-call bridge wired (plugin "${b.id}")`)),
    applyImpulse: (id, i) => b.hostCalls?.applyImpulse
      ? b.hostCalls.applyImpulse(id, i)
      : Promise.reject(new Error(`applyImpulse: no host-call bridge wired (plugin "${b.id}")`)),
    applyTorque: (id, t) => b.hostCalls?.applyTorque
      ? b.hostCalls.applyTorque(id, t)
      : Promise.reject(new Error(`applyTorque: no host-call bridge wired (plugin "${b.id}")`)),
    getAssetRef: (a) => b.hostCalls?.getAssetRef
      ? b.hostCalls.getAssetRef(a)
      : Promise.reject(new Error(`getAssetRef: no host-call bridge wired (plugin "${b.id}")`)),
  };
}
