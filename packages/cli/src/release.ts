// ============================================================================
// draft release — native build + package pipeline
// ============================================================================
//
// Replaces the separate `build`, `dist`, `export`, `mobile`, and
// `build-games` commands with a single pipeline:
//
//   draft release [--game=<name>] [--target=<csv>]
//                 (auto-detects the game from cwd or games/ when --game is omitted)
//                 [--stage=<build|package|release>] [--games=<csv>]
//                 [--mode=<dev|debug|prod>] [--out=<dir>]
//                 [--mcp] [--verbose]
//
// Stages (all stages produce the same artifact — a compiled Bun binary plus
// the staged native/ + dd-assets/ tree — via scripts/package-native.mjs):
//   build   = compile only
//   package = package an existing build (for native: same compile step)
//   release = build + package + collect to release/  (default)
//
// Targets: win | linux | mac | all
//
// The old commands remain as backward-compat aliases that delegate here with
// a deprecation warning.
//

import { createLogger } from "@downdraft/engine";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList, listGames } from "./list-games";
import { findGameDirUpward, findMonorepoRoot, resolveGameDir } from "./paths";
import { getCommand } from "./usage";

const log = createLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Stage = "build" | "package" | "release";

interface ReleaseArgs {
  game: string | null;
  games: string[];
  target: string;
  stage: Stage;
  mode: string;
  abi: string;
  out: string;
  retainMcp: boolean;
  verbose: boolean;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseReleaseArgs(args: string[]): ReleaseArgs {
  const entry = getCommand("release")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    process.exit(0);
  }

  const game = (parsed.flags.game as string) || null;
  const gamesFlag = (parsed.flags.games as string) || "";
  const games = gamesFlag
    ? gamesFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : game ? [game] : [];

  const stageFlag = (parsed.flags.stage as string) || "release";
  // --skip-build and --build-only are convenience aliases for --stage.
  const skipBuild = parsed.flags["skip-build"] as boolean;
  const buildOnly = parsed.flags["build-only"] as boolean;
  let stage: Stage = stageFlag as Stage;
  if (buildOnly) stage = "build";
  else if (skipBuild) stage = "package";

  if (parsed.flags.format) {
    log.warn("release", "--format is gone — native packaging produces a single binary + staged tree.");
  }

  return {
    game,
    games,
    target: parsed.flags.target as string,
    stage,
    mode: (parsed.flags.mode as string) || "prod",
    abi: (parsed.flags.abi as string) || "arm64-v8a",
    out: (parsed.flags.out as string) || "release",
    retainMcp: parsed.flags.mcp as boolean,
    verbose: parsed.flags.verbose as boolean,
  };
}

// ---------------------------------------------------------------------------
// Game resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the game(s) to release when neither --game nor --games is given.
 *
 * Resolution order:
 *  1. Explicit flags (--game / --games) — handled by the caller before this.
 *  2. cwd inference — walk up from `process.cwd()` looking for
 *     `downdraft.config.json` or `src/native-entry.ts`. Lets games run
 *     `draft release` from their own directory (the scaffolded
 *     `package.json` sets `"release": "draft release"`).
 *  3. Single-game fallback — if `games/` contains exactly one game, use it.
 *
 * Returns the detected game name, or `null` if none could be determined.
 */
function detectGame(monorepoRoot: string | null): string | null {
  // 2. Cwd inference: walk up looking for the game-dir markers.
  const upward = findGameDirUpward();
  if (upward) return basename(upward);

  // 3. Single-game fallback (monorepo only).
  if (monorepoRoot) {
    const games = listGames(monorepoRoot);
    if (games.length === 1) {
      log.info("release", `No game specified — defaulting to the only game found: ${games[0]}`);
      return games[0];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

const DESKTOP_TARGETS = new Set(["win", "linux", "mac"]);
const MOBILE_TARGETS = new Set(["android"]);

function classifyTargets(target: string): string[] {
  if (target === "all") {
    return ["win", "linux", "mac"];
  }
  const parts = target.split(",").map((s) => s.trim()).filter(Boolean);
  parts.forEach((t) => {
    if (t === "ios") {
      log.error("release", `iOS is not implemented yet — the native mobile port currently supports android only.`);
      process.exit(1);
    }
    if (!DESKTOP_TARGETS.has(t) && !MOBILE_TARGETS.has(t)) {
      log.error("release", `Unknown target: ${t}. Use win, linux, mac, android, or all.`);
      process.exit(1);
    }
  });
  if (parts.some((t) => MOBILE_TARGETS.has(t)) && parts.some((t) => DESKTOP_TARGETS.has(t))) {
    log.error("release", `Can't mix mobile and desktop targets in one release — run android separately.`);
    process.exit(1);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Game info resolution
// ---------------------------------------------------------------------------

function getGameInfo(gameDir: string, game: string): { productName: string; appId: string; version: string } {
  const pkgPath = resolve(gameDir, "package.json");
  if (!existsSync(pkgPath)) {
    return { productName: game, appId: `com.downdraft.${game}`, version: "0.0.0" };
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const productName = pkg.productName ?? pkg.build?.productName ??
      String(pkg.name ?? game).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const appId = pkg.build?.appId ?? `com.downdraft.${game}`;
    const version = pkg.version ?? "0.0.0";
    return { productName, appId, version };
  } catch {
    return { productName: game, appId: `com.downdraft.${game}`, version: "0.0.0" };
  }
}

// ---------------------------------------------------------------------------
// Native packaging — scripts/package-native.mjs
// ---------------------------------------------------------------------------

/**
 * Compile the game's native entry into a standalone Bun binary plus the
 * staged runtime tree (<out>/<game>-<target> + sibling native/ + dd-assets/).
 * One compile covers both the build and package stages — the binary IS the
 * artifact.
 */
function packageNative(
  game: string,
  gameDir: string,
  targets: string[],
  opts: ReleaseArgs,
  info: { productName: string; appId: string; version: string },
): boolean {
  const entry = resolve(gameDir, "src/native-entry.ts");
  if (!existsSync(entry)) {
    log.error("release:package", `No src/native-entry.ts in ${gameDir} — the game has no native entry.`);
    return false;
  }
  // The packaging script ships inside @downdraft/cli (files: ["scripts"]) so
  // standalone game repos resolve it through the installed package, not the
  // engine monorepo.
  const script = fileURLToPath(new URL("../scripts/package-native.mjs", import.meta.url));
  // cwd is the relativization root for staged assets — the monorepo root
  // when present (engine sources relativize cleanly), else the game dir.
  const cwd = findMonorepoRoot(gameDir) ?? gameDir;
  let ok = true;
  targets.forEach((target) => {
    const outfile = resolve(opts.out, `${game}-${target}`);
    const argv = [
      script,
      `--target=${target}`,
      `--mode=${opts.mode}`,
      `--product-name=${info.productName}`,
      `--product-version=${info.version}`,
      ...(opts.retainMcp ? ["--mcp"] : []),
      entry,
      outfile,
    ];
    log.info("release:package", `bun ${argv.map((a) => basename(a)).join(" ")}`);
    const result = spawnSync("bun", argv, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      log.error("release:package", `Native packaging failed for ${game} (${target})`);
      ok = false;
    }
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Android packaging — scripts/package-mobile.mjs
// ---------------------------------------------------------------------------

/**
 * Bundle the game + native libs + embedded libnode into an APK. Single
 * target ("android") produces lib/<abi>/ entries for --abi (default
 * arm64-v8a). Unlike the desktop path the artifact is the APK itself.
 */
function packageAndroid(
  game: string,
  gameDir: string,
  opts: ReleaseArgs,
  info: { productName: string; appId: string; version: string },
): boolean {
  const entry = resolve(gameDir, "src/native-entry.ts");
  if (!existsSync(entry)) {
    log.error("release:package", `No src/native-entry.ts in ${gameDir} — the game has no native entry.`);
    return false;
  }
  const script = fileURLToPath(new URL("../scripts/package-mobile.mjs", import.meta.url));
  const cwd = findMonorepoRoot(gameDir) ?? gameDir;
  const outfile = resolve(opts.out, `${game}-android.apk`);
  const argv = [
    script,
    `--mode=${opts.mode}`,
    `--abi=${opts.abi}`,
    `--app-id=${info.appId}`,
    `--app-name=${info.productName}`,
    `--version=${info.version}`,
    ...(opts.retainMcp ? ["--mcp"] : []),
    entry,
    outfile,
  ];
  log.info("release:package", `bun ${argv.map((a) => basename(a)).join(" ")}`);
  const result = spawnSync("bun", argv, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    log.error("release:package", `Android packaging failed for ${game}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function release(args: string[]): Promise<void> {
  const opts = parseReleaseArgs(args);
  // Monorepo root when running inside the engine repo; null for standalone
  // game repos (the game directory itself is the project root).
  const monorepoRoot = findMonorepoRoot();

  // Auto-detect the game when neither --game nor --games is given.
  let games = opts.games;
  if (games.length === 0) {
    const detected = detectGame(monorepoRoot);
    if (detected) {
      games = [detected];
      opts.game = detected;
    } else {
      log.error("release", "No game specified and none could be auto-detected.");
      log.error("release", "Run \"draft release\" from a game directory, or use \"--game <name>\" / \"--games <csv>\" from the engine root.");
      log.error("release", "Available games:");
      print(formatGamesList(monorepoRoot ?? process.cwd()));
      process.exit(1);
    }
  }

  const targets = classifyTargets(opts.target);

  log.info("release", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Release             ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("release", `  Game(s):     ${games.join(", ")}`);
  log.info("release", `  Target:      ${opts.target}`);
  log.info("release", `  Stage:       ${opts.stage}`);
  log.info("release", `  Mode:        ${opts.mode}`);
  log.info("release", `  Output:      ${opts.out}`);
  if (opts.verbose) log.info("release", `  Verbose:     on`);
  log.info("release", "");

  let fail = 0;

  for (let _i = 0, _it = games, _n = _it.length; _i < _n; _i++) { const game = _it[_i];
    const gameDir = resolveGameDir(game) ?? resolve(monorepoRoot ?? process.cwd(), "games", game);
    const { productName, appId, version } = getGameInfo(gameDir, game);
    log.info("release", `Game: ${game} | Product: "${productName}" | AppId: ${appId} | v${version}`);
    log.info("release", "");

    // Native packaging is a single compile step — build/package/release
    // all produce the same artifact.
    const isAndroid = targets.every((t) => MOBILE_TARGETS.has(t));
    log.info("release", `[package] Compiling ${game} (${targets.join(", ")})...`);
    const ok = isAndroid
      ? packageAndroid(game, gameDir, opts, { productName, appId, version })
      : packageNative(game, gameDir, targets, opts, { productName, appId, version });
    if (!ok) {
      log.error("release", `Packaging failed for ${game} — skipping.`);
      fail = 1;
      continue;
    }

    log.info("release", `${game} done.`);
    log.info("release", "");
  }

  // Summary
  log.info("release", "");
  if (fail) {
    log.error("release", "One or more games failed — see output above.");
  } else {
    log.info("release", "All selected games processed successfully.");
  }
  log.info("release", `Artifacts: ${opts.out}/`);

  process.exit(fail);
}
