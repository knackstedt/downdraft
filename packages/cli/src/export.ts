import { createLogger } from "@downdraft/core";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";

const log = createLogger();

export async function exportGame(args: string[]): Promise<void> {
  const projectPath = args.find((a) => !a.startsWith("-")) ?? ".";
  const target = args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "all";
  const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "export";
  const verbose = args.includes("--verbose") || args.includes("-v");
  const compress = !args.includes("--no-compress");

  console.log(`
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Export              ║
  ╚══════════════════════════════════════════╝
  `);

  console.log(`  Project:  ${projectPath}`);
  console.log(`  Target:   ${target}`);
  console.log(`  Output:   ${outDir}`);
  console.log(`  Compress: ${compress}`);
  console.log("");

  const outPath = resolve(projectPath, outDir);
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

  // Platform-specific export
  const platforms = target === "all" ? ["windows", "macos", "linux"] : [target];

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
