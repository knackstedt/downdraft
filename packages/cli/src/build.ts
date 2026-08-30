// ============================================================================
// draft build — [DEPRECATED] alias for `draft release --stage=build`
// ============================================================================
//
// The old `draft build` was a naive file-copy (no Vite bundling). It has been
// superseded by `draft release --stage=build`, which runs the real
// electron-vite build. This module remains as a backward-compat alias that
// delegates to `release` with a deprecation warning.
//
// The original file-copy implementation is preserved as `legacyFileCopyBuild()`
// below for games that still depend on the old `dist/manifest.json` output
// (e.g. the `draft export` launcher path). The new `draft release --stage=build`
// uses electron-vite and does not produce a manifest.json — `packageLauncher`
// now falls back to package.json when manifest.json is absent.
//

import { Builder, confinePath, createLogger } from "@downdraft/core";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, relative, resolve } from "path";
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
  log.warn("build", "The old file-copy build is preserved for back-compat. Delegating to `release`...");

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
  if (parsed.flags["no-minify"] as boolean) releaseArgs.push("--no-minify");
  if (parsed.flags.sourcemap as boolean) releaseArgs.push("--sourcemap");

  await release(releaseArgs);
}

// ---------------------------------------------------------------------------
// Legacy file-copy build (preserved for back-compat of the export/launcher path)
// ---------------------------------------------------------------------------

/**
 * Legacy file-copy build. Copies `src/` + `assets/` into `dist/` and writes
 * `manifest.json`. This is the original `draft build` implementation, preserved
 * here so games that depend on the `dist/manifest.json` output still work.
 *
 * The new `draft release --stage=build` uses electron-vite instead and does
 * NOT produce a manifest.json.
 */
export async function legacyFileCopyBuild(args: string[]): Promise<void> {
  const entry = getCommand("build")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const gameArg = parsed.flags.game as string | undefined;
  const projectPath = gameArg
    ? resolve(import.meta.dir, "../../..", "games", gameArg)
    : parsed.positionals[0] ?? ".";
  const target = parsed.flags.target as string;
  const mode = parsed.flags.mode as string;
  const outDir = parsed.flags.out as string;
  const verbose = parsed.flags.verbose as boolean;

  log.info("build", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Build (legacy)      ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("build", `  Project:  ${projectPath}`);
  log.info("build", `  Target:   ${target}`);
  log.info("build", `  Mode:     ${mode}`);
  log.info("build", `  Output:   ${outDir}`);

  const builder = new Builder(mode as "dev" | "debug" | "prod");
  const config = builder.getConfig();

  const outPath = confinePath(projectPath, outDir);
  if (!existsSync(outPath)) {
    mkdirSync(outPath, { recursive: true });
  }

  const srcDir = resolve(projectPath, "src");
  const assetsDir = resolve(projectPath, "assets");

  if (!existsSync(srcDir)) {
    log.error("build", `No src directory found at ${srcDir}`);
    process.exit(1);
  }

  const sourceFiles = collectFiles(srcDir, [".ts", ".tsx", ".js", ".jsx"]);

  let projectName = basename(projectPath);
  const pkgJsonPath = join(projectPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.name) projectName = pkg.name;
    } catch {}
  }

  if (verbose) {
    log.debug("build", `Source files: ${sourceFiles.length}`);
    for (const f of sourceFiles) {
      log.debug("build", `  - ${relative(projectPath, f)}`);
    }
  }

  const manifest = {
    name: projectName,
    version: "1.0.0",
    target,
    mode,
    builtAt: new Date().toISOString(),
    files: sourceFiles.map((f) => relative(projectPath, f)),
    config: {
      devtools: config.devtools,
      telemetry: config.telemetry,
      debugDraw: config.debugDraw,
    },
  };

  writeFileSync(join(outPath, "manifest.json"), JSON.stringify(manifest, null, 2));
  log.info("build", `Build manifest written`);

  for (const srcFile of sourceFiles) {
    const rel = relative(srcDir, srcFile);
    const dest = join(outPath, "src", rel);
    ensureDirExists(dest);
    copyFileSync(srcFile, dest);
  }
  log.info("build", `${sourceFiles.length} source files copied`);

  if (existsSync(assetsDir)) {
    const assetFiles = collectFiles(assetsDir, [".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".ogg", ".glb", ".gltf", ".obj", ".fbx", ".wgsl"]);
    for (const assetFile of assetFiles) {
      const rel = relative(assetsDir, assetFile);
      const dest = join(outPath, "assets", rel);
      ensureDirExists(dest);
      copyFileSync(assetFile, dest);
    }
    log.info("build", `${assetFiles.length} asset files copied`);
  }

  const entryPoint = `{
    "name": "${manifest.name}",
    "version": "${manifest.version}",
    "main": "src/main.ts",
    "type": "module"
  }`;
  writeFileSync(join(outPath, "package.json"), entryPoint);

  log.info("build", `Build complete → ${outPath}`);
}

function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.includes(extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

function ensureDirExists(filePath: string): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
