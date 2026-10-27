import { afterEach, describe, expect, test } from "bun:test";
import { store } from "../src/app/store";
import { SessionManager } from "../src/targets/registry";

// Embedded mounts call sessions.setSelfTarget(process.pid) — the host app
// is a legitimate target there. The standalone viewer never sets it, and
// its own pid must stay invisible.

type MgrPriv = { onDiscovery(added: unknown[], removed: number[]): void };
const feed = (mgr: SessionManager, eps: { pid: number; mirror?: boolean }[]) =>
  (mgr as unknown as MgrPriv).onDiscovery(
    eps.map((e) => ({
      pid: e.pid,
      mirror: e.mirror ? { url: "ws://127.0.0.1:1/ws?t=x", token: "x", port: 1 } : undefined,
    })),
    [],
  );

describe("SessionManager self-target", () => {
  const mgrs: SessionManager[] = [];
  afterEach(() => {
    mgrs.forEach((m) => m.stop());
    mgrs.length = 0;
    store.setState({ activeTargetId: null });
  });
  const mk = () => { const m = new SessionManager(); mgrs.push(m); return m; };

  test("own pid is skipped by default", () => {
    const mgr = mk();
    feed(mgr, [{ pid: process.pid }]);
    expect(mgr.sessions.has(process.pid)).toBe(false);
  });

  test("setSelfTarget registers this process as a session with isSelf", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    feed(mgr, [{ pid: process.pid }]);
    const s = mgr.sessions.get(process.pid);
    expect(s).toBeDefined();
    expect(s?.isSelf).toBe(true);
  });

  test("self session becomes active when nothing was chosen", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    feed(mgr, [{ pid: 999_999_999 }, { pid: process.pid }]);
    expect(store.getState().activeTargetId).toBe(`pid-${process.pid}`);
  });

  test("self does not override an already-active target", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    feed(mgr, [{ pid: 999_999_999 }]); // first target wins the default active slot
    expect(store.getState().activeTargetId).toBe("pid-999999999");
    feed(mgr, [{ pid: process.pid }]);
    expect(store.getState().activeTargetId).toBe("pid-999999999");
  });

  test("clearing selfPid reverts to skipping own pid", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    mgr.setSelfTarget(null);
    feed(mgr, [{ pid: process.pid }]);
    expect(mgr.sessions.has(process.pid)).toBe(false);
  });

  test("isSelf flows into the store's target list", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    feed(mgr, [{ pid: process.pid }]);
    const t = store.getState().targets.find((x) => x.pid === process.pid);
    expect(t?.isSelf).toBe(true);
  });

  test("pin mode takes the active slot even when another target won the race", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid, { pin: true });
    feed(mgr, [{ pid: 999_999_999 }]); // unrelated target wins the initial slot
    expect(store.getState().activeTargetId).toBe("pid-999999999");
    feed(mgr, [{ pid: process.pid }]); // self discovered later — still takes over
    expect(store.getState().activeTargetId).toBe(`pid-${process.pid}`);
  });

  test("pin mode claims an already-existing self session immediately", () => {
    const mgr = mk();
    mgr.setSelfTarget(process.pid);
    feed(mgr, [{ pid: 999_999_999 }, { pid: process.pid }]);
    store.setState({ activeTargetId: "pid-999999999" });
    mgr.setSelfTarget(process.pid, { pin: true });
    expect(store.getState().activeTargetId).toBe(`pid-${process.pid}`);
  });
});
