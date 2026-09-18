// ============================================================================
// WASM plugin ABI v3 — the contract between the host and WASM plugin modules.
//
// WASM plugins always run in their own dedicated worker (stability isolation).
// The ABI uses WebAssembly linear memory for string/data passing:
//   - The host provides an `env` import module with functions for logging,
//     state access, event publishing, and game mutation (host calls).
//   - The plugin exports `register`, and optionally `tick`, `dispose`,
//     `on_event`, and `alloc` (for the host to allocate strings in the
//     plugin's memory).
//
// v3 adds host-call imports for game mutation (spawn_prop, remove_prop,
// set_physics, get_physics, apply_impulse, apply_torque, get_asset_ref).
// These are async on the host side (forwarded to the game's PluginHostCalls);
// the host-call imports return a u32 request id, and the host posts the
// result back via the `on_host_call_result` export (ptr+len for JSON result,
// or 0 for void / error). v2 imports are unchanged — a v2 plugin works as-is.
//
// All string/data passing uses (ptr, len) pairs into the plugin's linear
// memory. The host calls `alloc(size)` to get a pointer, writes the data,
// then calls the plugin function.
// ============================================================================

/** ABI version — incremented on breaking changes. v3 adds host-call imports. */
export const WASM_PLUGIN_ABI_VERSION = 3;

/** Host-provided import module (the `env` namespace). */
export interface WasmPluginImports {
  env: {
    /** Log functions: (str_ptr, str_len) → void */
    log_info: (ptr: number, len: number) => void;
    log_warn: (ptr: number, len: number) => void;
    log_error: (ptr: number, len: number) => void;
    log_debug: (ptr: number, len: number) => void;
    /** State: get(key_ptr, key_len) → value_ptr (0 if not found).
     *  The value length is stored at [value_ptr-4] as a u32. */
    state_get: (keyPtr: number, keyLen: number) => number;
    /** State: set(key_ptr, key_len, val_ptr, val_len) → void */
    state_set: (keyPtr: number, keyLen: number, valPtr: number, valLen: number) => void;
    /** State: delete(key_ptr, key_len) → void */
    state_delete: (keyPtr: number, keyLen: number) => void;
    /** Events: publish(name_ptr, name_len, data_ptr, data_len) → void */
    event_publish: (namePtr: number, nameLen: number, dataPtr: number, dataLen: number) => void;
    /** Events: subscribe(name_ptr, name_len) → subscription_id (u32).
     *  The host calls `on_event(sub_id, data_ptr, data_len)` when the event fires. */
    event_subscribe: (namePtr: number, nameLen: number) => number;
    /** Events: unsubscribe(sub_id) → void */
    event_unsubscribe: (subId: number) => void;
    // ── Host-call bridge (v3): game mutation ──
    // Each returns a u32 request id. The host calls `on_host_call_result`
    // (export) with the result when the async host call completes.
    /** Spawn a prop: (content_id_ptr, content_id_len, x, y, z, qx, qy, qz, qw, scale) → request_id.
     *  Result: JSON { entityId } or { error }. */
    spawn_prop: (
      contentIdPtr: number, contentIdLen: number,
      x: number, y: number, z: number,
      qx: number, qy: number, qz: number, qw: number,
      scale: number,
    ) => number;
    /** Remove a prop: (entity_id) → request_id. Result: void or { error }. */
    remove_prop: (entityId: number) => number;
    /** Set physics: (entity_id, mass, restitution, friction, gravity_scale) → request_id.
     *  Pass NaN for any field to leave it unchanged. Result: void or { error }. */
    set_physics: (
      entityId: number, mass: number, restitution: number, friction: number, gravityScale: number,
    ) => number;
    /** Get physics: (entity_id) → request_id. Result: JSON { mass, restitution, friction, gravityScale }. */
    get_physics: (entityId: number) => number;
    /** Apply impulse: (entity_id, x, y, z) → request_id. Result: void or { error }. */
    apply_impulse: (entityId: number, x: number, y: number, z: number) => number;
    /** Apply torque: (entity_id, x, y, z) → request_id. Result: void or { error }. */
    apply_torque: (entityId: number, x: number, y: number, z: number) => number;
    /** Get asset ref: (asset_id_ptr, asset_id_len) → request_id. Result: JSON { handle } or { error }. */
    get_asset_ref: (assetIdPtr: number, assetIdLen: number) => number;
  };
}

/** Plugin module exports (resolved after instantiation). */
export interface WasmPluginExports {
  /** Allocate `size` bytes in the plugin's linear memory. Returns a pointer. */
  alloc: (size: number) => number;
  /** Called once on load. The plugin can register systems, subscribe to events, etc. */
  register: () => void;
  /** Called every tick (if present). dt + elapsedTime in seconds. */
  tick?: (dt: number, elapsedTime: number) => void;
  /** Called on unload (if present). */
  dispose?: () => void;
  /** Called when a subscribed event fires (if present).
   *  sub_id matches the id returned by `env.event_subscribe`. */
  on_event?: (subId: number, dataPtr: number, dataLen: number) => void;
  /** Called when a host-call (v3) completes (if present).
   *  request_id matches the id returned by the host-call import.
   *  resultPtr/resultLen point to a JSON result string (or 0,0 for void).
   *  errorPtr/errorLen point to an error string (or 0,0 on success). */
  on_host_call_result?: (
    requestId: number,
    resultPtr: number, resultLen: number,
    errorPtr: number, errorLen: number,
  ) => void;
  /** The plugin's linear memory (for reading/writing strings). */
  memory?: WebAssembly.Memory;
}

/** Helper: write a string into the plugin's linear memory.
 *  Returns [ptr, len] or null if alloc failed. */
export function writeStringToMemory(
  exports: WasmPluginExports,
  str: string,
): [number, number] | null {
  if (!exports.memory || !exports.alloc) return null;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const ptr = exports.alloc(bytes.length);
  if (ptr === 0) return null;
  const view = new Uint8Array(exports.memory.buffer, ptr, bytes.length);
  view.set(bytes);
  return [ptr, bytes.length];
}

/** Helper: read a string from the plugin's linear memory. */
export function readStringFromMemory(
  exports: WasmPluginExports,
  ptr: number,
  len: number,
): string {
  if (!exports.memory) return "";
  const view = new Uint8Array(exports.memory.buffer, ptr, len);
  return new TextDecoder().decode(view);
}

/** Helper: write a byte array into the plugin's linear memory. */
export function writeBytesToMemory(
  exports: WasmPluginExports,
  bytes: Uint8Array,
): [number, number] | null {
  if (!exports.memory || !exports.alloc) return null;
  const ptr = exports.alloc(bytes.length);
  if (ptr === 0) return null;
  const view = new Uint8Array(exports.memory.buffer, ptr, bytes.length);
  view.set(bytes);
  return [ptr, bytes.length];
}

/** Helper: read a byte array from the plugin's linear memory. */
export function readBytesFromMemory(
  exports: WasmPluginExports,
  ptr: number,
  len: number,
): Uint8Array {
  if (!exports.memory) return new Uint8Array(0);
  return new Uint8Array(exports.memory.buffer, ptr, len).slice();
}
