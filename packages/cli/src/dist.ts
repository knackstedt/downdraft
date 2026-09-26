// ============================================================================
// draft dist — DORMANT: packaged games via electron-builder (Electron runtime
// is disabled — desktop packaging moves to scripts/package-native.mjs).
// The code below is kept in-tree for the migration bake period but is
// unreachable from default flows and will be deleted in the cleanup pass.
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
//              [--config=<path>] [--project-dir=<path>] [--verbose]

import { createLogger } from "@downdraft/engine";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

export interface DistArgs {
  game: string;
  target: "win" | "linux" | "mac" | "all";
  configPath: string | null;
  projectDir: string | null;
  verbose: boolean;
}

function parseDistArgs(args: string[]): DistArgs {
  const entry = getCommand("dist")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    process.exit(0);
  }
  return {
    game: parsed.flags.game as string,
    target: parsed.flags.target as DistArgs["target"],
    configPath: (parsed.flags.config as string) || null,
    projectDir: (parsed.flags["project-dir"] as string) || null,
    verbose: parsed.flags.verbose as boolean,
  };
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
export async function resolveConfig(
  opts: DistArgs,
  repoRoot: string | null,
  gameDir?: string | null,
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
    return { config, projectDir: opts.projectDir ?? repoRoot ?? gameDir ?? process.cwd(), source: abs };
  }

  // 2. <gameDir>/build.config.ts (monorepo games/<game>/ or standalone game root)
  const gameConfigPath = gameDir ? resolve(gameDir, "build.config.ts") : null;
  if (gameConfigPath && existsSync(gameConfigPath)) {
    const mod = await import(gameConfigPath);
    const config = mod.default ?? mod;
    return {
      config,
      projectDir: opts.projectDir ?? repoRoot ?? gameDir ?? process.cwd(),
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

  // 3. build block in <gameDir>/package.json (monorepo games/<game>/ or standalone)
  const gamePkgPath = gameDir ? resolve(gameDir, "package.json") : null;
  if (gamePkgPath && existsSync(gamePkgPath)) {
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
        projectDir: opts.projectDir ?? repoRoot ?? gameDir ?? process.cwd(),
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

  // 4. Root package.json build block (engine default — last resort, monorepo only).
  const rootPkgPath = repoRoot ? resolve(repoRoot, "package.json") : null;
  const rootPkg = rootPkgPath ? JSON.parse(readFileSync(rootPkgPath, "utf-8")) : null;
  if (rootPkg?.build && rootPkgPath) {
    log.warn(
      "dist",
      `No build.config.ts or build block found for game "${opts.game}". ` +
        `Falling back to root package.json build config (engine branding).`,
    );
    return {
      config: rootPkg.build,
      projectDir: opts.projectDir ?? repoRoot!,
      source: rootPkgPath,
    };
  }

  log.error("dist", `No electron-builder config found for game "${opts.game}".`);
  log.info("dist", `Expected one of:`);
  log.info("dist", `  - build.config.ts in the game directory`);
  log.info("dist", `  - build block in the game package.json`);
  log.info("dist", `  - --config=<path> flag`);
  process.exit(1);
}

/**
 * Package a game for desktop distribution via electron-builder.
 *
 * Extracted from `dist()` so `draft release --stage=package` can call it
 * directly without going through the argv-parsing entry point.
 *
 * @returns array of artifact paths produced by electron-builder.
 */
export async function packageDesktop(
  opts: DistArgs,
  repoRoot: string | null,
  gameDir?: string | null,
): Promise<string[]> {
  void opts; void repoRoot; void gameDir;
  throw new Error(
    "electron-builder packaging is disabled — the Electron runtime is dormant. " +
    "Native packaging: bun scripts/package-native.mjs <game>/src/native-entry.ts <outfile>");
}

/**
 * DORMANT — the pre-dormancy electron-builder implementation, kept inert for
 * the migration bake. Never called; delete with the rest of the Electron
 * packaging path in the post-bake cleanup.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function packageDesktopElectron(
  opts: DistArgs,
  repoRoot: string | null,
  gameDir?: string | null,
): Promise<string[]> {
  const { config, projectDir, source } = await resolveConfig(opts, repoRoot, gameDir);

  log.info("release:package:desktop", `  Config:      ${source}`);
  if (config.productName) log.info("release:package:desktop", `  Product:     ${config.productName}`);
  if (config.appId) log.info("release:package:desktop", `  AppId:       ${config.appId}`);
  if (config.copyright) log.info("release:package:desktop", `  Copyright:   ${config.copyright}`);
  if (config.extraMetadata?.version) log.info("release:package:desktop", `  Version:     ${config.extraMetadata.version}`);
  log.info("release:package:desktop", "");

  const { build, Platform, Arch, createTargets } = await import("electron-builder");

  const platformMap: Record<string, InstanceType<typeof Platform>> = {
    win: Platform.WINDOWS,
    linux: Platform.LINUX,
    mac: Platform.MAC,
  };

  let targets: ReturnType<typeof createTargets>;
  if (opts.target === "all") {
    targets = createTargets([Platform.WINDOWS, Platform.LINUX, Platform.MAC]);
  } else {
    const plat = platformMap[opts.target];
    if (!plat) {
      log.error("release:package:desktop", `Unknown target: ${opts.target}. Use win, linux, mac, or all.`);
      process.exit(1);
    }
    targets = createTargets([plat]);
  }

  const artifactPaths = await build({
    config,
    projectDir,
    targets,
    x64: true,
  } as any);

  log.info("release:package:desktop", "");
  log.info("release:package:desktop", `Packaging complete. ${artifactPaths.length} artifact(s) produced:`);
  artifactPaths.forEach((p) => {
    log.info("release:package:desktop", `  → ${p}`);
  });
  return artifactPaths;
}

export async function dist(args: string[]): Promise<void> {
  const opts = parseDistArgs(args);

  log.warn("dist", "`draft dist` is deprecated — use `draft release --stage=package` instead.");
  log.warn("dist", "Delegating to `release`...");

  // Map old dist args → release args.
  const releaseArgs: string[] = ["--stage=package", `--game=${opts.game}`, `--target=${opts.target}`];
  if (opts.configPath) releaseArgs.push(`--config=${opts.configPath}`);
  if (opts.projectDir) releaseArgs.push(`--project-dir=${opts.projectDir}`);
  if (opts.verbose) releaseArgs.push("--verbose");

  // Import release dynamically to avoid circular dependency at module load.
  const { release } = await import("./release");
  await release(releaseArgs);
}
