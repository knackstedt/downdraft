import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FeedServer } from "../src/targets/feed-server";
import { SessionManager } from "../src/targets/registry";
import { TargetSession } from "../src/targets/session";
import { waitFor } from "./helpers";

// Full loop: spawn a target process with the devtools agent injected → agent
// writes its discovery file (under an isolated HOME) → we route its feedKey →
// console/fetch events arrive over the feed → CDP eval + agent cmd server.
// No GPU, no mirror — the channel surface every Bun/Node target gets.
// The canonical agent module is the CLI/engine asset the dev shell injects
// (packages/platform-native/src/dev/devtools-agent.mjs) — this test exercises
// exactly what `draft dev --devtools-agent` loads.

const AGENT = pathToFileURL(join(__dirname, "..", "..", "..", "packages", "platform-native", "src", "dev", "devtools-agent.mjs")).href;

const home = mkdtempSync(join(tmpdir(), "devtools-e2e-"));
const mgr = new SessionManager();
const feed = new FeedServer(mgr);

let child: ChildProcess | null = null;
let session: TargetSession | null = null;

afterAll(async () => {
  child?.kill("SIGTERM");
  if (child) await Promise.race([new Promise((r) => child!.once("exit", r)), waitFor(() => false, 3000)]);
  session?.dispose();
  await feed.stop();
  mgr.stop();
  rmSync(home, { recursive: true, force: true });
  // Best-effort: if HOME failed to propagate the agent file landed in the
  // real discovery dir — don't leave it there.
  if (child?.pid) {
    try { unlinkSync(join(homedir(), ".downdraft", "devtools-agent", `${child.pid}.json`)); } catch { /* not there */ }
  }
});

describe("agent → feed → session e2e", () => {
  test("discovery → attach → console feed → cdp eval → agent commands → detach", async () => {
    const port = await feed.start(0);
    mkdirSync(join(home, ".downdraft"), { recursive: true });
    writeFileSync(
      join(home, ".downdraft", "devtools-feed.json"),
      JSON.stringify({ pid: process.pid, port, token: feed.feedToken, startedAt: Date.now() }),
    );

    const marker = `e2e-marker-${Date.now()}`;
    const scriptPath = join(home, "target.ts");
    writeFileSync(scriptPath, [
      `import ${JSON.stringify(AGENT)};`,
      // The agent installs its console wrapper during async boot — delay the
      // marker so wrapConsole is live, and repeat it for good measure.
      `setTimeout(() => console.log(${JSON.stringify(marker)}), 400);`,
      `setInterval(() => console.log(${JSON.stringify(marker + "-tick")}), 1500);`,
      `setInterval(() => {}, 250);`,
      "",
    ].join("\n"));

    child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "inherit", "inherit"],
    });
    expect(child.pid).toBeDefined();

    // ── Discovery file lands with feedKey; cmdPort fills in on re-announce ──
    const agentFile = join(home, ".downdraft", "devtools-agent", `${child.pid}.json`);
    expect(await waitFor(() => existsSync(agentFile), 10_000)).toBe(true);

    let disc = {} as { pid: number; cdpUrl?: string; feedKey?: string; cmdPort?: number; caps?: string[] };
    expect(await waitFor(() => {
      try { disc = JSON.parse(readFileSync(agentFile, "utf8")); } catch { return false; }
      return typeof disc.cmdPort === "number" && disc.cmdPort > 0;
    }, 10_000)).toBe(true);

    expect(disc.pid).toBe(child.pid!);
    expect(disc.feedKey).toBeTruthy();
    expect(disc.caps).toContain("console");
    expect(disc.caps).toContain("network");
    expect(disc.caps).toContain("heap-stats");

    // ── Route the feed key + attach the session ──
    feed.routeKey(disc.feedKey!, child.pid!);
    session = new TargetSession({
      pid: child.pid!,
      agent: { cdpUrl: disc.cdpUrl, feedKey: disc.feedKey, cmdPort: disc.cmdPort, caps: disc.caps },
    });
    mgr.sessions.set(child.pid!, session);

    // ── Console marker arrives over the feed ──
    expect(await waitFor(() => session!.consoleEntries.some((e) => e.text.includes(marker)), 12_000)).toBe(true);

    // ── Agent cmd server answers ──
    const gc = await session.agentCall("/gc") as { ok?: boolean; error?: string };
    expect(gc.ok).toBe(true);

    const snap = await session.agentCall("/snapshot") as { ok?: boolean; error?: string };
    expect(snap.ok).toBe(true);
    expect(await waitFor(() => session!.heapSnapshots.length > 0, 8000)).toBe(true);
    expect(session.heapSnapshots[0]?.format).toBe("jsc");

    // ── CDP channel: the agent opened the inspector; eval round-trips ──
    expect(disc.cdpUrl).toBeTruthy();
    expect(await waitFor(() => session!.cdp?.connected ?? false, 10_000)).toBe(true);
    const out = await session.eval("21 * 2");
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);

    // ── Agent metric pushes build series ──
    expect(await waitFor(() => session!.series.has("agent.heap"), 8000)).toBe(true);
  }, 60_000);
});
