// ============================================================================
// draft export — [DEPRECATED] alias for `draft release --stage=package`
// ============================================================================
//
// The old `draft export` copied a Vite `dist/` tree into per-platform
// launcher folders. Native packaging produces a single compiled binary +
// staged runtime tree instead — this command delegates to `release`.

import { createLogger } from "@downdraft/engine";
import { parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

export async function exportGame(args: string[]): Promise<void> {
  const entry = getCommand("export")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("export", "`draft export` is deprecated — use `draft release --stage=package` instead.");
  log.warn("export", "Delegating to `release`...");

  const releaseArgs: string[] = ["--stage=package"];
  const target = parsed.flags.target as string | undefined;
  if (target) releaseArgs.push(`--target=${target}`);
  if (parsed.flags.verbose as boolean) releaseArgs.push("--verbose");

  const { basename } = await import("node:path");
  const projectPath = parsed.positionals[0] ?? ".";
  const gameName = basename(projectPath);
  if (gameName && gameName !== ".") releaseArgs.push(`--game=${gameName}`);

  const { release } = await import("./release");
  await release(releaseArgs);
}
