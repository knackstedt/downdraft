// ============================================================================
// createSimWorker — save/load/command plumbing + deterministic RNG
// Uses a fake `self` worker global so getWorkerHost() takes the browser path.
// ============================================================================

import { beforeEach, describe, expect, it } from "bun:test";

interface PostedMessage {
  __rpc?: true;
  __event?: true;
  __eventBatch?: true;
  events?: { kind: string; data: any }[];
  id?: number;
  result?: unknown;
  error?: string;
  kind?: string;
  data?: any;
}

let posted: PostedMessage[] = [];
let messageHandler: ((e: { data: any }) => Promise<void>) | null = null;

(globalThis as any).self = {
  postMessage: (msg: PostedMessage) => posted.push(msg),
  addEventListener: (_t: string, h: (e: { data: any }) => Promise<void>) => {
    messageHandler = h;
  },
  removeEventListener: () => { messageHandler = null; },
  close: () => {},
};

const { createSimWorker } = await import("./sim-worker-base");

async function rpc(method: string, ...args: any[]): Promise<unknown> {
  const id = Math.floor(Math.random() * 1e9);
  const req = { __rpc: true, id, method, args };
  const p = messageHandler!({ data: req });
  await p;
  const res = posted.find((m) => m.__rpc === true && m.id === id);
  if (!res) throw new Error(`no response for ${method}`);
  if (res.error) throw new Error(res.error);
  return res.result;
}

async function eventsOf(kind: string): Promise<PostedMessage[]> {
  // Batched events flush on a macrotask — yield once so pending queue posts.
  await new Promise((r) => setTimeout(r, 0));
  const out: PostedMessage[] = [];
  for (const m of posted) {
    if (m.__event === true && m.kind === kind) out.push(m);
    if (m.__eventBatch === true) {
      for (const ev of m.events ?? []) {
        if (ev.kind === kind) out.push({ __event: true, kind: ev.kind, data: ev.data });
      }
    }
  }
  return out;
}

function fakeStore() {
  const saved: any[] = [];
  const store = {
    saved,
    async init() {},
    async save(_slot: string, state: any) {
      saved.push(state);
      return { success: true, bytes: 1, gen: 3 };
    },
    async load() {
      return { state: saved[saved.length - 1] ?? null, gen: 3 };
    },
    async listSaves() { return []; },
    async listGenerations() { return []; },
    async deleteSave() { return true; },
    async deleteGeneration() { return false; },
    async setThumbnail() {},
    async getThumbnail() { return null; },
    async setProperties() {},
    async getProperties() { return {}; },
    onWarning() { return () => {}; },
  };
  return store;
}

describe("createSimWorker save/command plumbing", () => {
  beforeEach(() => {
    posted = [];
    messageHandler = null;
  });

  it("exposes save/load/initSaveStore/sendCommand/restoreFromState", async () => {
    let restored: unknown = null;
    let lastCmd: unknown = null;
    const store = fakeStore();

    createSimWorker({
      fixedDt: 0.005,
      seed: 42,
      onInit: () => {},
      onTick: () => {},
      save: {
        componentName: "sandbox",
        capture: () => ({ props: [1, 2, 3], funMode: 2 }),
        restore: (data) => { restored = data; },
        createStore: () => store,
        meta: (data) => ({
          engineVersion: "0.1.0",
          entityCount: (data as { props?: unknown[] }).props?.length ?? 0,
          playerCount: 1,
        }),
      },
      onCommand: (cmd) => { lastCmd = cmd; },
    });

    await rpc("init", new SharedArrayBuffer(64));
    await rpc("initSaveStore", { root: "saves" });

    const saveRes = (await rpc("save", "slot1")) as {
      slotName: string;
      stateJson: string;
      success: boolean;
      gen?: number;
      meta?: { entityCount?: number; playerCount?: number; engineVersion?: string };
    };
    expect(saveRes.slotName).toBe("slot1");
    expect(saveRes.success).toBe(true);
    expect(saveRes.gen).toBe(3);
    // Real SaveMeta flows back through the RPC result so the renderer's
    // save store can persist it instead of fabricating zeros.
    expect(saveRes.meta?.entityCount).toBe(3);
    expect(saveRes.meta?.playerCount).toBe(1);
    expect(saveRes.meta?.engineVersion).toBe("0.1.0");

    // stateJson is the components map; store received the full SaveState.
    const components = JSON.parse(saveRes.stateJson);
    expect(components.sandbox.v).toBe(1);
    expect(components.sandbox.data.props).toEqual([1, 2, 3]);
    expect(store.saved[0].components.sandbox.data.funMode).toBe(2);
    expect(store.saved[0].meta.entityCount).toBe(3);
    expect(store.saved[0].meta.engineVersion).toBe("0.1.0");

    // load() with no stateJson pulls from the store and unwraps the
    // component data before calling restore().
    expect(await rpc("load", "slot1")).toBe(true);
    expect(restored).toEqual({ props: [1, 2, 3], funMode: 2 });

    // restoreFromState accepts the wrapped components-map wire form.
    await rpc("restoreFromState", JSON.stringify({ sandbox: { v: 1, data: { props: [9] } } }));
    expect(restored).toEqual({ props: [9] });

    await rpc("sendCommand", { type: "spawn", id: 7 });
    expect(lastCmd).toEqual({ type: "spawn", id: 7 });

    expect((await eventsOf("saved")).length).toBe(1);
    const savedEvt = (await eventsOf("saved"))[0].data as {
      slotName: string; meta?: { entityCount?: number }; origin?: string;
    };
    expect(savedEvt.meta?.entityCount).toBe(3);
    // Renderer-initiated saves are tagged so game "saved" handlers don't
    // double-write them (the caller already persists the payload).
    expect(savedEvt.origin).toBe("renderer");
    expect((await eventsOf("loaded")).length).toBe(1);
    await rpc("shutdown");
  });

  it("load() returns false when neither stateJson nor store data exists", async () => {
    createSimWorker({
      fixedDt: 0.005,
      seed: 42,
      onInit: () => {},
      onTick: () => {},
      save: {
        componentName: "sandbox",
        capture: () => ({}),
        restore: () => {},
      },
    });
    await rpc("init", new SharedArrayBuffer(64));
    expect(await rpc("load", "missing")).toBe(false);
    await rpc("shutdown");
  });

  it("supports multi-component capture (no componentName)", async () => {
    let restored: unknown = null;
    createSimWorker({
      fixedDt: 0.005,
      seed: 42,
      onInit: () => {},
      onTick: () => {},
      save: {
        capture: () => ({ players: { v: 2, data: [1] }, world: { v: 1, data: {} } }),
        restore: (data) => { restored = data; },
      },
    });
    await rpc("init", new SharedArrayBuffer(64));
    const res = (await rpc("save", "s")) as { stateJson: string };
    const components = JSON.parse(res.stateJson);
    expect(components.players.v).toBe(2);
    expect(components.world.data).toEqual({});

    await rpc("restoreFromState", res.stateJson);
    // No componentName → restore receives the full components map.
    expect((restored as any).players.data).toEqual([1]);
    await rpc("shutdown");
  });

  it("ctx.rng is deterministic for a given seed", async () => {
    const seqA: number[] = [];
    const seqB: number[] = [];

    createSimWorker({
      fixedDt: 0.005,
      seed: 42,
      onInit: () => {},
      onTick: (_dt, ctx) => { seqA.push(ctx.rng()); },
    });
    // init + step() runs exactly one tick.
    await rpc("init", new SharedArrayBuffer(64));
    await rpc("step");
    await new Promise((r) => setTimeout(r, 30));
    await rpc("shutdown");

    createSimWorker({
      fixedDt: 0.005,
      seed: 42,
      onInit: () => {},
      onTick: (_dt, ctx) => { seqB.push(ctx.rng()); },
    });
    await rpc("init", new SharedArrayBuffer(64));
    await rpc("step");
    await new Promise((r) => setTimeout(r, 30));
    await rpc("shutdown");

    expect(seqA.length).toBeGreaterThan(0);
    // Same seed → identical draws.
    expect(seqB).toEqual(seqA);
  });

  it("withLoopStopped is a hard barrier — restore waits for an in-flight tick", async () => {
    let gate: (() => void) | null = null;
    let tickRunning = false;
    let restored = false;
    let restoredDuringTick: boolean | null = null;

    createSimWorker({
      fixedDt: 0.001,
      seed: 42,
      onInit: () => {},
      onTick: async () => {
        // Suspend mid-tick until the test releases the gate — simulates a
        // long/awaited tick that the old ~50ms poll would have raced.
        tickRunning = true;
        await new Promise<void>((r) => { gate = r; });
        tickRunning = false;
      },
      save: {
        componentName: "x",
        restore: () => { restored = true; restoredDuringTick = tickRunning; },
      },
    });
    await rpc("init", new SharedArrayBuffer(64));

    // Wait for the loop to land inside the gated tick.
    for (let i = 0; i < 500 && !gate; i++) await new Promise((r) => setTimeout(r, 1));
    expect(gate).not.toBeNull();

    const loadP = rpc("restoreFromState", JSON.stringify({ v: 1 }));
    // Give it real time — the restore must NOT proceed while the tick hangs.
    await new Promise((r) => setTimeout(r, 60));
    expect(restored).toBe(false);

    gate!();
    await loadP;
    expect(restored).toBe(true);
    // The restore ran strictly after the tick fully unwound — no overlap.
    expect(restoredDuringTick === false).toBe(true);
    await rpc("shutdown");
  });
});
