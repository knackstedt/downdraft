// ffi-spike-worker.ts — Phase 0 spike worker: proves bun:ffi dlopen() works
// inside a Bun Worker and that pointers to SharedArrayBuffer-backed typed
// arrays can be passed to native Rust code in both directions.

import { dlopen, FFIType, ptr } from "bun:ffi";

declare const self: Worker;

self.onmessage = (e: MessageEvent) => {
    const { libPath, sab, velSab } = e.data;
    try {
        const lib = dlopen(libPath, {
            dd_create_realm: { args: [FFIType.i32, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.i32 },
            dd_destroy_realm: { args: [FFIType.i32], returns: FFIType.i32 },
            dd_create_body: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
            dd_step: { args: [FFIType.i32, FFIType.f32], returns: FFIType.i32 },
            dd_step_and_read_awake: { args: [FFIType.i32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
            dd_destroy: { args: [], returns: FFIType.i32 },
        });

        // Views over the SABs shared by the main thread.
        const transforms = new Float32Array(sab as SharedArrayBuffer);
        const velocities = new Float32Array(velSab as SharedArrayBuffer);

        // Body descriptor — layout per native/src/body.rs:
        //   f[17] = [pos3, quat4(xyzw), linvel3, angvel3, mass, linDamp, angDamp, gravScale]
        //   i[2]  = [bodyType (0=fixed,1=kinematic,2=dynamic), flags]
        const bodyF = new Float32Array(17);
        const bodyI = new Int32Array(2);
        bodyF.set([0, 10, 0, 0, 0, 0, 1]); // pos + identity quat
        bodyF[13] = 1; // mass — collider-less bodies have zero mass in Rapier (gravity = m*g)
        bodyI[0] = 2; // dynamic
        bodyI[1] = (1 << 1) | (1 << 9); // canSleep | hasMass

        const createRealm = lib.symbols.dd_create_realm(0, 0, -9.81, 0);
        const createBody = lib.symbols.dd_create_body(0, 7, ptr(bodyF), ptr(bodyI));

        const step = lib.symbols.dd_step(0, 1 / 60);

        // Awake readback: ids (i32) + [pos3, quat4, linvel3] per body.
        const awakeSab = new SharedArrayBuffer(4 + 10 * 4);
        const idsView = new Int32Array(awakeSab, 0, 1);
        const statesView = new Float32Array(awakeSab, 4, 10);

        const stepBatched = lib.symbols.dd_step_and_read_awake(
            0, 1 / 60, ptr(idsView), ptr(statesView), 1,
        );

        // Copy linvel into velSab so the main thread sees the write-back.
        velocities.set(statesView.subarray(7, 10));

        const transformPtr = ptr(transforms);
        const velocityPtr = ptr(velocities);

        lib.symbols.dd_destroy();

        self.postMessage({
            ok: true,
            createRealm,
            createBody,
            step,
            stepBatched,
            awakeId: idsView[0],
            transformPtrNonZero: transformPtr !== 0,
            velocityPtrNonZero: velocityPtr !== 0,
            velocities: Array.from(velocities),
        });
    } catch (err) {
        self.postMessage({ ok: false, error: String(err) });
    }
};
