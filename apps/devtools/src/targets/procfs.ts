// ============================================================================
// procfs.ts — external /proc/<pid> sampler. Works for ANY local target —
// CPU (utime+stime%), RSS, I/O counters (rchar/wchar/syscr/syscw), fd count,
// thread count + per-task CPU — all without target cooperation.
// ============================================================================

import { readFileSync, readdirSync, existsSync, readlinkSync } from "node:fs";
import { createLogger } from "@downdraft/engine/util/logger";

const _log = createLogger();

export interface ProcSample {
  ts: number;               // seconds
  cpuPercent: number;       // delta-based
  rssBytes: number;
  ioReadBytes: number;      // cumulative
  ioWriteBytes: number;
  ioReadRate: number;       // B/s
  ioWriteRate: number;
  ioReadOps: number;        // syscr rate (ops/s)
  ioWriteOps: number;       // syscw rate
  fdCount: number;
  threadCount: number;
  tasks: { tid: number; name: string; cpuPercent: number }[];
}

interface PrevRaw {
  ts: number;
  utime: number; stime: number;
  rchar: number; wchar: number; syscr: number; syscw: number;
  tasks: Map<number, { name: string; u: number; s: number }>;
}

const CLK = 100; // sysconf(_SC_CLK_TCK) — standard 100

function readStat(pid: number): { utime: number; stime: number; rss: number; threads: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parens — fields after ')'.
    const close = raw.lastIndexOf(")");
    const f = raw.slice(close + 2).split(" ");
    // f[0]=state … utime=f[11], stime=f[12], num_threads=f[17], rss=f[21]
    return { utime: Number(f[11]), stime: Number(f[12]), threads: Number(f[17]) || 1, rss: (Number(f[21]) || 0) * 4096 };
  } catch { return null; }
}

function readTaskStat(pid: number, tid: number): { name: string; utime: number; stime: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
    const open = raw.indexOf("(");
    const close = raw.lastIndexOf(")");
    const name = raw.slice(open + 1, close);
    const f = raw.slice(close + 2).split(" ");
    return { name, utime: Number(f[11]), stime: Number(f[12]) };
  } catch { return null; }
}

export class ProcfsSampler {
  private prev: PrevRaw | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dead = 0;

  constructor(
    private pid: number,
    private onSample: (s: ProcSample) => void,
  ) {}

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): void {
    const pid = this.pid;
    const stat = readStat(pid);
    if (!stat) {
      if (++this.dead > 3) this.stop();
      return;
    }
    this.dead = 0;
    const ts = Date.now() / 1000;

    let io = { rchar: 0, wchar: 0, syscr: 0, syscw: 0 };
    try {
      const ioRaw = readFileSync(`/proc/${pid}/io`, "utf8");
      const kv = Object.fromEntries(ioRaw.trim().split("\n").map((l) => l.split(": ") as [string, string]));
      io = { rchar: Number(kv.rchar), wchar: Number(kv.wchar), syscr: Number(kv.syscr), syscw: Number(kv.syscw) };
    } catch { /* io may be restricted */ }

    let fdCount = 0;
    try { fdCount = readdirSync(`/proc/${pid}/fd`).length; } catch { /* restricted */ }

    const tasks = new Map<number, { name: string; u: number; s: number }>();
    try {
      readdirSync(`/proc/${pid}/task`).forEach((t) => {
        const tid = Number(t);
        const st = readTaskStat(pid, tid);
        if (st) tasks.set(tid, { name: st.name, u: st.utime, s: st.stime });
      });
    } catch { /* restricted */ }

    const prev = this.prev;
    let cpuPercent = 0, ioReadRate = 0, ioWriteRate = 0, ioReadOps = 0, ioWriteOps = 0;
    const taskRows: { tid: number; name: string; cpuPercent: number }[] = [];
    if (prev) {
      const dt = ts - prev.ts;
      if (dt > 0.01) {
        cpuPercent = ((stat.utime - prev.utime) + (stat.stime - prev.stime)) / CLK / dt * 100;
        ioReadRate = (io.rchar - prev.rchar) / dt;
        ioWriteRate = (io.wchar - prev.wchar) / dt;
        ioReadOps = (io.syscr - prev.syscr) / dt;
        ioWriteOps = (io.syscw - prev.syscw) / dt;
        tasks.forEach((t, tid) => {
          const p = prev.tasks.get(tid);
          if (!p) return;
          const c = ((t.u - p.u) + (t.s - p.s)) / CLK / dt * 100;
          if (c > 0.5) taskRows.push({ tid, name: t.name, cpuPercent: c });
        });
        taskRows.sort((a, b) => b.cpuPercent - a.cpuPercent);
      }
    }

    this.prev = {
      ts, utime: stat.utime, stime: stat.stime,
      rchar: io.rchar, wchar: io.wchar, syscr: io.syscr, syscw: io.syscw, tasks,
    };

    this.onSample({
      ts, cpuPercent, rssBytes: stat.rss,
      ioReadBytes: io.rchar, ioWriteBytes: io.wchar,
      ioReadRate, ioWriteRate, ioReadOps, ioWriteOps,
      fdCount, threadCount: stat.threads,
      tasks: taskRows.slice(0, 12),
    });
  }
}

/** One-shot snapshot for MCP/diagnostics. */
export function procSnapshot(pid: number): Partial<ProcSample> {
  const stat = readStat(pid);
  if (!stat) return {};
  let fdCount = 0;
  try { fdCount = readdirSync(`/proc/${pid}/fd`).length; } catch { /* restricted */ }
  return { rssBytes: stat.rss, threadCount: stat.threads, fdCount };
}

export function procfsAvailable(pid: number): boolean {
  return existsSync(`/proc/${pid}/stat`);
}

export interface ProcName {
  /** Short label — script basename for interpreter processes, exe otherwise. */
  name: string;
  /** Extra context — runtime binary and/or cwd basename. */
  detail: string;
}

const INTERPRETERS = /^(bun|node|deno|python[\d.]*|ruby|perl|php[\d.]*|java|tsx|ts-node|qjs|quickjs|bash|sh|zsh|fish)$/i;

/** Resolve a human-friendly name for a local pid: binary/script + cwd. */
export function procDisplayName(pid: number): ProcName | null {
  if (pid <= 0) return null;
  let comm = "";
  try { comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return null; }
  let exeBase = "";
  try { exeBase = readlinkSync(`/proc/${pid}/exe`).split("/").pop() ?? ""; } catch { /* restricted */ }
  if (!exeBase) exeBase = comm;
  let cwdBase = "";
  try { cwdBase = readlinkSync(`/proc/${pid}/cwd`).split("/").pop() ?? ""; } catch { /* restricted */ }
  let argv: string[] = [];
  try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { /* restricted */ }
  if (!exeBase) return null;

  // `bun /repo/app/main.ts` — the script says what the process actually is.
  // Runtime subcommands (bun run dev, deno task serve) don't, and neither
  // does inline eval (`bun -e '…'` — not a real path).
  const SUBCOMMANDS = new Set(["run", "task", "test", "x", "exec", "install", "add", "remove", "pm", "init", "create", "upgrade", "repl", "build"]);
  const args = argv.slice(1).filter((a) => !a.startsWith("-"));
  let script: string | undefined;
  if (INTERPRETERS.test(exeBase) && args.length) {
    const viaSub = SUBCOMMANDS.has(args[0]!.toLowerCase());
    const cand = viaSub ? args[1] : args[0];
    const pathish = !!cand && (/^[~./]/.test(cand) || /\.(m?js|cjs|jsx|tsx?|py|rb|pl|php\d*|java|sh)$/i.test(cand));
    if (cand && (pathish || (viaSub && !cand.includes(" ") && cand.length < 60))) {
      script = cand;
    }
  }
  const scriptBase = script ? (script.split("/").pop() ?? "") : "";
  const name = scriptBase || exeBase;
  const detail = [scriptBase ? exeBase : "", cwdBase && cwdBase !== name ? cwdBase : ""]
    .filter(Boolean).join(" · ");
  return { name, detail };
}
