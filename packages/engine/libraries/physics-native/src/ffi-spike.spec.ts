import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const LIB_RELEASE = join(import.meta.dir, "../native/target/release/libdowndraft_physics.so");
const LIB_DEBUG = join(import.meta.dir, "../native/target/debug/libdowndraft_physics.so");
const LIB = existsSync(LIB_RELEASE) ? LIB_RELEASE : LIB_DEBUG;

// Phase 0 spike: dlopen() inside a Bun Worker + SAB-backed pointer passing.
// Requires `cd native && cargo build --release` first.
describe("FFI spike (dlopen in worker + SAB pointers)", () => {
    it("worker can dlopen the cdylib and round-trip physics over SAB", async () => {
        if (!existsSync(LIB)) {
            throw new Error(`native lib missing: ${LIB} — run cargo build --release in native/`);
        }

        // SABs allocated on the main thread, shared with the worker — the same
        // topology LibraryHost uses for sim channels.
        const sab = new SharedArrayBuffer(8 * 4);
        const velSab = new SharedArrayBuffer(6 * 4);

        const worker = new Worker(new URL("./ffi-spike-worker.ts", import.meta.url).href);
        try {
            const result = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("worker timeout")), 15_000);
                worker.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
                worker.onerror = (e) => { clearTimeout(timer); reject(e.error ?? new Error(e.message)); };
                worker.postMessage({ libPath: LIB, sab, velSab });
            });

            expect(result.ok).toBe(true);
            expect(result.transformPtrNonZero).toBe(true);
            expect(result.velocityPtrNonZero).toBe(true);
            expect(result.createRealm).toBe(0);
            expect(result.createBody).toBe(0);
            expect(result.step).toBe(0);
            // stepAndReadAwake returns the awake-body count (1 body awake).
            expect(result.stepBatched).toBe(1);
            expect(result.awakeId).toBe(7);

            // Two 1/60 steps under -9.81 gravity → vy ≈ -0.327
            expect(result.velocities[1]).toBeLessThan(-0.3);
            expect(result.velocities[1]).toBeGreaterThan(-0.36);
        } finally {
            worker.terminate();
        }

        // Rust wrote into velSab inside the worker; the write must be visible
        // on the main thread through the shared buffer.
        const vel = new Float32Array(velSab);
        expect(vel[1]).toBeLessThan(-0.3);
        expect(vel[1]).toBeGreaterThan(-0.36);
    }, 30_000);
});
