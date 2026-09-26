// wasm-baseline.ts — Phase 0 baseline: WASM Rapier (@dimforge/rapier3d-compat)
// step + awake-body sync throughput under Bun/JSC.
//
// Run: bun run packages/engine/libraries/physics-rapier/bench/wasm-baseline.ts
//
// This is the number RapierFfiBackend must beat. It measures the exact hot
// loop the engine uses today: lib.step() + lib.readAwakeBodyStates().

import { loadPhysicsLib } from "../src/rapier-backend";

const DT = 1 / 60;
const WARMUP = 30;
const STEPS = 180;
const SIZES = [100, 500, 1000, 2000];

interface Scenario {
    name: string;
    floor: boolean;
}

const SCENARIOS: Scenario[] = [
    { name: "freefall (no contacts, all awake)", floor: false },
    { name: "piled (contacts + sleep)", floor: true },
];

async function bench(lib: any, n: number, floor: boolean) {
    lib.createRealm(0, [0, -9.81, 0]);
    lib.setIntegrationDt?.(0, DT);

    let nextId = 0;
    if (floor) {
        lib.createBody(0, nextId, { type: "static", position: [0, 0, 0], rotation: [0, 0, 0, 1] }, { index: nextId, generation: 0 });
        lib.addCollider(0, nextId, nextId, { shape: { type: "box", halfExtents: [60, 0.5, 60] }, friction: 0.8 });
        nextId++;
    }

    // Sphere grid: ~1.2m spacing, stacked layers so bodies stay agitated.
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
        const bodyId = nextId++;
        const x = (i % cols) * 1.2 - cols * 0.6;
        const z = Math.floor(i / cols) % cols * 1.2 - cols * 0.6;
        const y = 2 + Math.floor(i / (cols * cols)) * 1.3 + (i % 7) * 0.02;
        lib.createBody(0, bodyId, { type: "dynamic", position: [x, y, z], rotation: [0, 0, 0, 1], mass: 1 }, { index: bodyId, generation: 0 });
        lib.addCollider(0, bodyId, bodyId, { shape: { type: "sphere", radius: 0.5 }, friction: 0.6 });
    }

    const idsOut = new Uint32Array(nextId);
    const states = new Float32Array(nextId * 10);

    for (let i = 0; i < WARMUP; i++) lib.step(0, DT);

    let stepMs = 0;
    let syncMs = 0;
    let awake = 0;
    for (let i = 0; i < STEPS; i++) {
        const t0 = performance.now();
        lib.step(0, DT);
        const t1 = performance.now();
        awake = lib.readAwakeBodyStates!(0, idsOut, states, nextId);
        const t2 = performance.now();
        stepMs += t1 - t0;
        syncMs += t2 - t1;
    }

    lib.destroyRealm(0);

    return {
        stepAvg: stepMs / STEPS,
        syncAvg: syncMs / STEPS,
        totalAvg: (stepMs + syncMs) / STEPS,
        awake,
    };
}

const lib = await loadPhysicsLib();

console.log(`WASM Rapier baseline — Bun ${Bun.version} (JSC)`);
console.log(`${"scenario".padEnd(40)} ${"N".padStart(5)} ${"step ms".padStart(9)} ${"sync ms".padStart(9)} ${"total ms".padStart(9)} ${"awake".padStart(7)}`);

for (let _i = 0, _it = SCENARIOS, _n = _it.length; _i < _n; _i++) { const scenario = _it[_i];
    for (let _i = 0, _it = SIZES, _n = _it.length; _i < _n; _i++) { const n = _it[_i];
        const r = await bench(lib, n, scenario.floor);
        console.log(
            `${scenario.name.padEnd(40)} ${String(n).padStart(5)} ` +
            `${r.stepAvg.toFixed(3).padStart(9)} ${r.syncAvg.toFixed(3).padStart(9)} ` +
            `${r.totalAvg.toFixed(3).padStart(9)} ${String(r.awake).padStart(7)}`
        );
    }
}
