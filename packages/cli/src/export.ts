import { confinePath, createLogger } from "@downdraft/core";
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

export async function exportGame(args: string[]): Promise<void> {
  const entry = getCommand("export")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const projectPath = parsed.positionals[0] ?? ".";
  const target = parsed.flags.target as string;
  const outDir = parsed.flags.out as string;
  const verbose = parsed.flags.verbose as boolean;
  const compress = !(parsed.flags["no-compress"] as boolean);

  log.info("export", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Export              ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("export", `  Project:  ${projectPath}`);
  log.info("export", `  Target:   ${target}`);
  log.info("export", `  Output:   ${outDir}`);
  log.info("export", `  Compress: ${compress}`);

  // Validate the output directory to prevent path traversal outside the project.
  const outPath = confinePath(projectPath, outDir);
  if (!existsSync(outPath)) {
    mkdirSync(outPath, { recursive: true });
  }

  // Check for build directory
  const buildDir = resolve(projectPath, "dist");
  if (!existsSync(buildDir)) {
    log.error("export", `No build found at ${buildDir}. Run 'draft build' first.`);
    process.exit(1);
  }

  // Read build manifest
  const manifestPath = join(buildDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    log.error("export", `No manifest found at ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (verbose) {
    log.debug("export", `Manifest: ${JSON.stringify(manifest, null, 2)}`);
  }

  // Platform-specific export — normalize target values to output dir names.
  const platforms =
    target === "all"
      ? [PLATFORM_DIR.win, PLATFORM_DIR.mac, PLATFORM_DIR.linux]
      : [PLATFORM_DIR[target] ?? target];

  for (const platform of platforms) {
    const platformDir = join(outPath, platform);
    if (!existsSync(platformDir)) {
      mkdirSync(platformDir, { recursive: true });
    }

    // Copy build output
    const buildFiles = collectAllFiles(buildDir);
    for (const file of buildFiles) {
      const rel = relative(buildDir, file);
      const dest = join(platformDir, rel);
      ensureDirExists(dest);
      copyFileSync(file, dest);
    }

    // Platform-specific launcher
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

    // Platform info file
    writeFileSync(join(platformDir, "platform.json"), JSON.stringify({
      platform,
      arch: "x86_64",
      runtime: "bun",
      minRuntime: "1.1.0",
      launcher: launcherName,
    }, null, 2));

    log.info("export", `Exported ${platform} → ${platformDir}`);
  }

  // Write export summary
  const exportSummary = {
    exportedAt: new Date().toISOString(),
    platforms,
    totalFiles: collectAllFiles(buildDir).length,
    manifest,
  };
  writeFileSync(join(outPath, "export-summary.json"), JSON.stringify(exportSummary, null, 2));

  log.info("export", `Export complete → ${outPath}`);
  log.info("export", `Platforms: ${platforms.join(", ")}`);
}

function collectAllFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
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
