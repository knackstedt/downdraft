// ============================================================================
// share-broker.ts — one DeviceStateCells set per device
//
// shareDevice() writes device.sharedState/sharedStateGen on every call, so a
// second share on the same device CLOBBERS the first — only the last-
// registered cells get writeDead() on device loss/destroy, leaving the other
// consumers' workers issuing FFI calls on a dead device. The broker owns THE
// cells for a device; every consumer (ui workers, grid builders, pass
// producers) attaches through broker.payload(), so one death signal reaches
// all of them and attached() counts every live view.
//
//   const broker = new GpuShareBroker(device);   // native-host owns it
//   worker.postMessage({ gpuAttach: broker.payload() });
//   // worker: attachSharedDevice(payload.gpu, payload.cells)
//   await broker.retire();                        // before device.destroy()
// ============================================================================

import {
    createDeviceStateCells,
    markDeviceLost,
    retireSharedDevice,
    shareDevice,
    sharedDeviceAlive,
    sharedDeviceAttachedCount,
    type DeviceStateCells,
    type GpuDeviceHandle,
} from "./shared-device";
import type { WgpuDevice } from "./wgpu-device";

/** What a worker needs to attachSharedDevice() — postMessage-safe. */
export interface GpuSharePayload {
    gpu: GpuDeviceHandle;
    cells: SharedArrayBuffer;
}

export class GpuShareBroker {
    private readonly cells: DeviceStateCells;
    private readonly handle: GpuDeviceHandle;

    constructor(device: WgpuDevice) {
        this.cells = createDeviceStateCells();
        this.handle = shareDevice(device, this.cells);
    }

    /** The handle + cells SAB to postMessage to each attaching worker. */
    payload(): GpuSharePayload {
        return { gpu: this.handle, cells: this.cells.sab };
    }

    /** The raw cells — retireSharedDevice() on this drains ALL attached views. */
    get deviceCells(): DeviceStateCells {
        return this.cells;
    }

    /** Live attached-view count across every consumer of this device. */
    attached(): number {
        return sharedDeviceAttachedCount(this.cells);
    }

    /** True while the owner device is live (mirrors the shared alive cell). */
    isAlive(): boolean {
        return sharedDeviceAlive(this.cells);
    }

    /** Explicitly mark the shared device dead (also written by pollLost). */
    markLost(): void {
        markDeviceLost(this.cells);
    }

    /**
     * Raise the detach request and wait for every attached worker view to
     * detach — call before device.destroy() so no worker FFI call is in
     * flight when the handles are freed. Resolves false on timeout (a worker
     * wedged in a blocking FFI call can't ack — see retireSharedDevice).
     */
    retire(timeoutMs = 5000): Promise<boolean> {
        return retireSharedDevice(this.cells, timeoutMs);
    }
}
