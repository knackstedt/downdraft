// ============================================================================
// Overburden — pathfinding broker (sim-side async mediator)
//
// Lives inside the sim worker. Mediates async path requests from the
// synchronous executeTask() path in task-queue.ts to the dedicated pather
// worker (pathfinding-worker.ts).
//
// ARCHITECTURE: The pather worker is spawned by the RENDERER (not the sim
// worker) so Vite can bundle it. The renderer creates a MessageChannel,
// transfers one port to the pather worker and the other to the sim worker.
// The sim worker receives its port via a direct postMessage and passes it
// to this broker via attachPort(). The broker wraps the port with wrap()
// for typed RPC.
//
// Why: pathfinding A* over a 448×448 grid can be expensive. Running it on the
// sim thread stalls the simulation tick; running it on the renderer thread
// stalls rendering. The dedicated pather worker runs on a separate OS thread
// and reads the active grid directly from the SharedArrayBuffer (read-only).
//
// Flow:
//   executeTask() (sync, per tick) → broker.requestPath(task, ...)
//     → posts RPC to pather worker via MessagePort (async)
//     → pather reads SAB, runs grid-movement.findPath, returns PathNode[]
//     → broker promise .then() writes result to task.path + clears pathRequestId
//   While in-flight, executeTask() falls back to greedy walkToward().
//
// Fallback: before the port arrives (or if it never arrives), the broker
// operates in degraded mode — calling grid-movement.findPath synchronously
// in-line, identical to the pre-refactor behavior.
// ============================================================================

import { PortChannel } from "@downdraft/core";
import type { WorkerApi } from "@downdraft/core/worker/rpc";
import { ACTIVE_GRID_CELLS } from "../shared/constants";
import { GRID_BG_OFFSET, GRID_FG_OFFSET } from "../shared/sim-buffer";
import { findPath as findPathSync, findPathToAdjacent as findPathToAdjacentSync, type PathNode } from "./grid-movement";
import type { Task } from "./task-queue";

interface PatherWorkerApi extends WorkerApi {
  findPath(sx: number, sy: number, gx: number, gy: number, wrap: boolean): Promise<PathNode[] | null>;
  findPathToAdjacent(
    sx: number, sy: number, tx: number, ty: number, wrap: boolean,
  ): Promise<PathNode[] | null>;
  shutdown(): Promise<void>;
}

interface PendingRequest {
  task: Task;
  adjacent: boolean;
}

export class PathfindingBroker {
  private channel = new PortChannel<PatherWorkerApi>();
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private _degraded = true; // start degraded until the port arrives
  private sab: SharedArrayBuffer;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
  }

  /**
   * Attach a MessagePort connected to the pather worker. Called by the sim
   * worker when it receives the port from the renderer. Switches the broker
   * from degraded (sync) mode to async mode.
   */
  attachPort(port: MessagePort): void {
    this.channel.attachPort(port);
    this._degraded = false;
  }

  /** True once the pather port is attached and ready for requests. */
  isReady(): boolean {
    return this.channel.isReady();
  }

  /** True if the broker fell back to synchronous in-line pathfinding. */
  isDegraded(): boolean {
    return this._degraded;
  }

  /**
   * Request a path asynchronously. Sets `task.pathRequestId`; the result
   * arrives via a microtask that writes `task.path` and clears
   * `task.pathRequestId`. Does NOT await — caller should check
   * `task.path` on subsequent ticks and use a greedy fallback while it's
   * still `undefined`.
   *
   * In degraded mode, computes the path synchronously and writes it to
   * `task.path` immediately (pathRequestId stays undefined).
   */
  requestPath(
    task: Task,
    sx: number, sy: number,
    gx: number, gy: number,
    adjacent: boolean,
    wrap: boolean,
  ): void {
    // Degraded: synchronous fallback (pre-refactor behavior).
    const proxy = this.channel.getProxy();
    if (this._degraded || !proxy) {
      task.path = adjacent
        ? findPathToAdjacentSync(this.fgSnapshot(), this.bgSnapshot(), sx, sy, gx, gy, wrap)
        : findPathSync(this.fgSnapshot(), this.bgSnapshot(), sx, sy, gx, gy, wrap);
      task.pathIndex = 0;
      return;
    }

    // If a previous request for this task is still in-flight, let it finish
    // (avoid flooding the worker with duplicate requests).
    if (task.pathRequestId !== undefined) return;

    const requestId = this.nextRequestId++;
    task.pathRequestId = requestId;
    this.pending.set(requestId, { task, adjacent });

    const promise = adjacent
      ? proxy.proxy.findPathToAdjacent(sx, sy, gx, gy, wrap)
      : proxy.proxy.findPath(sx, sy, gx, gy, wrap);

    promise.then((result) => {
      // Only deliver if this request hasn't been cancelled.
      const pending = this.pending.get(requestId);
      if (!pending) return;
      if (pending.task.pathRequestId !== requestId) return;
      pending.task.path = result;
      pending.task.pathIndex = 0;
      pending.task.pathRequestId = undefined;
      this.pending.delete(requestId);
    }).catch((err) => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      console.warn("[PathfindingBroker] path request failed:", err);
      // Mark as no-path so the caller uses greedy fallback permanently.
      pending.task.path = null;
      pending.task.pathRequestId = undefined;
      this.pending.delete(requestId);
    });
  }

  /** Cancel an in-flight request for a task (e.g. on grid rebuild / re-path). */
  cancel(task: Task): void {
    if (task.pathRequestId === undefined) return;
    this.pending.delete(task.pathRequestId);
    task.pathRequestId = undefined;
  }

  /** Detach the port and reject pending requests. */
  dispose(): void {
    for (const [, p] of this.pending) {
      p.task.pathRequestId = undefined;
    }
    this.pending.clear();
    this.channel.dispose();
    this._degraded = true;
  }

  // --- SAB snapshots for degraded (sync) mode ---
  // In degraded mode we read the SAB directly. Views are built once and
  // reused (they alias the SAB, so they always see current data).
  private _fgView: Uint16Array | null = null;
  private _bgView: Uint16Array | null = null;

  private fgSnapshot(): Uint16Array {
    if (!this._fgView) {
      this._fgView = new Uint16Array(this.sab, GRID_FG_OFFSET, ACTIVE_GRID_CELLS);
    }
    return this._fgView;
  }

  private bgSnapshot(): Uint16Array {
    if (!this._bgView) {
      this._bgView = new Uint16Array(this.sab, GRID_BG_OFFSET, ACTIVE_GRID_CELLS);
    }
    return this._bgView;
  }
}
