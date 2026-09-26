import { confinePath, createLogger } from "@downdraft/engine";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

// Map normalized flag values → output directory names (kept stable for
// back-compat of the generated layout: windows/macos/linux).
const PLATFORM_DIR: Record<string, string> = {
  win: "windows",
  mac: "macos",
  linux: "linux",
};

/**
 * Package a built game as per-platform launcher folders (bun-based).
 *
 * Extracted from `exportGame()` so `draft release --format=launcher` can
 * call it directly. Copies `dist/` into per-platform folders with launcher
 * scripts + platform.json. When `compress` is true, also produces a
 * `.tar.gz` per platform (the old `export` command parsed `--no-compress`
 * but never implemented compression — this fixes that).
 *
 * @returns array of produced artifact paths (directories or archives).
 */
export async function packageLauncher(
  projectPath: string,
  target: string,
  outDir: string,
  compress: boolean,
  verbose: boolean,
): Promise<string[]> {
  log.info("release:package:launcher", `  Project:  ${projectPath}`);
  log.info("release:package:launcher", `  Target:   ${target}`);
  log.info("release:package:launcher", `  Output:   ${outDir}`);
  log.info("release:package:launcher", `  Compress: ${compress}`);

  const outPath = confinePath(projectPath, outDir);
  if (!existsSync(outPath)) {
    mkdirSync(outPath, { recursive: true });
  }

  const buildDir = resolve(projectPath, "dist");
  if (!existsSync(buildDir)) {
    log.error("release:package:launcher", `No build found at ${buildDir}. Run 'draft release --stage=build' first.`);
    process.exit(1);
  }

  // Read build manifest if present (written by the old file-copy `draft build`).
  // electron-vite build doesn't produce one, so fall back to package.json.
  const manifestPath = join(buildDir, "manifest.json");
  let manifest: { name?: string };
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } else {
    const pkgJsonPath = resolve(projectPath, "package.json");
    const pkg = existsSync(pkgJsonPath) ? JSON.parse(readFileSync(pkgJsonPath, "utf-8")) : {};
    manifest = { name: pkg.name ?? "game" };
  }
  if (verbose) {
    log.debug("release:package:launcher", `Manifest: ${JSON.stringify(manifest, null, 2)}`);
  }

  const platforms =
    target === "all"
      ? [PLATFORM_DIR.win, PLATFORM_DIR.mac, PLATFORM_DIR.linux]
      : [PLATFORM_DIR[target] ?? target];

  const artifacts: string[] = [];

  for (let _i = 0, _it = platforms, _n = _it.length; _i < _n; _i++) { const platform = _it[_i];
    const platformDir = join(outPath, platform);
    if (!existsSync(platformDir)) {
      mkdirSync(platformDir, { recursive: true });
    }

    const buildFiles = collectAllFiles(buildDir);
    buildFiles.forEach((file) => {
      const rel = relative(buildDir, file);
      const dest = join(platformDir, rel);
      ensureDirExists(dest);
      copyFileSync(file, dest);
    });

    const launcherName = manifest.name ?? "game";
    if (platform === "windows") {
      writeFileSync(join(platformDir, `${launcherName}.bat`), `@echo off\nbun run src/main.ts\n`);
    } else if (platform === "macos" || platform === "linux") {
      const launcherPath = join(platformDir, launcherName);
      writeFileSync(launcherPath, `#!/bin/bash\nbun run src/main.ts\n`);
      try {
        const { chmodSync } = await import("fs");
        chmodSync(launcherPath, 0o755);
      } catch {}
    }

    writeFileSync(join(platformDir, "platform.json"), JSON.stringify({
      platform,
      arch: "x86_64",
      runtime: "bun",
      minRuntime: "1.1.0",
      launcher: launcherName,
    }, null, 2));

    log.info("release:package:launcher", `Exported ${platform} → ${platformDir}`);
    artifacts.push(platformDir);

    // Compress the platform folder into a .tar.gz (the old `export` command
    // parsed --no-compress but never implemented compression — this fixes it).
    if (compress) {
      const archivePath = `${platformDir}.tar.gz`;
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("tar", ["-czf", archivePath, "-C", outPath, platform], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      if (result.status === 0) {
        log.info("release:package:launcher", `Compressed ${platform} → ${archivePath}`);
        artifacts.push(archivePath);
      } else {
        log.warn("release:package:launcher", `  ! Compression failed for ${platform} (tar exit ${result.status}). Skipping archive.`);
      }
    }
  }

  const exportSummary = {
    exportedAt: new Date().toISOString(),
    platforms,
    totalFiles: collectAllFiles(buildDir).length,
    manifest,
  };
  writeFileSync(join(outPath, "export-summary.json"), JSON.stringify(exportSummary, null, 2));

  log.info("release:package:launcher", `Export complete → ${outPath}`);
  log.info("release:package:launcher", `Platforms: ${platforms.join(", ")}`);
  return artifacts;
}

export async function exportGame(args: string[]): Promise<void> {
  const entry = getCommand("export")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("export", "`draft export` is deprecated — use `draft release --stage=package --format=launcher` instead.");
  log.warn("export", "Delegating to `release`...");

  const target = parsed.flags.target as string;
  const verbose = parsed.flags.verbose as boolean;
  const noCompress = parsed.flags["no-compress"] as boolean;

  // Map old export args → release args.
  const releaseArgs: string[] = ["--stage=package", "--format=launcher", `--target=${target}`];
  if (verbose) releaseArgs.push("--verbose");
  if (noCompress) releaseArgs.push("--no-minify"); // reuse no-minify as compress toggle

  // Try to infer --game from the project path positional.
  const projectPath = parsed.positionals[0] ?? ".";
  const { basename } = await import("node:path");
  const gameName = basename(projectPath);
  if (gameName && gameName !== ".") releaseArgs.push(`--game=${gameName}`);

  const { release } = await import("./release");
  await release(releaseArgs);
}

function collectAllFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      results.push(...collectAllFiles(fullPath));
    } else {
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
