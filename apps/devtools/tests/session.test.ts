import { describe, test, expect, afterEach } from "bun:test";
import { TargetSession } from "../src/targets/session";
import { sleep } from "./helpers";

// TargetSession with a bare {pid} endpoint attaches only the procfs channel —
// no network — which makes it safe to exercise in-process.
let s: TargetSession | null = null;
afterEach(() => { s?.dispose(); s = null; });

function mk(pid = process.pid): TargetSession {
  s = new TargetSession({ pid });
  return s;
}

describe("TargetSession basics", () => {
  test("procfs channel attaches and yields caps + a name", () => {
    const sess = mk();
    expect(sess.procfs).not.toBeNull();
    expect(sess.caps.has("procfs")).toBe(true);
    expect(sess.name.length).toBeGreaterThan(0);
    expect(sess.channelFlags().procfs).toBe(true);
  });

  test("console entries are sequenced and capped at 8000", () => {
    const sess = mk();
    for (let i = 0; i < 8010; i++) {
      sess.addEntry({ ts: i, source: "log", severity: 0, thread: "main", text: `m${i}` });
    }
    expect(sess.consoleEntries).toHaveLength(8000);
    expect(sess.consoleEntries[0]?.text).toBe("m10");
    expect(sess.consoleEntries[7999]?.text).toBe("m8009");
  });

  test("feedPoint creates a feed-group series", () => {
    const sess = mk();
    sess.feedPoint("cpu.a", "CPU", "%", 1000, 5);
    const ser = sess.series.get("cpu.a");
    expect(ser).toBeDefined();
    expect(ser?.group).toBe("feed:cpu");
    expect(ser?.v).toEqual([5]);
  });

  test("network events merge by id", () => {
    const sess = mk();
    sess.pushNetworkEvent({ id: "n1", ts: 1, method: "GET", url: "http://a/" });
    sess.pushNetworkEvent({ id: "n1", ts: 1, method: "GET", url: "http://a/", status: 200, finished: true });
    expect(sess.network).toHaveLength(1);
    expect(sess.network[0]?.status).toBe(200);
    expect(sess.network[0]?.finished).toBe(true);
  });

  test("eval with no channel reports 'no eval channel'", async () => {
    const out = await mk().eval("1+1");
    expect(out.error).toBe("no eval channel");
  });

  test("repl echoes then rejects without an eval channel", async () => {
    const sess = mk();
    // repl's body runs synchronously — the pending result row exists before
    // the eval promise resolves.
    const pr = sess.repl("1+1");
    const pending = sess.consoleEntries.find((e) => e.source === "repl-result");
    expect(pending?.asyncState).toBe("pending");
    const { echo, result } = await pr;
    expect(echo.source).toBe("repl-echo");
    await sleep(5);
    expect(result.asyncState).toBe("rejected");
    expect(result.text).toBe("no eval channel");
  });

  test("profileStart without a profiling channel notes the miss", async () => {
    const sess = mk();
    const started = await sess.profileStart();
    expect(started).toBe(false);
    expect(sess.profiling).toBe(false);
    expect(sess.consoleEntries.some((e) => e.text.includes("no CPU profiling channel"))).toBe(true);
  });

  test("heapSnapshot without an agent notes the failure", async () => {
    const sess = mk();
    expect(await sess.heapSnapshot()).toBe(false);
    expect(sess.consoleEntries.some((e) => e.severity === 3 && e.text.includes("heap snapshot failed"))).toBe(true);
  });

  test("consoleClear empties the log", async () => {
    const sess = mk();
    sess.addEntry({ ts: 1, source: "log", severity: 0, thread: "main", text: "x" });
    await sess.consoleClear();
    expect(sess.consoleEntries).toHaveLength(0);
  });

  test("markEvent records lifecycle markers", () => {
    const sess = mk();
    sess.markEvent("attach", "test marker", "detail");
    expect(sess.events.some((e) => e.label === "test marker" && e.kind === "attach")).toBe(true);
  });
});
