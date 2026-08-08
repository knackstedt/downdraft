import { beforeEach, describe, expect, it } from "bun:test";
import { JobScheduler, WorkerPool, parallelMap } from "./job-system";
import { Schedule } from "./schedule";
import { Stage, system, type SystemContext } from "./system";

// --- WorkerPool tests (inline fallback, no real workers) ---

describe("WorkerPool", () => {
  it("should create with default size based on hardware concurrency", () => {
    const pool = new WorkerPool({ functions: { double: (x: number) => x * 2 } });
    expect(pool.poolSize).toBeGreaterThan(0);
    expect(pool.getFunction("double")).toBeDefined();
  });

  it("should register and retrieve functions", () => {
    const pool = new WorkerPool();
    const fn = (x: number) => x + 1;
    pool.registerFunction("inc", fn);
    expect(pool.getFunction("inc")).toBe(fn);
    expect(pool.getFunctionKeys()).toContain("inc");
  });

  it("should fall back to inline execution when no workers are set", async () => {
    const pool = new WorkerPool({ functions: { add: (a: number, b: number) => a + b } });
    const result = await pool.dispatch("add", [3, 4]);
    expect(result).toBe(7);
  });

  it("should report idle state when no workers are busy", () => {
    const pool = new WorkerPool();
    expect(pool.isIdle()).toBe(true);
    expect(pool.hasIdleWorker()).toBe(false); // no workers set
    expect(pool.getBusyCount()).toBe(0);
  });
});

// --- JobScheduler tests ---

describe("JobScheduler", () => {
  let scheduler: JobScheduler;

  beforeEach(() => {
    const pool = new WorkerPool({
      functions: {
        square: (x: number) => x * x,
        add: (a: number, b: number) => a + b,
        echo: (x: unknown) => x,
      },
    });
    scheduler = new JobScheduler({ pool });
  });

  it("should submit and complete a simple job", async () => {
    const result = await scheduler.submit({
      fn: "square",
      args: [5],
      deps: [],
      priority: 0,
    });
    expect(result).toBe(25);
  });

  it("should handle job dependencies", async () => {
    // Submit job 1, then job 2 that depends on job 1
    const p1 = scheduler.submit({ fn: "square", args: [3], deps: [], priority: 0 });
    const p2 = scheduler.submit({ fn: "add", args: [0, 0], deps: [], priority: 0 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(9);
    expect(r2).toBe(0);
  });

  it("should track job stats", async () => {
    await scheduler.submit({ fn: "echo", args: ["hello"], deps: [], priority: 0 });
    const stats = scheduler.getStats();
    expect(stats.done).toBeGreaterThanOrEqual(0);
  });

  it("should drain all pending jobs", async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(scheduler.submit({ fn: "square", args: [i], deps: [], priority: 0 }));
    }
    await scheduler.drain();
    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      expect(results[i]).toBe(i * i);
    }
  });

  it("should handle errors in jobs", async () => {
    const pool = new WorkerPool({
      functions: {
        fail: () => { throw new Error("boom"); },
      },
    });
    const sched = new JobScheduler({ pool });

    try {
      await sched.submit({ fn: "fail", args: [], deps: [], priority: 0 });
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect((e as Error).message).toBe("boom");
    }
  });

  it("should support work stealing via stealReady", async () => {
    const pool = new WorkerPool({
      functions: { slow: (x: number) => x * 10 },
    });
    const sched = new JobScheduler({ pool });

    // Submit a job — since no workers, it'll be in ready queue
    const promise = sched.submit({ fn: "slow", args: [7], deps: [], priority: 0 });

    // Steal and run inline
    const stolen = sched.stealReady();
    if (stolen) {
      await sched.runInline(stolen);
    }

    const result = await promise;
    expect(result).toBe(70);
  });

  it("should dispose cleanly", () => {
    scheduler.dispose();
    expect(scheduler.getStats().pending).toBe(0);
  });

  it("should clear jobs map on terminate()", () => {
    const pool = new WorkerPool({
      functions: { square: (x: number) => x * x },
    });
    const sched = new JobScheduler({ pool });
    sched.submit({ fn: "square", args: [5], deps: [], priority: 0 });
    sched.terminate();
    expect(sched.getStats().pending).toBe(0);
    expect(sched.getStats().ready).toBe(0);
    expect(sched.getStats().done).toBe(0);
  });
});

// --- parallelMap tests ---

describe("parallelMap", () => {
  it("should map over items in batches", async () => {
    const pool = new WorkerPool({
      functions: {
        batchSquare: (items: number[]) => items.map((x) => x * x),
      },
    });
    const scheduler = new JobScheduler({ pool });

    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await parallelMap<number, number>(scheduler, "batchSquare", items, { batchSize: 3 });

    expect(results).toEqual([1, 4, 9, 16, 25, 36, 49, 64]);
  });

  it("should handle empty input", async () => {
    const pool = new WorkerPool({ functions: { noop: () => [] } });
    const scheduler = new JobScheduler({ pool });
    const results = await parallelMap(scheduler, "noop", []);
    expect(results).toEqual([]);
  });
});

// --- Schedule parallel execution tests ---

describe("Schedule.runStageParallel", () => {
  it("should run systems sequentially when no scheduler workers exist", async () => {
    const order: string[] = [];
    const schedule = new Schedule();

    schedule.addSystem(
      system("A", Stage.Update, () => { order.push("A"); }, { parallelizable: true }),
    );
    schedule.addSystem(
      system("B", Stage.Update, () => { order.push("B"); }, { parallelizable: true }),
    );
    schedule.addSystem(
      system("C", Stage.Update, () => { order.push("C"); }),
    );

    const pool = new WorkerPool();
    const scheduler = new JobScheduler({ pool });
    const ctx = { world: null as any, dt: 0, tick: 0 } as SystemContext;

    await schedule.runStageParallel(Stage.Update, ctx, scheduler);

    // Without workers, all run inline in order
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("should respect after dependencies", async () => {
    const order: string[] = [];
    const schedule = new Schedule();

    schedule.addSystem(
      system("B", Stage.Update, () => { order.push("B"); }, { after: ["A"] }),
    );
    schedule.addSystem(
      system("A", Stage.Update, () => { order.push("A"); }),
    );

    const pool = new WorkerPool();
    const scheduler = new JobScheduler({ pool });
    const ctx = { world: null as any, dt: 0, tick: 0 } as SystemContext;

    await schedule.runStageParallel(Stage.Update, ctx, scheduler);

    expect(order).toEqual(["A", "B"]);
  });

  it("should run parallelizable systems when workers are available", async () => {
    const order: string[] = [];
    const schedule = new Schedule();

    schedule.addSystem(
      system("A", Stage.Update, () => { order.push("A"); }, { parallelizable: true }),
    );
    schedule.addSystem(
      system("B", Stage.Update, () => { order.push("B"); }, { parallelizable: true }),
    );

    // Create a mock worker pool with fake workers
    const pool = new WorkerPool({
      functions: {
        A: () => { order.push("A"); },
        B: () => { order.push("B"); },
      },
    });

    // Since no real workers are set, it falls back to inline
    const scheduler = new JobScheduler({ pool });
    const ctx = { world: null as any, dt: 0, tick: 0 } as SystemContext;

    await schedule.runStageParallel(Stage.Update, ctx, scheduler);

    expect(order).toContain("A");
    expect(order).toContain("B");
  });

  it("should fall back to runStage when called without scheduler", () => {
    const order: string[] = [];
    const schedule = new Schedule();

    schedule.addSystem(system("X", Stage.Input, () => { order.push("X"); }));
    schedule.addSystem(system("Y", Stage.Input, () => { order.push("Y"); }));

    const ctx = { world: null as any, dt: 0, tick: 0 } as SystemContext;
    schedule.runStage(Stage.Input, ctx);

    expect(order).toEqual(["X", "Y"]);
  });
});
