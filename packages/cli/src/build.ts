// ============================================================================
// draft build — [DEPRECATED] alias for `draft release --stage=build`
// ============================================================================
//
// The old `draft build` was a naive file-copy; the native pipeline compiles
// src/native-entry.ts via scripts/package-native.mjs. This module remains as
// a backward-compat alias that delegates to `release` with a warning.

import { createLogger } from "@downdraft/engine";
import { parseArgs, print, renderHelp } from "./args";
import { release } from "./release";
import { getCommand } from "./usage";

const log = createLogger();

export async function build(args: string[]): Promise<void> {
  const entry = getCommand("build")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("build", "`draft build` is deprecated — use `draft release --stage=build` instead.");
  log.warn("build", "Delegating to `release`...");

  // Map old build args → release args.
  const gameArg = parsed.flags.game as string | undefined;
  const target = parsed.flags.target as string;
  const mode = parsed.flags.mode as string;

  // Build the release argv from the old build args.
  const releaseArgs: string[] = ["--stage=build", `--mode=${mode}`];
  if (gameArg) releaseArgs.push(`--game=${gameArg}`);
  // Map build target → release target (skip "current" — release defaults to all desktop).
  if (target && target !== "current") releaseArgs.push(`--target=${target}`);
  if (parsed.flags.verbose as boolean) releaseArgs.push("--verbose");

  await release(releaseArgs);
}
