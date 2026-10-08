// session-tracker rAF tracking spec — the wrapped requestAnimationFrame must
// retire each one-shot id when its callback fires (not only on cancel), or
// s.rafIds grows unboundedly for the session's lifetime.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionTracker } from "./session-tracker";

const g = globalThis as any;

describe("SessionTracker rAF tracking", () => {
  let origRaf: any;
  let origCancel: any;
  let queue: Map<number, (ts: number) => void>;
  let nextId: number;

  function installFakeRaf(): void {
    queue = new Map();
    nextId = 1;
    g.requestAnimationFrame = (cb: (ts: number) => void) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    };
    g.cancelAnimationFrame = (id: number) => {
      queue.delete(id);
    };
  }

  function fire(id: number, ts = 0): void {
    const cb = queue.get(id);
    if (!cb) return;
    queue.delete(id);
    cb(ts);
  }

  const rafCount = (t: SessionTracker) => (t as any).session?.rafIds.size ?? -1;

  beforeEach(() => {
    origRaf = g.requestAnimationFrame;
    origCancel = g.cancelAnimationFrame;
  });

  afterEach(() => {
    g.requestAnimationFrame = origRaf;
    g.cancelAnimationFrame = origCancel;
  });

  it("retires the tracked id when the frame callback fires", () => {
    installFakeRaf();
    const t = new SessionTracker();
    t.attachRuntimeGlobals();
    t.beginSession();
    let ran = 0;
    const id = g.requestAnimationFrame(() => { ran++; });
    expect(rafCount(t)).toBe(1);
    fire(id);
    expect(ran).toBe(1);
    expect(rafCount(t)).toBe(0);
  });

  it("keeps rafIds bounded across a re-arming loop", () => {
    installFakeRaf();
    const t = new SessionTracker();
    t.attachRuntimeGlobals();
    t.beginSession();
    const loop = () => { g.requestAnimationFrame(loop); };
    const first = g.requestAnimationFrame(loop);
    for (let i = 0; i < 10; i++) fire(first + i);
    // Each fired frame re-armed exactly one new request — the set holds only
    // the currently-pending frame, not every historical id.
    expect(rafCount(t)).toBe(1);
  });

  it("cancelAnimationFrame still removes the tracked id", () => {
    installFakeRaf();
    const t = new SessionTracker();
    t.attachRuntimeGlobals();
    t.beginSession();
    let ran = 0;
    const id = g.requestAnimationFrame(() => { ran++; });
    g.cancelAnimationFrame(id);
    expect(rafCount(t)).toBe(0);
    fire(id);
    expect(ran).toBe(0);
  });

  it("a throwing callback still retires its id", () => {
    installFakeRaf();
    const t = new SessionTracker();
    t.attachRuntimeGlobals();
    t.beginSession();
    const id = g.requestAnimationFrame(() => { throw new Error("boom"); });
    expect(() => fire(id)).toThrow("boom");
    expect(rafCount(t)).toBe(0);
  });

  it("does not run the callback after the owning session dies", () => {
    installFakeRaf();
    const t = new SessionTracker();
    t.attachRuntimeGlobals();
    t.beginSession();
    let ran = 0;
    const id = g.requestAnimationFrame(() => { ran++; });
    (t as any).session.dead = true;
    fire(id);
    expect(ran).toBe(0);
  });
});
