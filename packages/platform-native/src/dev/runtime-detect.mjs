// ============================================================================
// runtime-detect.mjs — pick the JS runtime that runs the dev shell
//
// The dev shell is plain ESM (.mjs) so it runs identically under bun, node,
// and deno — the runtime only needs to execute the file. Game code is
// transformed/evaluated by the Vite ModuleRunner inside the process, so the
// underlying runtime never touches TypeScript on the main thread.
//
// Selection order: explicit --runtime flag / DD_RUNTIME env → bun (preserves
// today's behavior) → node → deno.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const RUNTIMES = ["bun", "node", "deno"];

function commandExists(cmd) {
  try {
    const res = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
    return res.status === 0 || res.status === null && !res.error;
  } catch {
    return false;
  }
}

/**
 * Resolve which runtime to spawn.
 * @param {string|undefined} preferred --runtime flag / DD_RUNTIME value.
 * @returns {"bun"|"node"|"deno"|null}
 */
export function detectRuntime(preferred) {
  if (preferred) {
    if (!RUNTIMES.includes(preferred)) return null;
    return commandExists(preferred) ? preferred : null;
  }
  for (const r of RUNTIMES) {
    if (commandExists(r)) return r;
  }
  return null;
}

/**
 * Spawn argv for a runtime.
 * @param {"bun"|"node"|"deno"} runtime
 * @param {string} shellPath absolute path to dev-shell.mjs
 * @param {{configPath?: string}} opts deno: --config path when a deno.json exists
 */
export function spawnArgsFor(runtime, shellPath, opts = {}) {
  switch (runtime) {
    case "bun":
      return { cmd: "bun", args: [shellPath] };
    case "node":
      return { cmd: "node", args: [shellPath] };
    case "deno": {
      const args = ["run", "-A"];
      if (opts.configPath) args.push("--config", opts.configPath);
      args.push(shellPath);
      return { cmd: "deno", args };
    }
    default:
      throw new Error(`unknown runtime: ${runtime}`);
  }
}

/** Find a deno.json import map to pass via --config (game dir, then root). */
export function findDenoConfig(gameDir, repoRoot) {
  for (const dir of [gameDir, repoRoot].filter(Boolean)) {
    const p = join(dir, "deno.json");
    if (existsSync(p)) return p;
  }
  return null;
}
