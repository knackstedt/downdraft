// ============================================================================
// Cross-platform stale-instance detection + tree kill
// ============================================================================
//
// Replaces the per-game bash pgrep/kill loop that used to live in
// .vscode/tasks.json. `draft dev` calls `killStaleInstance(gameDir)` before
// spawning electron-vite so a previous dev run (left running after a VS Code
// task stop, a crashed terminal, etc.) is torn down reliably on Linux, macOS,
// and Windows — the old loop only worked on Linux (pgrep + /proc/*/status).
//
// The match key is the per-game Electron `userData` directory, which the
// engine sets via `app.setPath("userData", join(appData, appId))` with
// `appId = "downdraft-<game>"` (see packages/app/src/main/storage.ts). Electron
// propagates that path to every child process as `--user-data-dir=<path>`, so
// matching on that path targets only the stale game's Electron processes and
// never the `draft dev` / npx / electron-vite processes (which carry
// `--config games/<game>/...` but no `--user-data-dir`).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmdline: string;
}

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

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
  for (const p of procs) {
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
    if (kids) for (const k of kids) { result.push(k); queue.push(k); }
  }
  return result;
}

/**
 * Resolve the per-game Electron `userData` directory the same way the engine
 * does (packages/app/src/main/storage.ts:resolveUserDataDir →
 * `join(app.getPath("appData"), appId)`). Used to match `--user-data-dir=<path>`
 * on running Electron processes.
 *
 * `appId` defaults to `downdraft-<gameDir>` but can be overridden by reading
 * the game's `build.config.ts` / `src/main.ts` (some games may use a custom
 * appId that doesn't match the directory name).
 */
export function resolveUserDataDir(gameDir: string, appId?: string): string {
  const id = appId ?? `downdraft-${basename(gameDir)}`;
  const home = homedir();
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, id);
  }
  if (IS_MAC) {
    return join(home, "Library", "Application Support", id);
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdg, id);
}

/**
 * Best-effort extraction of the `appId` from a game's `build.config.ts` or
 * `src/main.ts`. Both files set it as a string literal `appId: "downdraft-..."`.
 * Returns `undefined` if not found.
 */
function readAppId(gameDir: string): string | undefined {
  for (const rel of ["build.config.ts", "src/main.ts"]) {
    const path = resolve(gameDir, rel);
    if (!existsSync(path)) continue;
    try {
      const src = readFileSync(path, "utf8");
      const m = src.match(/appId:\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch {
      // ignore read errors
    }
  }
  return undefined;
}

/**
 * Kill any running Electron process whose command line references the given
 * game's `userData` directory (Electron propagates it as
 * `--user-data-dir=<path>` to all child processes). Kills the entire process
 * tree (main + renderer + GPU + zygote + helpers).
 *
 * Safe to call from the `draft dev` process itself: the dev command's own
 * command line carries `--config games/<game>/...` but never
 * `--user-data-dir=`, so it never matches. The current process and its direct
 * ancestors are also explicitly skipped as a guard.
 *
 * @returns the number of processes that were signalled.
 */
export function killStaleInstance(gameDir: string): number {
  const appId = readAppId(gameDir);
  const userDataDir = resolveUserDataDir(gameDir, appId);
  // Match on the path with native separators AND a forward-slash-normalized
  // form (Electron on Windows may quote the path with either separator).
  const targets = [userDataDir.toLowerCase(), userDataDir.replace(/\\/g, "/").toLowerCase()];

  const procs = listProcesses();
  if (procs.length === 0) return 0;

  // Build the set of PIDs to skip (self + ancestors) so we never signal the
  // dev command itself, even if a future change made its cmdline match.
  const skip = new Set<number>();
  let cur = process.pid;
  const ppidOf = new Map<number, number>(procs.map((p) => [p.pid, p.ppid]));
  while (cur && !skip.has(cur)) {
    skip.add(cur);
    cur = ppidOf.get(cur) ?? 0;
  }

  const matched = procs.filter(
    (p) =>
      !skip.has(p.pid) &&
      targets.some((t) => p.cmdline.toLowerCase().includes(t)),
  );
  if (matched.length === 0) return 0;

  // For each matched process, find the topmost ancestor that is also a match
  // (the Electron main process), then kill it + all descendants. This avoids
  // signalling the same tree twice when multiple Electron children match.
  const matchedPids = new Set(matched.map((m) => m.pid));
  const cmdlineOf = new Map<number, string>(procs.map((p) => [p.pid, p.cmdline]));
  const roots = new Set<number>();
  for (const m of matched) {
    let root = m.pid;
    let p = ppidOf.get(m.pid);
    while (p && matchedPids.has(p)) {
      root = p;
      p = ppidOf.get(p);
    }
    roots.add(root);
  }

  const toKill = new Set<number>();
  for (const root of roots) {
    toKill.add(root);
    for (const d of collectDescendants(root, procs)) toKill.add(d);
  }

  // Walk up from each root to include ancestor Electron processes that the
  // --user-data-dir match missed. The Electron main process sets userData via
  // app.setPath() programmatically (packages/app/src/main/app.ts), so its own
  // cmdline does NOT carry --user-data-dir and isn't caught by the match
  // above — only its children (renderer/GPU/zygote) get the flag propagated
  // internally by Electron. Without this walk-up, killing the renderer leaves
  // the main process alive (showing "Renderer Process Gone") and electron-vite
  // may respawn it on the next file watch event.
  //
  // We include ancestors whose cmdline contains "electron" (catches the
  // Electron main process AND the electron-vite dev server, whose cmdline
  // contains "electron-vite"). We stop at the first ancestor that's in the
  // skip set (self/current-process-tree) or whose cmdline doesn't contain
  // "electron" (npx, draft dev, shell — those exit on their own when their
  // electron-vite child dies).
  for (const root of roots) {
    let p = ppidOf.get(root);
    while (p && !skip.has(p)) {
      const cl = cmdlineOf.get(p);
      if (!cl || !/electron/i.test(cl)) break;
      toKill.add(p);
      p = ppidOf.get(p);
    }
  }

  const signal = (sig: NodeJS.Signals) => {
    for (const pid of toKill) {
      try { process.kill(pid, sig); } catch { /* already dead */ }
      // Also try the process group (catches helpers that stayed in the group
      // after being re-parented to init). No-op if pid isn't a group leader.
      try { process.kill(-pid, sig); } catch { /* not a group leader */ }
    }
  };

  signal("SIGTERM");
  // Give the tree a moment to exit gracefully, then force-kill survivors.
  // Atomics.wait is a pure in-process blocking sleep (no subprocess) and works
  // under both Bun and Node on all platforms.
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, 1200);
  } catch {
    // SharedArrayBuffer unavailable — fall back to a tight loop. Rare.
    const end = Date.now() + 1200;
    while (Date.now() < end) { /* spin */ }
  }
  signal("SIGKILL");

  return toKill.size;
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
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, 2000);
  } catch {
    const end = Date.now() + 2000;
    while (Date.now() < end) { /* spin */ }
  }
  signal("SIGKILL");
}
