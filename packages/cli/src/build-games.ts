// ============================================================================
// draft build-games — [DEPRECATED] alias for `draft release --games=<csv>`
// ============================================================================
//
// The old `draft build-games` drove the electron-vite + electron-builder +
// Capacitor pipelines. Native packaging produces a single compiled binary per
// desktop target — the legacy `platform:format` specs collapse to plain
// targets (win | linux | mac); android/ios hard-error in `release`.

import { createLogger } from "@downdraft/engine";
import { ArgError, parseArgs as parseArgv, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

export async function buildGames(argv: string[]): Promise<void> {
  const entry = getCommand("build-games")!;
  // Check for --help before parsing (parseArgv validates required flags).
  if (argv.includes("--help") || argv.includes("-h")) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("build-games", "`draft build-games` is deprecated — use `draft release --games=<csv> --target=<csv>` instead.");
  log.warn("build-games", "Delegating to `release`...");

  const parsed = parseArgv(argv, entry.schema);
  const games = ((parsed.flags.games as string) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const platforms = ((parsed.flags.platforms as string) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (games.length === 0 || platforms.length === 0) {
    throw new ArgError("Usage: draft build-games --games=<g1,g2> --platforms=<p1,p2>");
  }

  // Legacy specs carry a format suffix (win:portable, linux:AppImage) — native
  // packaging has a single artifact per platform, so only the target matters.
  const targets = [...new Set(platforms.map((s) => s.split(":")[0]))];

  const releaseArgs: string[] = [
    `--games=${games.join(",")}`,
    `--target=${targets.join(",")}`,
  ];
  if (argv.includes("--verbose") || argv.includes("-v")) releaseArgs.push("--verbose");

  const { release } = await import("./release");
  await release(releaseArgs);
}
