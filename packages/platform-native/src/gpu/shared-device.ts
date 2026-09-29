// ============================================================================
// shared-device.ts — share the host's wgpu device with Bun workers
//
// The wgpu shim's handles are process-global boxed pointers, and wgpu-core
// internally synchronizes device/queue access — so a device created on the
// main thread is safe to use from a Bun worker (same address space,
// dlopen'd once). This module is the transfer protocol:
//
//   main thread:  const cells = createDeviceStateCells();
//                 const handle = shareDevice(device, cells);
//                 worker.postMessage({ gpu: handle, cells: cells.sab });
//
//   worker:       const { device, queue, isValid } =
//                   attachSharedDevice(msg.gpu, msg.cells);
//                 // encode passes, create resources, submit — all on-thread
//
// Ownership rules:
// - Only the OWNER (the thread that created the device, via
//   WgpuAdapter.requestDevice) may call device.destroy(). Worker attach is
//   non-owning: destroy() on the worker view is a local unwire, never a
//   native release.
// - Device loss is broadcast through the state cell (alive flag → 0) —
//   workers poll isValid()/sharedDeviceAlive() rather than .lost promises.
// - Command ordering is submission order: a worker's queue.submit()
//   interleaves with main's. For passes that must slot into the frame
//   graph, have the worker finish() encoders and postMessage the command
//   buffer handles back for the main thread to submit (submitCommandPtrs).
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { ptr } from "../ffi/ffi-adapter";
import { WgpuDevice, WgpuQueue } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";
import { WgpuCommandBuffer } from "./wgpu-resources";

const log = createLogger();

/** Serializes GPU-device liveness between owner thread and attached workers. */
export interface GpuDeviceHandle {
  /** Raw wgpu device handle (process-global boxed pointer). */
  devicePtr: number;
  /** Raw wgpu instance handle — needed for event pumping in the worker. */
  instancePtr: number;
  /** Raw wgpu queue handle (device_get_queue result). */
  queuePtr: number;
  /** Handle generation — bumped when the owner re-creates the device after
   *  loss. Workers compare it against cell 0 and must re-attach on change. */
  generation: number;
}

/** i64[2] view over a SharedArrayBuffer: [0]=generation, [1]=alive (1|0). */
export interface DeviceStateCells {
  sab: SharedArrayBuffer;
  i64: BigInt64Array;
}

export function createDeviceStateCells(generation = 1): DeviceStateCells {
  const sab = new SharedArrayBuffer(16);
  const i64 = new BigInt64Array(sab);
  Atomics.store(i64, 0, BigInt(generation));
  Atomics.store(i64, 1, 1n); // alive
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
  const generation = Number(Atomics.load(cells.i64, 0)) + 1;
  Atomics.store(cells.i64, 0, BigInt(generation));
  Atomics.store(cells.i64, 1, 1n);
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
  Atomics.store(cells.i64, 1, 0n);
}

export function sharedDeviceAlive(cells: DeviceStateCells | SharedArrayBuffer): boolean {
  const i64 = cells instanceof SharedArrayBuffer ? new BigInt64Array(cells) : cells.i64;
  return Atomics.load(i64, 1) === 1n;
}

export interface SharedDeviceView {
  device: WgpuDevice;
  queue: WgpuQueue;
  /** Handle generation the worker attached at — compare against
   *  Atomics.load(cells.i64, 0) to detect a device recreation. */
  generation: number;
  /** True while the owner-side device is alive at this generation. */
  isValid(): boolean;
  /** Pump wgpu events so worker-side map_async/onSubmittedWorkDone callbacks
   *  deliver. Only needed if the worker blocks on callbacks without the
   *  shim's internal pump (all shim blocking calls pump internally — this is
   *  for explicit waits). */
  pumpEvents(): void;
}

/**
 * Reconstruct a non-owning device view inside a worker. The returned
 * WgpuDevice is fully functional — createBuffer/createPipeline/encoder —
 * but destroy() is a local no-op for the native handle.
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
    const alive = Atomics.load(i64, 1) === 1n;
    const gen = Number(Atomics.load(i64, 0));
    if (!alive || gen !== handle.generation) {
      throw new Error(
        `attachSharedDevice: device handle is stale (gen ${handle.generation} vs ${gen}, alive=${alive})`,
      );
    }
  }
  const device = new WgpuDevice(handle.devicePtr, handle.instancePtr, { ownsHandle: false });
  const queue = new WgpuQueue(handle.queuePtr);
  return {
    device,
    queue,
    generation: handle.generation,
    isValid() {
      if (!i64) return true;
      return Atomics.load(i64, 1) === 1n && Number(Atomics.load(i64, 0)) === handle.generation;
    },
    pumpEvents() {
      wgpu.wgpu_shim_process_events(handle.instancePtr as unknown as ptr);
      device.pollLost();
    },
  };
}

/**
 * A command buffer handed off from a worker: a bare ptr, or `{ptr, invalid}`
 * when the worker's finish() captured a validation error — invalid buffers
 * are released without submitting (submitting one aborts the process).
 */
export type WorkerCommandRef = number | bigint | { ptr: number | bigint; invalid?: boolean };

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
    for (const p of ptrs) release(p);
  }
}

/**
 * Wrap a worker-produced command buffer handle for submission through the
 * normal queue.submit([...]) path (mixes with locally-encoded buffers).
 */
export function importCommandBuffer(cmd: WorkerCommandRef): WgpuCommandBuffer {
  const cb = new WgpuCommandBuffer(Number(typeof cmd === "object" ? cmd.ptr : cmd));
  if (typeof cmd === "object" && cmd.invalid) cb.invalid = true;
  return cb;
}
