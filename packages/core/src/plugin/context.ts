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
import type { PluginPermission } from "./manifest";

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

// ── Permission gating ──
//
// When the host passes a `granted` permission set, context APIs the plugin
// didn't request are replaced with throwing stubs (matching the sandbox
// shim's trap style: clear error naming the missing permission). When
// `granted` is undefined the context is ungated — used by tests and by
// first-party in-process callers that bypass the permission system.

function permError(apiName: string, perm: PluginPermission, pluginId: string): Error {
  return new Error(
    `[downdraft:plugin] "${apiName}" requires the "${perm}" permission, which plugin "${pluginId}" was not granted ` +
      `(check permissions[] in the manifest — requested ∩ tier-allowed ∩ game-allowlist).`,
  );
}

function deniedEvents(perm: PluginPermission, id: string): PluginEventBus {
  return {
    subscribe: () => { throw permError("events.subscribe", perm, id); },
    publish: () => { throw permError("events.publish", perm, id); },
  };
}

function deniedState(perm: PluginPermission, id: string): PluginStateStore {
  return {
    get: () => { throw permError("state.get", perm, id); },
    set: () => { throw permError("state.set", perm, id); },
    delete: () => { throw permError("state.delete", perm, id); },
    keys: () => { throw permError("state.keys", perm, id); },
    save: () => Promise.reject(permError("state.save", perm, id)),
    load: () => Promise.reject(permError("state.load", perm, id)),
  };
}

function deniedTick(perm: PluginPermission, id: string): PluginTickApi {
  return {
    onTick: () => { throw permError("tick.onTick", perm, id); },
  };
}

/** Gate the state store: `state` perm gates KV access; `storage` gates persistence. */
function gateState(state: PluginStateStore, granted: ReadonlySet<PluginPermission> | undefined, id: string): PluginStateStore {
  if (!granted) return state;
  if (!granted.has("state")) return deniedState("state", id);
  if (!granted.has("storage")) {
    return {
      ...state,
      save: () => Promise.reject(permError("state.save", "storage", id)),
      load: () => Promise.reject(permError("state.load", "storage", id)),
    };
  }
  return state;
}

/** Build a ScriptPluginContext facade from the backing object. */
export function makeScriptContext(
  b: PluginContextBacking,
  granted?: ReadonlySet<PluginPermission>,
): ScriptPluginContext {
  return {
    id: b.id,
    events: granted && !granted.has("events") ? deniedEvents("events", b.id) : b.events,
    state: gateState(b.state, granted, b.id),
    tick: granted && !granted.has("tick") ? deniedTick("tick", b.id) : b.tick,
    log: b.log,
    onDispose: b.onDispose,
  };
}

/** Host-call method → permission(s) required to invoke it. */
const HOST_CALL_PERMS: Record<string, PluginPermission[]> = {
  spawnProp: ["assets", "ecs"],
  removeProp: ["ecs"],
  setPhysics: ["physics"],
  getPhysics: ["physics"],
  applyImpulse: ["physics"],
  applyTorque: ["physics"],
  getAssetRef: ["assets"],
};

/** Build a NativePluginContext facade. Throws if native backing is missing. */
export function makeNativeContext(
  b: PluginContextBacking,
  granted?: ReadonlySet<PluginPermission>,
): NativePluginContext {
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
  // Gate a host-call method: check the declared permission(s) first (a clear
  // permission error beats a missing-bridge error), then forward to the
  // game's PluginHostCalls impl.
  const hostCall = <A extends unknown[], R>(
    name: keyof PluginHostCalls,
  ): ((...args: A) => Promise<R>) => {
    return (...args: A) => {
      if (granted) {
        for (const perm of HOST_CALL_PERMS[name] ?? []) {
          if (!granted.has(perm)) {
            return Promise.reject(permError(name as string, perm, b.id));
          }
        }
      }
      const hostCalls = b.hostCalls;
      return hostCalls?.[name]
        ? (hostCalls[name] as (...a: A) => Promise<R>).apply(hostCalls, args)
        : Promise.reject(new Error(`${name as string}: no host-call bridge wired (plugin "${b.id}")`));
    };
  };
  return {
    id: b.id,
    events: granted && !granted.has("events") ? deniedEvents("events", b.id) : b.events,
    state: gateState(b.state, granted, b.id),
    tick: granted && !granted.has("tick") ? deniedTick("tick", b.id) : b.tick,
    log: b.log,
    onDispose: b.onDispose,
    registerComponent: b.registerComponent,
    registerSystem: b.registerSystem,
    allocateSABChannel: granted && !granted.has("sab")
      ? () => { throw permError("allocateSABChannel", "sab", b.id); }
      : b.allocateSABChannel,
    provide: b.provide,
    inject: b.inject,
    injectOptional: b.injectOptional,
    devtools: b.devtools,
    // Host-call bridge: permission-gated, then forwarded to the game's impl.
    spawnProp: hostCall<[SpawnPropDesc], SpawnedProp>("spawnProp"),
    removeProp: hostCall<[number], void>("removeProp"),
    setPhysics: hostCall<[number, Partial<PhysicsDesc>], void>("setPhysics"),
    getPhysics: hostCall<[number], PhysicsDesc>("getPhysics"),
    applyImpulse: hostCall<[number, [number, number, number]], void>("applyImpulse"),
    applyTorque: hostCall<[number, [number, number, number]], void>("applyTorque"),
    getAssetRef: hostCall<[string], number>("getAssetRef"),
  };
}
