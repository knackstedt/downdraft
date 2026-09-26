#!/usr/bin/env node
// Per-game runtime benchmark for the native↔electron comparison.
//
//   node scripts/bench-runtime.mjs <game> <native|electron> [--settle=8] [--sample=15] [--timeout=90]
//
// Launches the game, waits for MCP readiness (PID-file discovery under
// ~/.downdraft/port), samples process_snapshot + world/UI state for the
// sample window, captures a screenshot, scans the log for errors, and
// prints one JSON result line to stdout. The game process tree is killed
// on exit.

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PORT_DIR = join(homedir(), ".downdraft", "port");
// One-shot MCP calls go through `draft mcp` (the script it replaced,
// scripts/mcp-call.mjs, was a hand-rolled copy of the same protocol).
const MCP_CLI = join(ROOT, "packages", "cli", "src", "index.ts");

const [game, runtime] = process.argv.slice(2);
if (!game || !["native", "electron"].includes(runtime)) {
  console.error("usage: bench-runtime.mjs <game> <native|electron> [--settle=8] [--sample=15]");
  process.exit(2);
}
const argVal = (name, dflt) => {
  const a = process.argv.find((a) => a.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : dflt;
};
const SETTLE_S = argVal("settle", 8);
const SAMPLE_S = argVal("sample", 15);
const BOOT_TIMEOUT_MS = argVal("timeout", 90) * 1000;
const NO_MCP = process.argv.includes("--no-mcp");

const gameDir = join(ROOT, "games", game);
const logPath = `/tmp/bench-${game}-${runtime}.log`;
const shotPath = `/tmp/bench-${game}-${runtime}.png`;
const out = { game, runtime, ok: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portEntries() {
  try {
    return readdirSync(PORT_DIR)
      .filter((n) => /^\d+$/.test(n))
      .map((n) => ({ pid: Number(n), port: Number(readFileSync(join(PORT_DIR, n), "utf8").trim()), mtime: statSync(join(PORT_DIR, n)).mtimeMs }))
      .filter((e) => Number.isFinite(e.port));
  } catch {
    return [];
  }
}

function mcp(tool, args = {}, pid, timeoutMs = 30000, extraEnv = {}) {
  try {
    const res = execFileSync("bun", [MCP_CLI, "mcp", "call", tool, JSON.stringify(args)], {
      env: { ...process.env, MCP_PID: String(pid), ...extraEnv },
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, text: res.trim() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).toString().slice(0, 300) };
  }
}

// Sum RSS + CPU jiffies across the whole spawned process group (detached
// spawn ⇒ pgid === child.pid). Works identically for both runtimes —
// Electron spreads work across main/renderer/GPU/utility processes, so
// single-process MCP snapshots are not comparable.
function groupStats(pgid) {
  let rss = 0, jiffies = 0, procs = 0;
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${e}/stat`, "utf8"); } catch { continue; }
    // comm may contain spaces/parens — fields after the LAST ')' are reliable.
    const rp = stat.lastIndexOf(")");
    if (rp < 0) continue;
    const f = stat.slice(rp + 2).split(" ");
    // f[0]=state, f[2]=ppid, f[3]=pgrp, f[11]=utime, f[12]=stime
    if (Number(f[3]) !== pgid) continue;
    try {
      const status = readFileSync(`/proc/${e}/status`, "utf8");
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) rss += Number(m[1]) * 1024;
      jiffies += Number(f[11]) + Number(f[12]);
      procs++;
    } catch {}
  }
  return { rss, jiffies, procs };
}

const findNum = (obj, re) => {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "object") {
      const r = findNum(v, re);
      if (r !== null) return r;
    }
  }
  return null;
};

const parseJson = (r) => {
  if (!r?.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
};

// ── Launch ──
const before = new Set(portEntries().map((e) => e.pid));
writeFileSync(logPath, ""); // truncate before spawn — createWriteStream truncates async
const logStream = createWriteStream(logPath);

let cmd, args, cwd;
if (runtime === "native") {
  cmd = "bun";
  args = ["run", "src/native-entry.ts"];
  cwd = gameDir;
} else {
  // Match dev.ts/harness: electron-vite runs from the monorepo root with a
  // repo-relative config path (game package.json lacks "main").
  cmd = join(ROOT, "node_modules", ".bin", "electron-vite");
  args = ["dev", "--config", `games/${game}/electron.vite.config.ts`];
  cwd = ROOT;
}

const t0 = Date.now();
const child = spawn(cmd, args, { cwd, detached: true, env: process.env });
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);
out.spawnPid = child.pid;

// ── Wait for readiness: MCP port file, or a renderer-init log marker when
// the game has MCP disabled (gpu-bench sets features.mcp=false). ──
let inst = null;
if (NO_MCP) {
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    try {
      if (/GameRenderer\] initialized|initialized successfully|test module\(s\)|ready/i.test(readFileSync(logPath, "utf8"))) break;
    } catch {}
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  out.bootMs = Date.now() - t0;
  out.mcpReadyMs = out.bootMs;
} else {
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    const fresh = portEntries().filter((e) => !before.has(e.pid));
    if (fresh.length > 0) { inst = fresh.sort((a, b) => b.mtime - a.mtime)[0]; break; }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  if (!inst) {
    out.error = `no MCP port file within ${BOOT_TIMEOUT_MS}ms`;
    finish();
    await new Promise(() => {}); // finish() exits via setTimeout
  }
  out.bootMs = Date.now() - t0;
  out.mcpPid = inst.pid;
  out.mcpPort = inst.port;
}

// Wait until the harness is actually answering tool calls (Electron proxies
// into the renderer — tools register after window-ready).
if (inst) {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const probe = mcp("get_ui_state", {}, inst.pid, 10000);
    if (probe.ok) { ready = true; break; }
    const probe2 = mcp("process_snapshot", {}, inst.pid, 10000);
    if (probe2.ok) { ready = true; break; }
    await sleep(500);
  }
  out.mcpReadyMs = Date.now() - t0;
  if (!ready) {
    out.error = "MCP port up but tool calls never succeeded";
    finish();
    await new Promise(() => {});
  }
}

// ── Settle, then sample ──
await sleep(SETTLE_S * 1000);

const ui0 = inst ? parseJson(mcp("get_ui_state", {}, inst.pid)) : null;
const ws0 = inst ? parseJson(mcp("get_world_state", {}, inst.pid)) : null;
const tick0 = findNum(ws0, /^tick$|tickCount|^tick$/i) ?? findNum(ui0, /^tick$/i);
const ts0 = Date.now();

const snaps = [];
const group = [];
const sampleEnd = ts0 + SAMPLE_S * 1000;
while (Date.now() < sampleEnd) {
  if (inst) {
    const s = mcp("process_snapshot", {}, inst.pid);
    if (s.ok) snaps.push({ t: Date.now(), data: parseJson(s) });
  }
  group.push({ t: Date.now(), ...groupStats(child.pid) });
  await sleep(3000);
}

const ws1 = inst ? parseJson(mcp("get_world_state", {}, inst.pid)) : null;
const ui1 = inst ? parseJson(mcp("get_ui_state", {}, inst.pid)) : null;
const tick1 = findNum(ws1, /^tick$|tickCount/i) ?? findNum(ui1, /^tick$/i);
const elapsed = (Date.now() - ts0) / 1000;

if (tick0 !== null && tick1 !== null) out.tickRate = (tick1 - tick0) / elapsed;
out.fps = findNum(ui1, /fps/i) ?? findNum(ui0, /fps/i);

// Fold snapshots into rss/heap/cpu metrics. cpuUser/cpuSystem are cumulative
// microseconds (process.cpuUsage) — diff first↔last for a real %.
const rsses = [], heaps = [];
for (const s of snaps) {
  const rss = findNum(s.data, /^rss$/i); if (rss) rsses.push(rss);
  const heap = findNum(s.data, /heapUsed|heap_used/i); if (heap) heaps.push(heap);
}
if (rsses.length) out.rssMB = Math.max(...rsses) / (1024 * 1024);
if (heaps.length) out.heapMB = Math.max(...heaps) / (1024 * 1024);
if (snaps.length >= 2) {
  const a = snaps[0], b = snaps[snaps.length - 1];
  const cpuA = (findNum(a.data, /cpuUser/i) ?? 0) + (findNum(a.data, /cpuSystem/i) ?? 0);
  const cpuB = (findNum(b.data, /cpuUser/i) ?? 0) + (findNum(b.data, /cpuSystem/i) ?? 0);
  const wallUs = (b.t - a.t) * 1000;
  if (wallUs > 0 && cpuB >= cpuA) out.procCpuPct = ((cpuB - cpuA) / wallUs) * 100;
}
// Whole-tree metrics (primary, comparable across runtimes).
if (group.length) {
  out.treeRssMB = Math.max(...group.map((g) => g.rss)) / (1024 * 1024);
  out.treeProcs = Math.max(...group.map((g) => g.procs));
}
if (group.length >= 2) {
  const a = group[0], b = group[group.length - 1];
  const wallMs = b.t - a.t;
  if (wallMs > 0 && b.jiffies >= a.jiffies) {
    out.treeCpuPct = ((b.jiffies - a.jiffies) / (wallMs / 10)) * 100; // CLK_TCK=100
  }
}

// ── Screenshot ──
// `draft mcp screenshot` writes the image block straight to a file — no
// base64 round-trip through stdout.
if (inst) {
  const shot = (() => {
    try {
      execFileSync("bun", [MCP_CLI, "mcp", "screenshot", shotPath], {
        env: { ...process.env, MCP_PID: String(inst.pid) },
        timeout: 30000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || String(e)).toString().slice(0, 300) };
    }
  })();
  out.screenshot = { ok: shot.ok };
  if (shot.ok) {
    out.screenshot.bytes = statSync(shotPath).size;
    out.screenshot.path = shotPath;
  } else {
    out.screenshot.error = shot.error;
  }
} else {
  out.screenshot = { ok: false, error: "no MCP" };
}

// ── Error scan ──
try {
  const log = readFileSync(logPath, "utf8");
  const errs = log.split("\n").filter((l) => /error|uncaught|unhandled|failed/i.test(l) && !/errorResult|0 errors|error:|stderr/i.test(l));
  out.logErrors = [...new Set(errs)].slice(0, 15);
  out.logPath = logPath;
} catch {}

out.ok = true;
finish();

function finish() {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  try { if (inst) process.kill(inst.pid, "SIGTERM"); } catch {}
  // Stale-instance cleanup: kill anything still bound to this game's dirs.
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { if (inst) process.kill(inst.pid, "SIGKILL"); } catch {}
    console.log(JSON.stringify(out));
    process.exit(out.ok ? 0 : 1);
  }, 2500);
}
