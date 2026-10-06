// ============================================================================
// shared-device.ts — share the host's wgpu device with workers
//
// The wgpu shim's handles are process-global boxed pointers, and wgpu-core
// internally synchronizes device/queue access — so a device created on the
// main thread is safe to use from a worker thread (same address space,
// dlopen'd once). This module is the transfer protocol:
//
//   owner thread:  const cells = createDeviceStateCells();
//                  const handle = shareDevice(device, cells);
//                  worker.postMessage({ gpu: handle, cells: cells.sab });
//
//   worker:        const view = attachSharedDevice(msg.gpu, msg.cells);
//                  view.device.createTexture(...) / view.queue.submit(...)
//
// Ownership rules:
// - Only the OWNER (the thread that created the device, via
//   WgpuAdapter.requestDevice) may call device.destroy(). Worker attach is
//   non-owning: destroy() on the worker view is a local unwire, never a
//   native release.
// - Every FFI entry point on an attached view is guarded: once the owner
//   marks the device lost or requests detach (state cell flips), calls on
//   view.device / view.queue throw instead of dereferencing freed native
//   handles. Poll view.isValid() before encoding work; the guard is the
//   backstop, not the signal.
// - Worker-detach handshake: the owner calls retireSharedDevice(cells) before
//   destroying the device — it raises the detach request and waits for all
//   attached views to call view.detach(). This closes the check-then-call
//   window: no worker FFI call may be in flight when the handles are freed.
// - Command ordering is submission order: a worker's queue.submit()
//   interleaves with the owner's. For passes that must slot into the frame
//   graph, have the worker finish() encoders, hand the buffers back with
//   exportCommandBuffer(), and postMessage the refs to the owner thread for
//   submission (submitCommandPtrs / importCommandBuffer).
// - Resource handoff (textures/buffers/command buffers produced in the
//   worker, consumed on the owner): call exportGpuResource() / exportCommandBuffer()
//   before posting the ptr. Transfer clears the worker's GC-finalizer claim —
//   without it the handle gets released twice (worker's finalizer + owner's
//   submit/destroy), which aborts the process.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import { markTransferred, trackForRelease } from "./registry";
import { WgpuDevice, WgpuQueue } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";
import { WgpuCommandBuffer } from "./wgpu-resources";

const log = createLogger();

/**
 * Poll-tick for retireSharedDevice's wait loop. MUST route through the
 * session tracker's untracked channel under the dev shell: a plain
 * setTimeout registers into the live session and teardown cancels it —
* which wedges the retire promise forever and takes host.destroy() (and
 * with it the whole close path) down with it. That's a real hang, not
 * theoretical.
 */
function retireTick(fn: () => void): void {
  const tracker = (globalThis as any).__ddSession;
  if (typeof tracker?.untrackedImmediate === "function") {
    tracker.untrackedImmediate(fn);
    return;
  }
  if (typeof setImmediate === "function") setImmediate(fn);
  else setTimeout(fn, 1);
}

/** Serializes GPU-device liveness between owner thread and attached workers. */
export interface GpuDeviceHandle {
  /** Raw wgpu device handle (process-global boxed pointer). */
  devicePtr: ptr;
  /** Raw wgpu instance handle — needed for event pumping in the worker. */
  instancePtr: ptr;
  /** Raw wgpu queue handle (device_get_queue result). Retained for wire
   *  compat — attached views no longer wrap it; they hold their own
   *  device_get_queue clone so an owner-side release can never leave the
   *  worker holding a dangling queue box. */
  queuePtr: ptr;
  /** Handle generation — bumped when the owner re-creates the device after
   *  loss. Workers compare it against cell 0 and must re-attach on change. */
  generation: number;
}

/**
 * i64[4] view over a SharedArrayBuffer:
 *   [0] generation — bumped per shareDevice(); stale gens are rejected
 *   [1] alive      — 1 while the owner's device is live (pollLost writes 0)
 *   [2] detachReq  — 1 while the owner is retiring the device; workers must
 *                    stop submitting and call view.detach()
 *   [3] attached   — live attached-view count (attach/detach inc/dec)
 */
export interface DeviceStateCells {
  sab: SharedArrayBuffer;
  i64: BigInt64Array;
}

const CELL_GENERATION = 0;
const CELL_ALIVE = 1;
const CELL_DETACH_REQ = 2;
const CELL_ATTACHED = 3;

/** Every cell set created this session — lets host teardown retire/mark all
 *  shared devices without knowing which subsystem shared them. Cells leave
 *  the set when retireSharedDevice() settles (detached or timed out). */
const LIVE_CELLS = new Set<SharedArrayBuffer>();

export function createDeviceStateCells(generation = 1): DeviceStateCells {
  const sab = new SharedArrayBuffer(32);
  const i64 = new BigInt64Array(sab);
  Atomics.store(i64, CELL_GENERATION, BigInt(generation));
  Atomics.store(i64, CELL_ALIVE, 1n);
  Atomics.store(i64, CELL_DETACH_REQ, 0n);
  Atomics.store(i64, CELL_ATTACHED, 0n);
  LIVE_CELLS.add(sab);
  return { sab, i64 };
}

/**
 * Publish a device handle for worker attach. `cells` is created once per
 * host and reused across generations — on device loss the owner calls
 * markDeviceLost(cells) (or relies on WgpuDevice.pollLost, which writes it
 * automatically when sharedState is set) and on recreation calls
 * shareDevice() again, which bumps the generation.
 */
export function shareDevice(device: WgpuDevice, cells: DeviceStateCells): GpuDeviceHandle {
  const generation = Number(Atomics.load(cells.i64, CELL_GENERATION)) + 1;
  Atomics.store(cells.i64, CELL_GENERATION, BigInt(generation));
  Atomics.store(cells.i64, CELL_ALIVE, 1n);
  Atomics.store(cells.i64, CELL_DETACH_REQ, 0n);
  device.sharedState = cells.i64;
  device.sharedStateGen = BigInt(generation);
  return {
    devicePtr: device.ptr,
    instancePtr: device.getInstancePtr(),
    queuePtr: device.queue.ptr,
    generation,
  };
}

/** Explicitly mark the shared device dead (also written by WgpuDevice.pollLost). */
export function markDeviceLost(cells: DeviceStateCells): void {
  Atomics.store(cells.i64, CELL_ALIVE, 0n);
}

export function sharedDeviceAlive(cells: DeviceStateCells | SharedArrayBuffer): boolean {
  const i64 = cells instanceof SharedArrayBuffer ? new BigInt64Array(cells) : cells.i64;
  return Atomics.load(i64, CELL_ALIVE) === 1n;
}

/**
 * Owner-side teardown handshake. Raises the detach request and marks the
 * device dead, then waits for every attached worker view to call
 * view.detach(). Resolves true once no worker holds the device — the owner
 * may then safely device.destroy() with no FFI call in flight on the freed
 * handles. Resolves false on timeout: a worker blocked inside a bounded FFI
 * wait (maps/work-done can take seconds under device loss) hasn't acked —
 * either keep waiting or proceed knowing the shim's release of a busy handle
 * is the remaining risk. Poll-style polling, not Atomics.wait — the owner's
 * event loop must stay live for the workers' detach to be observable anyway
 * (workers typically detach from a posted teardown message, not polling).
 */
export async function retireSharedDevice(
  cells: DeviceStateCells | SharedArrayBuffer,
  timeoutMs = 5000,
): Promise<boolean> {
  const sab = cells instanceof SharedArrayBuffer ? cells : cells.sab;
  const i64 = cells instanceof SharedArrayBuffer ? new BigInt64Array(cells) : cells.i64;
  Atomics.store(i64, CELL_DETACH_REQ, 1n);
  Atomics.store(i64, CELL_ALIVE, 0n);
  const deadline = performance.now() + timeoutMs;
  try {
    while (Atomics.load(i64, CELL_ATTACHED) > 0n) {
      if (performance.now() >= deadline) {
        const stuck = Atomics.load(i64, CELL_ATTACHED);
        log.warn("shared-device", `retireSharedDevice: ${stuck} worker view(s) still attached after ${timeoutMs}ms`);
        return false;
      }
      await new Promise<void>((r) => retireTick(r));
    }
    return true;
  } finally {
    // Retired (detached or gave up) — a second retire pass shouldn't wait on
    // this set again (a force-killed worker's attach count never reaches 0).
    LIVE_CELLS.delete(sab);
  }
}

/**
 * Synchronous kill-switch for every registered cell set: raises the detach
 * request and marks the device dead on all of them at once. Called by host
 * teardown before freeing device/instance handles so workers that never
 * detached can't *start* a new FFI call on released handles (in-flight calls
 * are still governed by retireSharedDevice's bounded wait).
 */
export function markAllSharedDevicesDead(): void {
  LIVE_CELLS.forEach((sab) => {
    const i64 = new BigInt64Array(sab);
    Atomics.store(i64, CELL_DETACH_REQ, 1n);
    Atomics.store(i64, CELL_ALIVE, 0n);
  });
}

/**
 * Retire every registered cell set — bounded wait for attached workers to
 * detach before the owner frees device/instance handles. Best-effort: a
 * worker wedged inside a blocking FFI call (or already force-terminated, so
 * its attach count is frozen) can't ack — the timeout keeps teardown moving.
 */
export async function retireAllSharedDevices(timeoutMs = 2000): Promise<void> {
  const pending: Promise<unknown>[] = [];
  [...LIVE_CELLS].forEach((sab) => {
    pending.push(retireSharedDevice(sab, timeoutMs));
  });
  await Promise.allSettled(pending);
}

/** Current number of live attached views (diagnostics / teardown checks). */
export function sharedDeviceAttachedCount(cells: DeviceStateCells | SharedArrayBuffer): number {
  const i64 = cells instanceof SharedArrayBuffer ? new BigInt64Array(cells) : cells.i64;
  return Number(Atomics.load(i64, CELL_ATTACHED));
}

export interface SharedDeviceView {
  device: WgpuDevice;
  queue: WgpuQueue;
  /** Handle generation the worker attached at — compare against
   *  Atomics.load(cells.i64, 0) to detect a device recreation. */
  generation: number;
  /** True while the owner-side device is alive at this generation, no detach
   *  has been requested, and this view hasn't been detached locally. Poll it
   *  before encoding — every FFI call on the view throws once it goes false. */
  isValid(): boolean;
  /**
   * Detach this view: marks the view invalid (guarded calls throw from here
   * on), decrements the attached count so retireSharedDevice() can finish,
   * and unwires the local wrapper (releases this thread's queue clone — never
   *  the owner's handles). Call when isValid() goes false or on worker
   * shutdown; workers that never detach stall owner teardown until timeout.
   */
  detach(): void;
  /** Pump wgpu events so worker-side map_async/onSubmittedWorkDone callbacks
   *  deliver. Only needed if the worker blocks on callbacks without the
   *  shim's internal pump (all shim blocking calls pump internally — this is
   *  for explicit waits). Throws once the view is invalid. */
  pumpEvents(): void;
}

/** Methods that stay callable on a dead/detached view — local bookkeeping or
 *  handles this thread owns outright. Everything else would dereference
 *  owner-owned native state and is guarded. */
const SAFE_WHEN_DEAD = new Set<PropertyKey>(["destroy", "getInstancePtr"]);

/**
 * Wrap a device/queue wrapper so every FFI-bound method checks liveness
 * before touching native handles. Converts a use-after-free on the owner's
 * released handles into a catchable error. The check is one Atomics.load —
 * cheap against any FFI call.
 */
function guardShared<T extends object>(
  target: T,
  isUsable: () => boolean,
  name: string,
  overrides?: Record<PropertyKey, unknown>,
): T {
  return new Proxy(target, {
    get(t, prop) {
      if (overrides && prop in overrides) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      if (typeof v === "function" && !SAFE_WHEN_DEAD.has(prop)) {
        return function (this: unknown, ...args: unknown[]) {
          if (!isUsable()) {
            throw new Error(
              `${name}.${String(prop)}: shared GPU device is no longer valid ` +
              "(owner destroyed/lost or detach requested)",
            );
          }
          return v.apply(t, args);
        };
      }
      return v;
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value);
    },
  });
}

/**
 * Reconstruct a non-owning device view inside a worker. The returned
 * WgpuDevice is fully functional — createBuffer/createPipeline/encoder —
 * but destroy() is a local no-op for the native handle, and every method
 * call is liveness-gated against the shared state cells.
 */
export function attachSharedDevice(
  handle: GpuDeviceHandle,
  cells?: SharedArrayBuffer | DeviceStateCells,
): SharedDeviceView {
  if (!handle.devicePtr || !handle.queuePtr) {
    throw new Error("attachSharedDevice: empty device/queue handle");
  }
  const i64 = cells
    ? (cells instanceof SharedArrayBuffer ? new BigInt64Array(cells) : cells.i64)
    : null;
  if (i64) {
    const alive = Atomics.load(i64, CELL_ALIVE) === 1n;
    const gen = Number(Atomics.load(i64, CELL_GENERATION));
    const detachReq = Atomics.load(i64, CELL_DETACH_REQ) === 1n;
    if (!alive || detachReq || gen !== handle.generation) {
      throw new Error(
        `attachSharedDevice: device handle is stale (gen ${handle.generation} vs ${gen}, alive=${alive}, retireRequested=${detachReq})`,
      );
    }
  }
  let detached = false;
  const isUsable = () => {
    if (detached) return false;
    if (!i64) return true;
    return Atomics.load(i64, CELL_ALIVE) === 1n
      && Atomics.load(i64, CELL_GENERATION) === BigInt(handle.generation)
      && Atomics.load(i64, CELL_DETACH_REQ) === 0n;
  };
  const rawDevice = new WgpuDevice(handle.devicePtr, handle.instancePtr, { ownsHandle: false });
  // The view's queue is this thread's own device_get_queue clone — NOT the
  // owner's queue box from handle.queuePtr. The owner releases its box on
  // destroy(); a worker-side wrapper around it would dangle. A clone keeps
  // the wgpu Queue alive through the worker's own wrapper lifetime.
  const rawQueue = rawDevice.queue;
  const queue = guardShared(rawQueue, isUsable, "WgpuQueue");
  // device.queue must hand out the GUARDED queue, not the raw wrapper.
  const device = guardShared(rawDevice, isUsable, "WgpuDevice", { queue });
  if (i64) Atomics.add(i64, CELL_ATTACHED, 1n);
  return {
    device,
    queue,
    generation: handle.generation,
    isValid: isUsable,
    detach() {
      if (detached) return;
      detached = true;
      if (i64) Atomics.sub(i64, CELL_ATTACHED, 1n);
      // Local unwire only — ownsHandle:false means destroy() releases just
      // this thread's queue clone, never the owner's device/queue boxes.
      try { rawDevice.destroy(); } catch { /* best-effort */ }
    },
    pumpEvents() {
      if (!isUsable()) {
        throw new Error("SharedDeviceView.pumpEvents: shared GPU device is no longer valid");
      }
      wgpu.wgpu_shim_process_events(handle.instancePtr as unknown as ptr);
      rawDevice.pollLost();
    },
  };
}

/**
 * A command buffer handed off from a worker: a bare ptr, or `{ptr, invalid}`
 * when the worker's finish() captured a validation error — invalid buffers
 * are released without submitting (submitting one aborts the process).
 */
export type WorkerCommandRef = number | bigint | { ptr: ptr; invalid?: boolean };

/**
 * Transfer ownership of a finished command buffer to the thread that will
 * submit it. MUST be called before posting the ptr — the transfer removes
 * the worker-side GC finalizer and makes the worker wrapper's dispose() a
 * no-op, so only the receiver releases the native handle.
 */
export function exportCommandBuffer(cmd: WgpuCommandBuffer): WorkerCommandRef {
  markTransferred(cmd);
  return cmd.invalid ? { ptr: cmd.ptr, invalid: true } : { ptr: cmd.ptr };
}

/**
 * Transfer ownership of any GPU resource wrapper (texture/buffer/view) to
 * another thread. Returns the raw ptr to post. Same contract as
 * exportCommandBuffer: after the call, this thread's wrapper will never
 * release the handle — the receiving side owns it.
 */
export function exportGpuResource<T extends { ptr: ptr }>(res: T): ptr {
  markTransferred(res);
  return res.ptr;
}

/**
 * Submit command buffers produced by a worker. wgpu command buffers are
 * process-global handles, so a worker can finish() an encoder and post the
 * WgpuCommandBuffer.ptr back; the owning thread submits it inside its own
 * batch to control frame-graph ordering.
 */
export function submitCommandPtrs(queue: WgpuQueue, cmds: ArrayLike<WorkerCommandRef>): void {
  const ptrs: bigint[] = [];
  const release = (p: bigint) => {
    try { wgpu.wgpu_shim_release_command_buffer(p as unknown as ptr); } catch { /* best-effort */ }
  };
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const p = BigInt(typeof c === "object" ? c.ptr : c);
    if (typeof c === "object" && c.invalid) { release(p); continue; }
    ptrs.push(p);
  }
  if (ptrs.length > 0) {
    const arr = new BigUint64Array(ptrs);
    wgpu.wgpu_shim_queue_submit(queue.ptr as unknown as ptr, arr as unknown as ptr, ptrs.length);
    for (let i = 0; i < ptrs.length; i++) release(ptrs[i]);
  }
}

/**
 * Wrap a worker-produced command buffer handle for submission through the
 * normal queue.submit([...]) path (mixes with locally-encoded buffers).
 */
export function importCommandBuffer(cmd: WorkerCommandRef): WgpuCommandBuffer {
  // Keep the raw handle lossless — Number() on a 64-bit address truncates.
  const cb = new WgpuCommandBuffer(typeof cmd === "object" ? cmd.ptr : cmd);
  if (typeof cmd === "object" && cmd.invalid) cb.invalid = true;
  // Same finalizer finish() registers — this thread owns the handle now, so
  // a dropped wrapper must still release it (submit() untracks + releases).
  trackForRelease(cb, () => wgpu.wgpu_shim_release_command_buffer(cb.ptr as unknown as ptr));
  return cb;
}
