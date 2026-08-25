// ============================================================================
// draft dist — package a game for distribution via electron-builder
// ============================================================================
//
// Loads the game's `build.config.ts` (which calls
// `createDowndraftBuilderConfig()` to get a per-game branded Configuration
// with correct Windows version-info + PE timestamp patching), then invokes
// electron-builder's programmatic `build()` API.
//
// Falls back to the `build` block in the game's `package.json` if no
// `build.config.ts` exists (back-compat for scaffolded games that still use
// inline config).
//
// Usage:
//   draft dist [--game=<name>] [--target=<win|linux|mac|all>]
//              [--config=<path>] [--project-dir=<path>]

import { createLogger } from "@downdraft/core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const log = createLogger();

interface DistArgs {
  game: string;
  target: "win" | "linux" | "mac" | "all";
  configPath: string | null;
  projectDir: string | null;
}

function parseArgs(args: string[]): DistArgs {
  const opts: DistArgs = {
    game: process.env.DOWNDRAFT_GAME ?? "to-the-ocean",
    target: "all",
    configPath: null,
    projectDir: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--game" || arg === "-g") {
      opts.game = args[++i] ?? opts.game;
    } else if (arg?.startsWith("--game=")) {
      opts.game = arg.slice("--game=".length);
    } else if (arg === "--target" || arg === "-t") {
      opts.target = (args[++i] as DistArgs["target"]) ?? opts.target;
    } else if (arg?.startsWith("--target=")) {
      opts.target = arg.slice("--target=".length) as DistArgs["target"];
    } else if (arg === "--config" || arg === "-c") {
      opts.configPath = args[++i] ?? null;
    } else if (arg?.startsWith("--config=")) {
      opts.configPath = arg.slice("--config=".length);
    } else if (arg === "--project-dir") {
      opts.projectDir = args[++i] ?? null;
    } else if (arg?.startsWith("--project-dir=")) {
      opts.projectDir = arg.slice("--project-dir=".length);
    }
  }
  return opts;
}

/**
 * Resolve the electron-builder Configuration for a game.
 *
 * Precedence:
 *   1. Explicit --config=<path> flag.
 *   2. `games/<game>/build.config.ts` (factory-based, per-game branding).
 *   3. `build` block in `games/<game>/package.json` (inline, back-compat).
 *   4. Root `package.json` `build` block (engine default — last resort).
 */
async function resolveConfig(
  opts: DistArgs,
  repoRoot: string,
): Promise<{ config: any; projectDir: string; source: string }> {
  // 1. Explicit --config flag.
  if (opts.configPath) {
    const abs = resolve(opts.configPath);
    if (!existsSync(abs)) {
      log.error("dist", `Config file not found: ${abs}`);
      process.exit(1);
    }
    const mod = await import(abs);
    const config = mod.default ?? mod;
    return { config, projectDir: opts.projectDir ?? repoRoot, source: abs };
  }

  // 2. games/<game>/build.config.ts (monorepo layout)
  const gameConfigPath = resolve(repoRoot, "games", opts.game, "build.config.ts");
  if (existsSync(gameConfigPath)) {
    const mod = await import(gameConfigPath);
    const config = mod.default ?? mod;
    return {
      config,
      projectDir: opts.projectDir ?? repoRoot,
      source: gameConfigPath,
    };
  }

  // 2b. ./build.config.ts in the current directory (standalone scaffolded project)
  const cwdConfigPath = resolve(process.cwd(), "build.config.ts");
  if (existsSync(cwdConfigPath)) {
    const mod = await import(cwdConfigPath);
    const config = mod.default ?? mod;
    return {
      config,
      projectDir: opts.projectDir ?? process.cwd(),
      source: cwdConfigPath,
    };
  }

  // 3. build block in games/<game>/package.json (monorepo)
  const gamePkgPath = resolve(repoRoot, "games", opts.game, "package.json");
  if (existsSync(gamePkgPath)) {
    const pkg = JSON.parse(readFileSync(gamePkgPath, "utf-8"));
    if (pkg.build) {
      // Merge per-game metadata into the build config so electron-builder
      // picks up productName/version/description/author from the game's
      // package.json even when using inline `build`.
      const config = { ...pkg.build };
      if (pkg.productName && !config.productName) config.productName = pkg.productName;
      if (pkg.version && !config.extraMetadata) config.extraMetadata = { version: pkg.version };
      if (pkg.description && !config.extraMetadata?.description) {
        config.extraMetadata = { ...config.extraMetadata, description: pkg.description };
      }
      return {
        config,
        projectDir: opts.projectDir ?? repoRoot,
        source: gamePkgPath,
      };
    }
  }

  // 3b. build block in ./package.json (standalone scaffolded project)
  const cwdPkgPath = resolve(process.cwd(), "package.json");
  if (existsSync(cwdPkgPath)) {
    const pkg = JSON.parse(readFileSync(cwdPkgPath, "utf-8"));
    if (pkg.build) {
      const config = { ...pkg.build };
      if (pkg.productName && !config.productName) config.productName = pkg.productName;
      if (pkg.version && !config.extraMetadata) config.extraMetadata = { version: pkg.version };
      if (pkg.description && !config.extraMetadata?.description) {
        config.extraMetadata = { ...config.extraMetadata, description: pkg.description };
      }
      return {
        config,
        projectDir: opts.projectDir ?? process.cwd(),
        source: cwdPkgPath,
      };
    }
  }

  // 4. Root package.json build block (engine default — last resort).
  const rootPkgPath = resolve(repoRoot, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
  if (rootPkg.build) {
    log.warn(
      "dist",
      `No build.config.ts or build block found for game "${opts.game}". ` +
        `Falling back to root package.json build config (engine branding).`,
    );
    return {
      config: rootPkg.build,
      projectDir: opts.projectDir ?? repoRoot,
      source: rootPkgPath,
    };
  }

  log.error("dist", `No electron-builder config found for game "${opts.game}".`);
  log.info("dist", `Expected one of:`);
  log.info("dist", `  - games/${opts.game}/build.config.ts`);
  log.info("dist", `  - build block in games/${opts.game}/package.json`);
  log.info("dist", `  - --config=<path> flag`);
  process.exit(1);
}

export async function dist(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const repoRoot = resolve(import.meta.dir, "../../..");

  log.info("dist", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Dist (Package)      ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("dist", `  Game:        ${opts.game}`);
  log.info("dist", `  Target:      ${opts.target}`);
  log.info("dist", `  Project dir: ${opts.projectDir ?? repoRoot}`);

  const { config, projectDir, source } = await resolveConfig(opts, repoRoot);

  log.info("dist", `  Config:      ${source}`);
  if (config.productName) log.info("dist", `  Product:     ${config.productName}`);
  if (config.appId) log.info("dist", `  AppId:       ${config.appId}`);
  if (config.copyright) log.info("dist", `  Copyright:   ${config.copyright}`);
  if (config.extraMetadata?.version) log.info("dist", `  Version:     ${config.extraMetadata.version}`);
  log.info("dist", "");

  // Build the targets map for electron-builder.
  const { build, Platform, Arch, createTargets } = await import("electron-builder");

  const platformMap: Record<string, typeof Platform> = {
    win: Platform.WINDOWS,
    linux: Platform.LINUX,
    mac: Platform.MAC,
  };

  let targets: Map<typeof Platform, Map<typeof Arch, string[]>>;
  if (opts.target === "all") {
    targets = createTargets([Platform.WINDOWS, Platform.LINUX, Platform.MAC]);
  } else {
    const plat = platformMap[opts.target];
    if (!plat) {
      log.error("dist", `Unknown target: ${opts.target}. Use win, linux, mac, or all.`);
      process.exit(1);
    }
    targets = createTargets([plat]);
  }

  try {
    const artifactPaths = await build({
      config,
      projectDir,
      targets,
      // Let electron-builder pick the current arch by default.
      x64: true,
    } as any);

    log.info("dist", "");
    log.info("dist", `Packaging complete. ${artifactPaths.length} artifact(s) produced:`);
    for (const p of artifactPaths) {
      log.info("dist", `  → ${p}`);
    }
  } catch (err) {
    log.error("dist", `Packaging failed: ${(err as Error).message}`);
    if ((err as Error).stack) {
      log.error("dist", (err as Error).stack);
    }
    process.exit(1);
  }
}
