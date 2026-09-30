// ============================================================================
// draft dist — [DEPRECATED] alias for `draft release --stage=package`
// ============================================================================
//
// Desktop packaging is native: `draft release` compiles the game's
// src/native-entry.ts into a standalone Bun binary via the
// package-native.mjs script shipped in this package. This command delegates
// to `release` with a deprecation warning.

import { createLogger } from "@downdraft/engine";
import { parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

export async function dist(args: string[]): Promise<void> {
  const entry = getCommand("dist")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("dist", "`draft dist` is deprecated — use `draft release --stage=package` instead.");
  log.warn("dist", "Delegating to `release`...");

  const releaseArgs: string[] = ["--stage=package"];
  const game = parsed.flags.game as string | undefined;
  const target = parsed.flags.target as string | undefined;
  if (game) releaseArgs.push(`--game=${game}`);
  if (target) releaseArgs.push(`--target=${target}`);
  if (parsed.flags.verbose as boolean) releaseArgs.push("--verbose");

  const { release } = await import("./release");
  await release(releaseArgs);
}
