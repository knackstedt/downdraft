// ============================================================================
// Cross-platform process-tree kill
// ============================================================================
//
// Used by `draft dev`'s shutdown handler to tear down a spawned dev-shell
// process tree reliably on Linux, macOS, and Windows.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmdline: string;
}

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

/**
 * The executable name for `npx` on this platform. On Windows, `npx` is a
 * `npx.cmd` batch shim — `spawn("npx", ...)` without `shell: true` fails with
 * ENOENT because there's no `npx` PE executable on PATH. Spawning `npx.cmd`
 * directly avoids both the ENOENT and shell-quoting issues.
 */
export function npxBinary(): string {
  return IS_WIN ? "npx.cmd" : "npx";
}

/**
 * Synchronous sleep for use in kill sequences and signal handlers where the
 * event loop can't be relied upon. `Atomics.wait` on a private SharedArrayBuffer
 * is a pure in-process blocking sleep (no subprocess, works on the main thread
 * in Node/Bun — unlike browsers). Falls back to a spin loop where SAB is
 * unavailable.
 */
export function sleepSync(ms: number): void {
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Enumerate all processes on the system with pid, ppid, and command line.
 *
 * - Linux: reads `/proc/<pid>/cmdline` + `/proc/<pid>/stat` (no subprocess).
 * - macOS: `ps -ax -o pid=,ppid=,command=`.
 * - Windows: PowerShell `Get-CimInstance Win32_Process`.
 * - Other: falls back to POSIX `ps -e -o pid=,ppid=,command=`.
 */
export function listProcesses(): ProcInfo[] {
  if (platform() === "linux") return listLinux();
  if (IS_MAC) return listPs(["-ax"]);
  if (IS_WIN) return listWindows();
  return listPs(["-e"]);
}

function listLinux(): ProcInfo[] {
  const out: ProcInfo[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      let ppid = 0;
      let cmdline = "";
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const rparen = stat.lastIndexOf(")");
        if (rparen >= 0) {
          // Fields after comm: state ppid ... (comm may contain spaces/parens
          // so we parse from the last ")").
          const rest = stat.slice(rparen + 2).split(" ");
          ppid = Number(rest[1]);
        }
        // /proc/<pid>/cmdline is NUL-separated; join with spaces.
        const raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        cmdline = raw.replace(/\0+$/g, "").replace(/\0/g, " ").trim();
      } catch {
        continue; // process exited between readdir and read
      }
      if (cmdline) out.push({ pid, ppid, cmdline });
    }
  } catch {
    // /proc unavailable — shouldn't happen on Linux, but degrade gracefully.
  }
  return out;
}

function listPs(extraArgs: string[]): ProcInfo[] {
  const r = spawnSync("ps", [...extraArgs, "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return [];
  return parsePs(r.stdout);
}

function parsePs(stdout: string): ProcInfo[] {
  return stdout
    .split("\n")
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] };
    })
    .filter((x): x is ProcInfo => x !== null);
}

function listWindows(): ProcInfo[] {
  // One line per process: "PID|PPID|CommandLine". CommandLine may contain "|",
  // so only split on the first two.
  const script =
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | " +
    'ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }';
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => {
      const parts = line.split("|");
      if (parts.length < 2) return null;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return { pid, ppid, cmdline: parts.slice(2).join("|") };
    })
    .filter((x): x is ProcInfo => x !== null);
}

/**
 * Collect all descendant PIDs of `rootPid` by walking the pid→ppid map.
 * Returns descendants in BFS order (children before grandchildren).
 */
export function collectDescendants(rootPid: number, procs: ProcInfo[]): number[] {
  const childrenOf = new Map<number, number[]>();
  for (let _i = 0, _it = procs, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (p.pid === rootPid) continue;
    const list = childrenOf.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenOf.set(p.ppid, list);
  }
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift()!;
    const kids = childrenOf.get(cur);
    if (kids) kids.forEach((k) => { result.push(k); queue.push(k); });
  }
  return result;
}

/**
 * Kill a process and its entire descendant tree. Used by `draft dev`'s
 * shutdown handler — unlike `process.kill(-pid)` (process-group kill), this
 * works correctly even when the child was NOT spawned with `detached: true`
 * (i.e. it's in the same process group as the parent, so `-pid` would kill
 * the parent's group too).
 *
 * Sends SIGTERM first, waits briefly, then SIGKILLs survivors.
 */
export function killProcessTree(rootPid: number): void {
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(rootPid, sig); } catch { /* already dead */ }
    const procs = listProcesses();
    for (const pid of collectDescendants(rootPid, procs)) {
      try { process.kill(pid, sig); } catch { /* already dead */ }
    }
  };
  signal("SIGTERM");
  sleepSync(2000);
  signal("SIGKILL");
}
