// ============================================================================
// draft release — unified build + package + sign pipeline
// ============================================================================
//
// Replaces the separate `build`, `dist`, `export`, `mobile`, and
// `build-games` commands with a single pipeline:
//
//   draft release [--game=<name>] [--target=<csv>] [--format=<csv>]
//                 (auto-detects the game from cwd or games/ when --game is omitted)
//                 [--stage=<build|package|release>] [--games=<csv>]
//                 [--mode=<dev|debug|prod>] [--out=<dir>] [--config=<path>]
//                 [--port=<n>] [--skip-build] [--build-only]
//                 [--skip-gradle] [--no-icons] [--no-overrides]
//                 [--no-minify] [--sourcemap] [--verbose]
//
// Stages:
//   build   = Vite-bundle only (desktop electron-vite + mobile web bundle)
//   package = package an existing build (electron-builder / Capacitor+Gradle)
//   release = build + package + sign + collect to release/  (default)
//
// Targets (one vocabulary for all platforms):
//   win | linux | mac | android | ios | all
//
// Formats (optional, per-platform):
//   portable | nsis | appimage | deb | rpm | flatpak | dmg | zip | apk | launcher
//   e.g. --format=win:portable,linux:AppImage
//   Omitted = use each platform's configured default from build.config.ts.
//   --format=launcher = the bun-launcher lightweight distribution (old `export`).
//
// The old commands remain as backward-compat aliases that delegate here with
// a deprecation warning.
//

import { createLogger } from "@downdraft/engine";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList, listGames } from "./list-games";
import { buildMobileWeb, packageMobile, type MobileArgs } from "./mobile";
import { findGameDirUpward, findMonorepoRoot, resolveGameDir } from "./paths";
import { getCommand } from "./usage";

const log = createLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Stage = "build" | "package" | "release";
type Target = "win" | "linux" | "mac" | "android" | "ios" | "all";

interface ReleaseArgs {
  game: string | null;
  games: string[];
  target: string;
  format: string;
  stage: Stage;
  mode: string;
  out: string;
  configPath: string | null;
  projectDir: string | null;
  port: number;
  skipBuild: boolean;
  buildOnly: boolean;
  skipGradle: boolean;
  noIcons: boolean;
  noOverrides: boolean;
  noMinify: boolean;
  noBake: boolean;
  sourcemap: boolean;
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

  const port = parsed.flags.port as number;

  return {
    game,
    games,
    target: parsed.flags.target as string,
    format: (parsed.flags.format as string) || "",
    stage,
    mode: (parsed.flags.mode as string) || "prod",
    out: (parsed.flags.out as string) || "release",
    configPath: (parsed.flags.config as string) || null,
    projectDir: (parsed.flags["project-dir"] as string) || null,
    port: port === 0 ? 8765 : port,
    skipBuild,
    buildOnly,
    skipGradle: parsed.flags["skip-gradle"] as boolean,
    noIcons: parsed.flags["no-icons"] as boolean,
    noOverrides: parsed.flags["no-overrides"] as boolean,
    noMinify: parsed.flags["no-minify"] as boolean,
    noBake: parsed.flags["no-bake"] as boolean,
    sourcemap: parsed.flags.sourcemap as boolean,
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
const MOBILE_TARGETS = new Set(["android", "ios"]);

interface TargetGroups {
  desktop: string[];   // e.g. ["win", "linux"]
  mobile: string[];    // e.g. ["android"]
}

function classifyTargets(target: string): TargetGroups {
  if (target === "all") {
    return { desktop: ["win", "linux", "mac"], mobile: ["android", "ios"] };
  }
  const parts = target.split(",").map((s) => s.trim()).filter(Boolean);
  const desktop: string[] = [];
  const mobile: string[] = [];
  for (const t of parts) {
    if (DESKTOP_TARGETS.has(t)) desktop.push(t);
    else if (MOBILE_TARGETS.has(t)) mobile.push(t);
    else {
      log.error("release", `Unknown target: ${t}. Use win, linux, mac, android, ios, or all.`);
      process.exit(1);
    }
  }
  return { desktop, mobile };
}

// ---------------------------------------------------------------------------
// Format parsing
// ---------------------------------------------------------------------------

/**
 * Parse the --format flag into a map of platform → format.
 *
 * Format grammar:
 *   --format=win:portable,linux:AppImage   → { win: "portable", linux: "AppImage" }
 *   --format=launcher                       → all desktop platforms get "launcher"
 *   (empty)                                 → {} (use configured defaults)
 */
function parseFormats(format: string): Record<string, string> {
  if (!format) return {};
  const out: Record<string, string> = {};
  for (const spec of format.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (spec.includes(":")) {
      const [plat, fmt] = spec.split(":");
      out[plat.trim()] = fmt.trim();
    } else {
      // Bare format applies to all desktop platforms (e.g. --format=launcher).
      for (const p of DESKTOP_TARGETS) out[p] = spec;
    }
  }
  return out;
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
// Stage: build
// ---------------------------------------------------------------------------

async function runBuild(
  game: string,
  groups: TargetGroups,
  gameDir: string,
  opts: ReleaseArgs,
): Promise<boolean> {
  if (!existsSync(gameDir)) {
    log.error("release:build", `Game directory not found: ${gameDir}`);
    return false;
  }

  // Forward bake disable to the Vite plugin via env.
  const buildEnv: Record<string, string> = {};
  if (opts.noBake) buildEnv.DOWNDRAFT_BAKE = "0";

  // Desktop: the electron-vite pipeline is disabled (Electron runtime is
  // dormant). Native packaging is staged by scripts/package-native.mjs —
  // Track F wires it into this command.
  if (groups.desktop.length > 0) {
    log.error("release:build", "Desktop builds via electron-vite are disabled. Native packaging: bun scripts/package-native.mjs <game>/src/native-entry.ts <outfile>");
    return false;
  }

  // Mobile: Vite build with mobile config (produces dist/mobile/).
  if (groups.mobile.length > 0) {
    const ok = await buildMobileWeb(gameDir, buildEnv);
    if (!ok) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Stage: package
// ---------------------------------------------------------------------------

async function runPackage(
  game: string,
  groups: TargetGroups,
  formats: Record<string, string>,
  opts: ReleaseArgs,
  gameDir: string,
  projectRoot: string | null,
): Promise<boolean> {
  // --- Desktop packaging ---
  // electron-builder and launcher packaging are disabled — the Electron
  // runtime is dormant. Native packaging is staged by
  // scripts/package-native.mjs (Track F wires it into this command).
  if (groups.desktop.length > 0) {
    log.error("release:package", "Desktop packaging via electron-builder is disabled. Native packaging: bun scripts/package-native.mjs <game>/src/native-entry.ts <outfile>");
    return false;
  }

  // --- Mobile packaging (Capacitor) — dormant: kept functional during the
  // migration bake, but not the shipping target. ---
  if (groups.mobile.length > 0) {
    log.warn("release:package", "Mobile packaging is dormant — the Capacitor path is unmaintained during the native migration bake.");
    const mobileTarget = groups.mobile.length === 2 ? "all" : groups.mobile[0] as "android" | "ios";
    const mobileOpts: MobileArgs = {
      game,
      target: mobileTarget,
      port: opts.port,
      skipBuild: true, // build already ran in runBuild()
      skipGradle: opts.skipGradle,
      noIcons: opts.noIcons,
      noOverrides: opts.noOverrides,
      verbose: opts.verbose,
    };
    try {
      await packageMobile(mobileOpts, gameDir, projectRoot);
    } catch (err) {
      log.error("release:package:mobile", `Mobile packaging failed for ${game}: ${(err as Error).message}`);
      return false;
    }
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

  const groups = classifyTargets(opts.target);
  const formats = parseFormats(opts.format);

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
  if (opts.format) log.info("release", `  Format:      ${opts.format}`);
  if (opts.verbose) log.info("release", `  Verbose:     on`);
  log.info("release", "");

  let fail = 0;

  for (const game of games) {
    const gameDir = resolveGameDir(game) ?? resolve(monorepoRoot ?? process.cwd(), "games", game);
    const { productName, appId, version } = getGameInfo(gameDir, game);
    log.info("release", `Game: ${game} | Product: "${productName}" | AppId: ${appId} | v${version}`);
    log.info("release", "");

    let ok = true;

    // Stage: build
    if (opts.stage === "build" || opts.stage === "release") {
      log.info("release", `[build] Building ${game}...`);
      ok = await runBuild(game, groups, gameDir, opts);
      if (!ok) {
        log.error("release", `Build failed for ${game} — skipping remaining stages.`);
        fail = 1;
        continue;
      }
    }

    // Stage: package
    if (opts.stage === "package" || opts.stage === "release") {
      log.info("release", `[package] Packaging ${game}...`);
      ok = await runPackage(game, groups, formats, opts, gameDir, monorepoRoot);
      if (!ok) {
        log.error("release", `Packaging failed for ${game} — skipping.`);
        fail = 1;
        continue;
      }
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
  if (groups.desktop.length > 0) {
    log.info("release", `Desktop artifacts: ${opts.out}/`);
  }
  if (groups.mobile.length > 0) {
    log.info("release", `Android APK: ${opts.out}/<name>-<version>-android.apk`);
    log.info("release", `iOS: open games/<game>/ios with Xcode`);
  }

  // Hard exit — Vite/Capacitor/Gradle/electron-builder leave lingering handles.
  process.exit(fail);
}
