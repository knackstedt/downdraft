import { createSimWorker } from "@downdraft/engine";
import { exposeDevToolsApi } from "@downdraft/engine/modules/devtools";
import { exposeProfilingApi } from "@downdraft/engine";

// ============================================================================
// sim-worker — 60Hz tick that does measurable work: entity churn, allocation,
// periodic CPU burn. Devtools-wrapped (eval + profiling attach) so the sim
// thread appears in the devtools thread list with a working REPL + profile.
// ============================================================================

const MAX_ENTS = 512;
let ents: { x: number; y: number; vx: number; vy: number }[] = [];
let tick = 0;
const scratch: unknown[] = [];

createSimWorker({
  fixedDt: 1 / 60,

  onInit(sab) {
    // Seed a few entities into the shared buffer region the renderer reads.
    const f32 = new Float32Array(sab);
    for (let i = 0; i < MAX_ENTS; i++) {
      ents.push({ x: Math.sin(i) * 100, y: Math.cos(i) * 100, vx: 1 + (i % 5), vy: 0.5 });
    }
    void f32;
  },

  onTick(dt) {
    tick++;
    // Integrate.
    ents.forEach((e) => {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.x > 200) e.x = -200;
      if (e.y > 200) e.y = -200;
    });
    // Alloc churn — keeps heap metrics moving.
    for (let i = 0; i < 32; i++) scratch.push({ t: tick, i, s: "x".repeat(64) });
    if (scratch.length > 4096) scratch.splice(0, scratch.length - 2048);
    // Periodic CPU burn (~4ms every ~4s) so profiles have hot frames.
    if (tick % 240 === 0) {
      let acc = 0;
      for (let i = 0; i < 400_000; i++) acc += Math.sqrt(i * 1.7) % 3;
      void acc;
    }
    // Churn entity count occasionally (spawn/kill waves).
    if (tick % 600 === 0) ents = ents.slice(0, MAX_ENTS / 2);
    if (tick % 600 === 300) {
      for (; ents.length < MAX_ENTS;) ents.push({ x: 0, y: 0, vx: Math.random() * 4, vy: Math.random() * 2 });
    }
  },

  wrapExpose: (api) => exposeProfilingApi(exposeDevToolsApi(api)),
});
