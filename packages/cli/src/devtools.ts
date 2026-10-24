// ============================================================================
// devtools.ts — `draft devtools`: launch the standalone devtools
// viewer from any directory.
//
// The viewer is the @downdraft/devtools package — it ships its own
// src/native-entry.ts + downdraft.config.json, so the standard dev-shell path
// can run its directory as a "game". The viewer discovers targets over the
// ~/.downdraft/devtools-agent/ + feed contract and attaches to running or
// flaky games (launch them with `draft dev --devtools-agent`, or
// DD_DEVTOOLS_AGENT=1, or an explicit devtools-agent.mjs import).
// ============================================================================

import { createLogger } from "@downdraft/engine";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ArgError, parseArgs, print, renderHelp } from "./args";
import { devNative } from "./dev";
import { getCommand } from "./usage";

const log = createLogger();

/** Resolve the installed @downdraft/devtools package dir — it is a
 *  dependency of this CLI, so `draft devtools` works anywhere the CLI is
 *  installed (monorepo workspace link or published node_modules). */
function resolveViewerDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("@downdraft/devtools/package.json"));
  } catch {
    return null;
  }
}

export async function devtools(args: string[]): Promise<void> {
  const entry = getCommand("devtools")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const dir = resolveViewerDir();
  if (!dir) {
    log.error("draft", "Could not resolve @downdraft/devtools — reinstall the draft CLI.");
    throw new ArgError("@downdraft/devtools not found in the CLI's dependency tree");
  }
  await devNative(parsed, dir);
}
