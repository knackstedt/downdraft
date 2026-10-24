import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SessionManager } from "../src/targets/registry";
import { FeedServer, type FeedMessage } from "../src/targets/feed-server";

// Real loopback HTTP — exercises auth, routing keys, and every feed message
// type against a live session model.
const mgr = new SessionManager();
const feed = new FeedServer(mgr);
let port = 0;

beforeAll(async () => { port = await feed.start(0); });
afterAll(async () => { await feed.stop(); mgr.stop(); });

function post(msg: FeedMessage | string, auth: string | false | undefined): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== false) headers.authorization = `Bearer ${auth ?? feed.feedToken}`;
  return fetch(`http://127.0.0.1:${port}/feed`, { method: "POST", headers, body: typeof msg === "string" ? msg : JSON.stringify(msg) });
}

describe("FeedServer transport", () => {
  test("GET /health is unauthenticated", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  test("POST /feed requires the bearer token", async () => {
    expect((await post({ type: "event", label: "x" }, false)).status).toBe(401);
    expect((await post({ type: "event", label: "x" }, "wrong-token")).status).toBe(401);
    expect((await post({ type: "event", label: "x" }, undefined)).status).toBe(200);
  });

  test("malformed JSON is a 400, unknown paths 404", async () => {
    expect((await post("{ not json", undefined)).status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("feed → session routing", () => {
  test("key-routed console/metric/event/network/snapshot/heap land on the session", async () => {
    const s = mgr.attachManual({ pid: process.pid });
    feed.routeKey("k1", process.pid);

    await post({ key: "k1", type: "console", text: "feed-marker", severity: 2 }, undefined);
    const entry = s.consoleEntries.find((e) => e.text === "feed-marker");
    expect(entry).toBeDefined();
    expect(entry?.thread).toBe("feed");
    expect(entry?.severity).toBe(2);

    await post({ key: "k1", type: "metric", series: { id: "x.cpu", label: "X", unit: "%" }, points: [[1000, 5], [1001, 7]] }, undefined);
    expect(s.series.get("x.cpu")?.v).toEqual([5, 7]);

    await post({ key: "k1", type: "event", label: "boom", detail: "d" }, undefined);
    expect(s.events.some((e) => e.label === "boom" && e.kind === "feed")).toBe(true);

    await post({ key: "k1", type: "hmr", label: "reload-now" }, undefined);
    expect(s.events.some((e) => e.kind === "hmr")).toBe(true);
    expect(s.consoleEntries.some((e) => e.text.includes("reload-now"))).toBe(true);

    await post({ key: "k1", type: "network", event: { id: "n1", ts: 1, method: "GET", url: "http://a/" } }, undefined);
    expect(s.network.some((n) => n.id === "n1")).toBe(true);

    await post({ key: "k1", type: "snapshot", panel: "ext", snap: { sections: [] } }, undefined);
    expect(s.providers.some((p) => p.name === "feed:ext" && p.lastSnapshot)).toBe(true);

    await post({ key: "k1", type: "heap", heap: { format: "jsc", totalBytes: 2048, objectCount: 9, takenAt: 1, classes: [] } }, undefined);
    expect(s.heapSnapshots).toHaveLength(1);
    expect(s.heapSnapshots[0]?.totalBytes).toBe(2048);
  });

  test("unkeyed pushes land on the -9000 pseudo-target", async () => {
    await post({ type: "console", text: "anon-msg" }, undefined);
    const s = mgr.sessions.get(-9000);
    expect(s).toBeDefined();
    expect(s?.consoleEntries.some((e) => e.text === "anon-msg")).toBe(true);
  });

  test("explicit pid field routes without a key", async () => {
    await post({ pid: process.pid, type: "event", label: "pid-routed" }, undefined);
    const s = mgr.sessions.get(process.pid);
    expect(s?.events.some((e) => e.label === "pid-routed")).toBe(true);
  });
});
