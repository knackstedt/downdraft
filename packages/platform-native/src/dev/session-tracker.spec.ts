// session-tracker one-shot tracking spec — the wrapped rAF/setTimeout/
// setImmediate must retire each one-shot id when its callback fires (not
// only on cancel/clear), or the session's id sets grow unboundedly for the
// session's lifetime — pinning every timer handle + closure env (the
// ~200MB dev-shell heap leak this regression guards).

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

describe("SessionTracker timer tracking", () => {
  let origTimeout: any, origClearTimeout: any, origImmediate: any, origClearImmediate: any;
  let timeouts: Map<number, () => void>, immediates: Map<number, () => void>;
  let nextTid: number, nextIid: number;

  function installFakeTimers(): void {
    timeouts = new Map(); immediates = new Map();
    nextTid = 1; nextIid = 1;
    g.setTimeout = (fn: () => void, _ms?: number) => { const id = nextTid++; timeouts.set(id, fn); return id; };
    g.clearTimeout = (id: number) => { timeouts.delete(id); };
    g.setImmediate = (fn: () => void) => { const id = nextIid++; immediates.set(id, fn); return id; };
    g.clearImmediate = (id: number) => { immediates.delete(id); };
  }
  function fireTimeout(id: number): void {
    const fn = timeouts.get(id);
    if (!fn) return;
    timeouts.delete(id);
    fn();
  }
  function fireImmediate(id: number): void {
    const fn = immediates.get(id);
    if (!fn) return;
    immediates.delete(id);
    fn();
  }

  const timeoutCount = (t: SessionTracker) => (t as any).session?.timeouts.size ?? -1;
  const immediateCount = (t: SessionTracker) => (t as any).session?.immediates.size ?? -1;

  beforeEach(() => {
    origTimeout = g.setTimeout; origClearTimeout = g.clearTimeout;
    origImmediate = g.setImmediate; origClearImmediate = g.clearImmediate;
  });
  afterEach(() => {
    g.setTimeout = origTimeout; g.clearTimeout = origClearTimeout;
    g.setImmediate = origImmediate; g.clearImmediate = origClearImmediate;
  });

  it("retires the tracked id when the timeout fires", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    let ran = 0;
    const id = g.setTimeout(() => { ran++; }, 8);
    expect(timeoutCount(t)).toBe(1);
    fireTimeout(id);
    expect(ran).toBe(1);
    expect(timeoutCount(t)).toBe(0);
  });

  it("keeps timeouts bounded across a re-arming loop", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    // damageIdle-keepalive shape: each fire re-arms a fresh timeout — the
    // set must hold only the currently-armed one.
    const rearm = () => { g.setTimeout(rearm, 50); };
    const first = g.setTimeout(rearm, 50);
    for (let i = 0; i < 10; i++) fireTimeout(first + i);
    expect(timeoutCount(t)).toBe(1);
  });

  it("clearTimeout still removes the tracked id", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    let ran = 0;
    const id = g.setTimeout(() => { ran++; }, 8);
    g.clearTimeout(id);
    expect(timeoutCount(t)).toBe(0);
    fireTimeout(id);
    expect(ran).toBe(0);
  });

  it("a throwing callback still retires its id", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    const id = g.setTimeout(() => { throw new Error("boom"); }, 8);
    expect(() => fireTimeout(id)).toThrow("boom");
    expect(timeoutCount(t)).toBe(0);
  });

  it("does not run the callback after the owning session dies", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    let ran = 0;
    const id = g.setTimeout(() => { ran++; }, 8);
    (t as any).session.dead = true;
    fireTimeout(id);
    expect(ran).toBe(0);
  });

  it("retires the tracked id when the immediate fires", () => {
    installFakeTimers();
    const t = new SessionTracker();
    t.installGlobalWraps();
    t.beginSession();
    let ran = 0;
    const id = g.setImmediate(() => { ran++; });
    expect(immediateCount(t)).toBe(1);
    fireImmediate(id);
    expect(ran).toBe(1);
    expect(immediateCount(t)).toBe(0);
  });
});
