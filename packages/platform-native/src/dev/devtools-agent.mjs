// ============================================================================
// devtools-agent.mjs — in-process agent for Bun/Node targets
//
// Plain .mjs (like dev-shell.mjs): it must load untransformed under bun,
// node, and deno — via dev-shell import (`draft dev --devtools-agent`),
// `bun --preload`, or a manual `import "@downdraft/platform-native/dev/
// devtools-agent.mjs"` for targets launched outside `draft`.
//
// On import it:
//   - opens the CDP inspector (Bun: real CDP over WS via inspector.open)
//   - wraps fetch() + WebSocket → Network events → feed
//   - wraps console.* → console events → feed (for non-mirror targets)
//   - exposes bun:jsc extras (heap snapshot, sampling profile, GC) via a
//     loopback command server (cmdPort in the discovery file)
//   - writes ~/.downdraft/devtools-agent/<pid>.json (+ legacy platinum-agent/)
//   - reads ~/.downdraft/devtools-feed.json (or legacy platinum-feed.json) for
//     the ingest endpoint
//
// The devtools-* discovery/feed filenames are the wire contract with the
// devtools viewer — keep in sync with apps/devtools. The platinum-* names are
// the pre-rename contract; we dual-write/dual-read so mixed-version
// agent/viewer pairs keep working.
//
// No-op outside supported runtimes; safe to ship in dev-only paths.
// ============================================================================

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const DD = join(homedir(), ".downdraft");
const AGENT_DIRS = [join(DD, "devtools-agent"), join(DD, "platinum-agent")];
const FEED_FILES = [join(DD, "devtools-feed.json"), join(DD, "platinum-feed.json")];

/** @typedef {{ pid: number, port: number, token: string }} FeedEp */

const g = /** @type {Record<string, unknown>} */ (globalThis);
if (g.__devtoolsAgent) {
  // already installed
} else {
  g.__devtoolsAgent = true;
  void boot();
}

/** @returns {FeedEp | null} */
function readFeed() {
  for (const f of FEED_FILES.values()) {
    try {
      if (!existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (!j.port || !j.token) continue;
      return j;
    } catch { /* try next */ }
  }
  return null;
}

const feedKey = randomBytes(8).toString("hex");
/** @type {FeedEp | null} */
let feed = null;
/** Unwrapped fetch for feed posts — captured before wrapNetwork() runs. Using
 * the wrapped fetch would post network events for feed posts → infinite loop. */
/** @type {typeof fetch | null} */
let sendFetch = null;
const QUEUE_CAP = 2000;
/** @type {unknown[]} */
let queue = [];
let dropped = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
/** @type {string | undefined} */
let cdpUrl;
let cmdPort = 0;
/** @type {string[]} */
const caps = [];

/** @param {unknown} msg */
function post(msg) {
  if (queue.length >= QUEUE_CAP) {
    // Hard cap — a pathological producer must never OOM the target host.
    // Report the drop count once per cap-hits instead of recursive posting.
    if (++dropped % 500 === 0) {
      queue.splice(0, QUEUE_CAP - 64);
      queue.push({ type: "event", label: `devtools-agent dropped ${dropped} msgs (queue full)` });
    }
    return;
  }
  queue.push(msg);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 400);
  }
}

async function flush() {
  flushTimer = null;
  if (!feed) feed = readFeed();
  if (!feed) { queue = []; setTimeout(flush, 3000); return; }
  // Batch cap — huge backlogs get trimmed, never fanned out into requests.
  const batch = queue.splice(0, 500);
  if (queue.length > 0) queue.splice(0, queue.length - 256);
  const f = sendFetch ?? fetch;
  const ep = feed;
  let failures = 0;
  await Promise.all(batch.map(async (m) => {
    try {
      const res = await f(`http://127.0.0.1:${ep.port}/feed`, {
        method: "POST",
        headers: { authorization: `Bearer ${ep.token}`, "content-type": "application/json" },
        body: JSON.stringify({ key: feedKey, ...(/** @type {object} */ (m)) }),
      });
      if (!res.ok) failures++;
    } catch { failures++; }
  }));
  // Viewer restarted on a new port — drop the cached endpoint and re-read.
  if (failures > 0 && failures >= batch.length) {
    feed = null;
    setTimeout(flush, 2000);
  }
}

async function boot() {
  AGENT_DIRS.forEach((d) => mkdirSync(d, { recursive: true }));

  // ── Inspector (CDP) ──
  try {
    const inspector = await import("node:inspector");
    if (typeof inspector.open === "function") {
      inspector.open(0, "127.0.0.1", false);
      cdpUrl = inspector.url() ?? undefined;
      if (cdpUrl) caps.push("cdp");
    }
  } catch { /* no inspector */ }

  // ── bun:jsc extras ──
  const isBun = typeof g.Bun !== "undefined";
  if (isBun) caps.push("jsc");
  caps.push("network", "console", "heap-stats");

  startCmdServer(isBun);
  wrapNetwork();
  wrapConsole();
  startHeapStats(isBun);
  writeDiscovery();

  // Re-announce on a slow cadence (the viewer may boot after us).
  const ann = setInterval(() => {
    if (FEED_FILES.some((f) => existsSync(f))) { clearInterval(ann); writeDiscovery(); }
  }, 2000);
  setTimeout(() => clearInterval(ann), 60_000);
}

function writeDiscovery() {
  const body = JSON.stringify({
    pid: process.pid, cdpUrl, feedKey, cmdPort, caps, startedAt: Date.now(),
  });
  for (const dir of AGENT_DIRS.values()) {
    try {
      writeFileSync(join(dir, `${process.pid}.json`), body, { mode: 0o600 });
    } catch { /* ignore */ }
  }
}

// ── fetch + WebSocket capture ──

let netSeq = 0;

function wrapNetwork() {
  const origFetch = /** @type {typeof fetch | undefined} */ (g.fetch);
  if (origFetch) sendFetch = origFetch;
  if (origFetch && !("__devtoolsWrapped" in origFetch)) {
    const wrapped = async (...args) => {
      const id = `agent-${process.pid}-${++netSeq}`;
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      const method = (args[1]?.method ?? args[0]?.method ?? "GET").toUpperCase();
      // Skip our own loopback endpoints (feed posts, cmd server pings).
      if (String(url).startsWith(`http://127.0.0.1:${cmdPort}`) || (feed && String(url).startsWith(`http://127.0.0.1:${feed.port}`))) {
        return origFetch(...args);
      }
      const t0 = Date.now() / 1000;
      post({ type: "network", event: { id, ts: t0, method, url: String(url), protocol: "fetch" } });
      try {
        const res = await origFetch(...args);
        const t1 = Date.now() / 1000;
        post({
          type: "network", event: {
            id, ts: t0, method, url: String(url), status: res.status,
            mime: res.headers.get("content-type") ?? undefined,
            durationMs: (t1 - t0) * 1000, resBytes: Number(res.headers.get("content-length") ?? 0), finished: true,
          },
        });
        return res;
      } catch (e) {
        post({ type: "network", event: { id, ts: t0, method, url: String(url), error: String(e), finished: true } });
        throw e;
      }
    };
    wrapped.__devtoolsWrapped = true;
    g.fetch = wrapped;
  }

  const WsG = /** @type {(new (url, protocols) => WebSocket) | undefined} */ (g.WebSocket);
  if (WsG && !("__devtoolsWrapped" in WsG)) {
    const WrappedWs = class extends WsG {
      constructor(url, protocols) {
        const u = String(url);
        super(u, protocols);
        post({ type: "network", event: { id: `agent-${process.pid}-ws-${++netSeq}`, ts: Date.now() / 1000, method: "WS", url: u, protocol: "ws" } });
      }
    };
    WrappedWs.__devtoolsWrapped = true;
    g.WebSocket = WrappedWs;
  }
}

// ── console capture (skip if the devtools mirror already captures — agents
//    that run under an app with a mirror would double-report; we send with
//    thread="agent" so rows are distinguishable/filterable) ──

function wrapConsole() {
  const levels = [["log", 0], ["info", 1], ["warn", 2], ["error", 3], ["debug", 4], ["trace", 5]];
  levels.forEach(([k, sev]) => {
    const orig = console[k];
    if (!orig || "__devtools" in orig) return;
    const wrapped = (...a) => {
      try {
        const text = a.map((x) => {
          try { return typeof x === "string" ? x : JSON.stringify(x)?.slice(0, 400) ?? String(x); }
          catch { return String(x); }
        }).join(" ");
        post({ type: "console", severity: sev, text, thread: "agent" });
      } catch { /* never break console */ }
      return orig.apply(console, a);
    };
    wrapped.__devtools = true;
    console[k] = wrapped;
  });
}

// ── heap stats metric every 2s ──

/** @param {boolean} isBun */
function startHeapStats(isBun) {
  setInterval(() => {
    try {
      if (isBun) {
        void import("bun:jsc").then((jsc) => {
          const stats = jsc.heapStats?.() ?? {};
          const now = Date.now() / 1000;
          const sz = stats.heapSize;
          if (sz !== undefined) {
            post({ type: "metric", series: { id: "agent.heap", label: "JSC heap", unit: "B" }, points: [[now, sz]] });
          }
          const oc = stats.objectCount;
          if (oc !== undefined) {
            post({ type: "metric", series: { id: "agent.objects", label: "JSC objects", unit: "count" }, points: [[now, oc]] });
          }
        }).catch(() => {});
      } else {
        const m = process.memoryUsage();
        const now = Date.now() / 1000;
        post({ type: "metric", series: { id: "agent.heap", label: "heapUsed", unit: "B" }, points: [[now, m.heapUsed]] });
        post({ type: "metric", series: { id: "agent.rss", label: "rss", unit: "B" }, points: [[now, m.rss]] });
      }
    } catch { /* ignore */ }
  }, 2000);
}

// ── command server: POST /snapshot | /profile/start | /profile/stop | /gc ──

/** @param {boolean} isBun */
function startCmdServer(isBun) {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const done = (o, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (!isBun) { done({ error: "jsc commands need bun" }, 400); return; }

    switch (url.pathname) {
      case "/snapshot":
        void import("bun:jsc").then((jsc) => {
          const stats = jsc.heapStats?.() ?? {};
          const counts = stats.objectTypeCounts ?? {};
          const classes = Object.entries(counts)
            .map(([name, count]) => ({ name, count, shallow: 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 120);
          post({ type: "heap", heap: {
            format: "jsc",
            totalBytes: stats.heapSize ?? 0,
            objectCount: stats.objectCount ?? 0,
            takenAt: Date.now() / 1000,
            classes,
          }});
          done({ ok: true, bytes: stats.heapSize ?? 0 });
        }).catch((e) => done({ error: String(e) }, 500));
        break;

      case "/profile/start":
        void import("bun:jsc").then((jsc) => {
          jsc.startSamplingProfiler?.();
          post({ type: "event", label: "JSC sampling profiler started" });
          done({ ok: true });
        }).catch((e) => done({ error: String(e) }, 500));
        break;

      case "/profile/stop":
        void import("bun:jsc").then((jsc) => {
          // samplingProfilerStackTraces() returns {interval, traces[]} —
          // flat stacks sampled since start (or since last call).
          const dump = jsc.samplingProfilerStackTraces?.();
          if (dump?.traces?.length) {
            post({ type: "profile", profile: jscToProfile(dump) });
          }
          done({ ok: true, samples: dump?.traces?.length ?? 0 });
        }).catch((e) => done({ error: String(e) }, 500));
        break;

      case "/gc":
        void import("bun:jsc").then((jsc) => { jsc.gcAndSweep?.(); done({ ok: true }); })
          .catch((e) => done({ error: String(e) }, 500));
        break;

      default:
        done({ error: "unknown", paths: ["/snapshot", "/profile/start", "/profile/stop", "/gc"] }, 404);
    }
  });
  srv.listen(0, "127.0.0.1", () => {
    const a = srv.address();
    cmdPort = typeof a === "object" && a ? a.port : 0;
    writeDiscovery();
  });
}

/**
 * Convert bun:jsc sampling traces → a real call tree: each trace is a full
 * stack (frames[0] = leaf); fold into shared nodes the way a CPU profile
 * does, so flame/bottom-up views work off node ids + samples.
 * Shape must match CpuProfile/ProfileNode in the viewer's targets/model.
 * @param {{ interval?: number, traces?: { timestamp?: number, frames?: { name?: string, sourceURL?: string, line?: number, category?: string }[] }[] }} dump
 */
function jscToProfile(dump) {
  const nodes = [
    { id: 0, functionName: "(root)", url: "", line: -1, hitCount: 0, children: /** @type {number[]} */ ([]) },
  ];
  /** @type {number[]} */
  const samples = [];
  /** @type {number[]} */
  const deltas = [];
  const childIdx = new Map(); // `${parentId}|${key}` → node id
  /** @type {number | undefined} */
  let lastTs;

  const frameId = (parent, f) => {
    const name = f.name ?? "(anon)";
    const key = `${parent}|${name}@${f.sourceURL ?? ""}:${f.line ?? 0}:${f.category ?? ""}`;
    let id = childIdx.get(key);
    if (id === undefined) {
      id = nodes.length;
      childIdx.set(key, id);
      nodes.push({ id, functionName: name, url: f.sourceURL ?? "", line: f.line ?? 0, hitCount: 0, children: [] });
      nodes[parent].children.push(id);
    }
    return id;
  };

  (dump.traces ?? []).forEach((st) => {
    // JSC frames[0] = leaf; reverse to walk root→leaf.
    const frames = [...(st.frames ?? [])].reverse();
    let parent = 0;
    frames.forEach((f) => { parent = frameId(parent, f); });
    nodes[parent].hitCount++;
    samples.push(parent);
    const ts = st.timestamp ?? 0;
    deltas.push(lastTs === undefined ? 1000 : Math.max(1, Math.round((ts - lastTs) * 1e6)));
    lastTs = ts;
  });
  nodes[0].hitCount = samples.length;
  return { nodes, startUs: 0, endUs: deltas.reduce((a, b) => a + b, 0), samples, timeDeltasUs: deltas, source: "jsc" };
}
