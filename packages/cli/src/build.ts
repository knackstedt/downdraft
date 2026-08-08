import { Builder, confinePath, createLogger } from "@downdraft/core";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, relative, resolve } from "path";

const log = createLogger();

export async function build(args: string[]): Promise<void> {
  const projectPath = args.find((a) => !a.startsWith("-")) ?? ".";
  const target = args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "current";
  const mode = args.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "prod";
  const outDir = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "dist";
  const verbose = args.includes("--verbose") || args.includes("-v");
  const minify = !args.includes("--no-minify");
  const sourceMaps = args.includes("--sourcemap") || mode !== "prod";

  log.info("build", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Build               ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("build", `  Project:  ${projectPath}`);
  log.info("build", `  Target:   ${target}`);
  log.info("build", `  Mode:     ${mode}`);
  log.info("build", `  Output:   ${outDir}`);
  log.info("build", `  Minify:   ${minify}`);
  log.info("build", `  Maps:     ${sourceMaps}`);

  const builder = new Builder(mode as "dev" | "debug" | "prod");
  const config = builder.getConfig();

  // Validate the output directory to prevent path traversal outside the project.
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
