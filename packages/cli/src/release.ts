// ============================================================================
// draft release — native build + package pipeline
// ============================================================================
//
// Replaces the separate `build`, `dist`, `export`, `mobile`, and
// `build-apps` commands with a single pipeline:
//
//   draft release [--app=<name>] [--target=<csv>]
//                 (auto-detects the app from cwd or apps/ when --app is omitted)
//                 [--stage=<build|package|release>] [--apps=<csv>]
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
import { formatAppsList, listApps } from "./list-apps";
import { findAppDirUpward, findMonorepoRoot, readAppConfig, resolveAppDir } from "./paths";
import { getCommand } from "./usage";

const log = createLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Stage = "build" | "package" | "release";

interface ReleaseArgs {
  app: string | null;
  apps: string[];
  target: string;
  stage: Stage;
  mode: string;
  abi: string;
  minSdk: string | null;
  nodeFlavor: string | null;
  libs: string | null;
  excludeLibs: string | null;
  noStrip: boolean;
  out: string;
  retainMcp: boolean;
  verbose: boolean;
  runtime: string | null;
  format: string | null;
  webui: string | null;
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

  const app = (parsed.flags.app as string) || null;
  const appsFlag = (parsed.flags.apps as string) || "";
  const apps = appsFlag
    ? appsFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : app ? [app] : [];

  const stageFlag = (parsed.flags.stage as string) || "release";
  // --skip-build and --build-only are convenience aliases for --stage.
  const skipBuild = parsed.flags["skip-build"] as boolean;
  const buildOnly = parsed.flags["build-only"] as boolean;
  let stage: Stage = stageFlag as Stage;
  if (buildOnly) stage = "build";
  else if (skipBuild) stage = "package";

  return {
    app,
    apps,
    target: parsed.flags.target as string,
    stage,
    mode: (parsed.flags.mode as string) || "prod",
    abi: (parsed.flags.abi as string) || "arm64-v8a",
    minSdk: (parsed.flags["min-sdk"] as string) || null,
    nodeFlavor: (parsed.flags["node-flavor"] as string) || null,
    libs: (parsed.flags.libs as string) || null,
    excludeLibs: (parsed.flags["exclude-libs"] as string) || null,
    noStrip: parsed.flags["no-strip"] as boolean,
    out: (parsed.flags.out as string) || "release",
    retainMcp: parsed.flags.mcp as boolean,
    verbose: parsed.flags.verbose as boolean,
    runtime: (parsed.flags.runtime as string) || null,
    format: (parsed.flags.format as string) || null,
    webui: (parsed.flags.webui as string) || null,
  };
}

// ---------------------------------------------------------------------------
// App resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the app(s) to release when neither --app nor --apps is given.
 *
 * Resolution order:
 *  1. Explicit flags (--app / --apps) — handled by the caller before this.
 *  2. cwd inference — walk up from `process.cwd()` looking for
 *     `downdraft.config.json` or `src/native-entry.ts`. Lets apps run
 *     `draft release` from their own directory (the scaffolded
 *     `package.json` sets `"release": "draft release"`).
 *  3. Single-app fallback — if `apps/` contains exactly one app, use it.
 *
 * Returns the detected app name, or `null` if none could be determined.
 */
function detectApp(monorepoRoot: string | null): string | null {
  // 2. Cwd inference: walk up looking for the app-dir markers.
  const upward = findAppDirUpward();
  if (upward) return basename(upward);

  // 3. Single-app fallback (monorepo only).
  if (monorepoRoot) {
    const apps = listApps(monorepoRoot);
    if (apps.length === 1) {
      log.info("release", `No app specified — defaulting to the only app found: ${apps[0]}`);
      return apps[0];
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
// App info resolution
// ---------------------------------------------------------------------------

interface AppInfo {
  productName: string;
  appId: string;
  version: string;
  /** The electron-builder-style `build` block from the app's package.json. */
  build: Record<string, any>;
}

function getAppInfo(appDir: string, app: string): AppInfo {
  const pkgPath = resolve(appDir, "package.json");
  const fallback: AppInfo = { productName: app, appId: `com.downdraft.${app}`, version: "0.0.0", build: {} };
  if (!existsSync(pkgPath)) return fallback;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const productName = pkg.productName ?? pkg.build?.productName ??
      String(pkg.name ?? app).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const appId = pkg.build?.appId ?? `com.downdraft.${app}`;
    const version = pkg.version ?? "0.0.0";
    return { productName, appId, version, build: pkg.build ?? {} };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Native packaging — scripts/package-native.mjs
// ---------------------------------------------------------------------------

/**
 * Compile the app's native entry into a standalone Bun binary plus the
 * staged runtime tree (<out>/<app>-<target> + sibling native/ + dd-assets/).
 * One compile covers both the build and package stages — the binary IS the
 * artifact.
 */
function packageNative(
  app: string,
  appDir: string,
  targets: string[],
  opts: ReleaseArgs,
  info: AppInfo,
): boolean {
  const entry = resolve(appDir, "src/native-entry.ts");
  if (!existsSync(entry)) {
    log.error("release:package", `No src/native-entry.ts in ${appDir} — the app has no native entry.`);
    return false;
  }
  // The packaging scripts ship inside @downdraft/cli (files: ["scripts"]) so
  // standalone app repos resolve them through the installed package, not
  // the engine monorepo.
  const scriptNative = fileURLToPath(new URL("../scripts/package-native.mjs", import.meta.url));
  const scriptDesktop = fileURLToPath(new URL("../scripts/package-desktop.mjs", import.meta.url));
  // cwd is the relativization root for staged assets — the monorepo root
  // when present (engine sources relativize cleanly), else the app dir.
  const cwd = findMonorepoRoot(appDir) ?? appDir;

  // Runtime matrix: --runtime flag → build.runtime in package.json →
  // downdraft.config.json "runtime" → bun.
  // "all" expands to the full matrix (one appdir per runtime).
  const RUNTIMES = ["bun", "node", "deno"];
  const requested = opts.runtime ?? info.build.runtime
    ?? (readAppConfig(appDir).runtime as string | undefined) ?? "bun";
  const runtimes = requested === "all" ? RUNTIMES : [requested];
  for (const r of runtimes.values()) {
    if (!RUNTIMES.includes(r)) {
      log.error("release:package", `Unknown runtime "${r}" — expected bun, node, deno, or all.`);
      return false;
    }
  }
  // Non-bun runtimes are linux-only today — the emit-tree packaging hasn't
  // been wired for win/mac.
  const nonBun = runtimes.filter((r) => r !== "bun");
  if (nonBun.length && targets.some((t) => t !== "linux")) {
    log.warn("release:package", `--runtime=${nonBun.join(",")} is linux-only today — win/mac targets still embed bun.`);
  }

  let ok = true;
  targets.forEach((target) => {
    for (const runtime of runtimes.values()) {
      if (target === "linux") {
        // Linux: package-desktop.mjs owns the format matrix (dir, deb,
        // appimage, flatpak). Formats come from --format → build.linux.target
        // → "dir".
        const format = opts.format
          ?? (Array.isArray(info.build.linux?.target)
            ? info.build.linux.target
                .map((t: unknown) => (typeof t === "string" ? t : (t as { target?: string }).target ?? ""))
                .filter(Boolean)
                .join(",")
            : info.build.linux?.target)
          ?? "dir";
        const argv = [
          scriptDesktop,
          `--runtime=${runtime}`,
          `--format=${format}`,
          `--mode=${opts.mode}`,
          `--product-name=${info.productName}`,
          `--product-version=${info.version}`,
          `--app-id=${info.appId}`,
          ...(opts.webui ? [`--webui=${opts.webui}`] : []),
          ...(opts.retainMcp ? ["--mcp"] : []),
          entry,
          resolve(opts.out),
        ];
        log.info("release:package", `bun package-desktop.mjs --runtime=${runtime} --format=${format} ${basename(entry)}`);
        const result = spawnSync("bun", argv, { cwd, stdio: "inherit", env: process.env });
        if (result.status !== 0) {
          log.error("release:package", `Packaging failed for ${app} (${target}/${runtime})`);
          ok = false;
        }
        continue;
      }
      // win/mac: single-binary bun compile via package-native.mjs. Each
      // target gets its own dir so the staged native/ + dd-assets/ trees
      // don't interleave across platforms.
      if (runtime !== "bun") continue;
      const outfile = resolve(opts.out, `${app}-${target}`, `${app}-${target}`);
      const argv = [
        scriptNative,
        `--target=${target}`,
        `--mode=${opts.mode}`,
        `--product-name=${info.productName}`,
        `--product-version=${info.version}`,
        ...(opts.webui ? [`--webui=${opts.webui}`] : []),
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
        log.error("release:package", `Native packaging failed for ${app} (${target})`);
        ok = false;
      }
    }
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Android packaging — scripts/package-mobile.mjs
// ---------------------------------------------------------------------------

/**
 * Bundle the app + native libs + embedded libnode into an APK. Single
 * target ("android") produces lib/<abi>/ entries for --abi (default
 * arm64-v8a). Unlike the desktop path the artifact is the APK itself.
 */
function packageAndroid(
  app: string,
  appDir: string,
  opts: ReleaseArgs,
  info: AppInfo,
): boolean {
  const entry = resolve(appDir, "src/native-entry.ts");
  if (!existsSync(entry)) {
    log.error("release:package", `No src/native-entry.ts in ${appDir} — the app has no native entry.`);
    return false;
  }
  const script = fileURLToPath(new URL("../scripts/package-mobile.mjs", import.meta.url));
  const cwd = findMonorepoRoot(appDir) ?? appDir;
  const outfile = resolve(opts.out, `${app}-android.apk`);
  const argv = [
    script,
    `--mode=${opts.mode}`,
    `--abi=${opts.abi}`,
    `--app-id=${info.appId}`,
    `--app-name=${info.productName}`,
    `--version=${info.version}`,
    ...(opts.minSdk ? [`--min-sdk=${opts.minSdk}`] : []),
    ...(opts.nodeFlavor ? [`--node-flavor=${opts.nodeFlavor}`] : []),
    ...(opts.libs ? [`--libs=${opts.libs}`] : []),
    ...(opts.excludeLibs ? [`--exclude-libs=${opts.excludeLibs}`] : []),
    ...(opts.noStrip ? ["--no-strip"] : []),
    ...(opts.webui ? [`--webui=${opts.webui}`] : []),
    ...(opts.retainMcp ? ["--mcp"] : []),
    entry,
    outfile,
  ];
  log.info("release:package", `bun ${argv.map((a) => basename(a)).join(" ")}`);
  const result = spawnSync("bun", argv, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    log.error("release:package", `Android packaging failed for ${app}`);
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
  // app repos (the app directory itself is the project root).
  const monorepoRoot = findMonorepoRoot();

  // Auto-detect the app when neither --app nor --apps is given.
  let apps = opts.apps;
  if (apps.length === 0) {
    const detected = detectApp(monorepoRoot);
    if (detected) {
      apps = [detected];
      opts.app = detected;
    } else {
      log.error("release", "No app specified and none could be auto-detected.");
      log.error("release", "Run \"draft release\" from an app directory, or use \"--app <name>\" / \"--apps <csv>\" from the engine root.");
      log.error("release", "Available apps:");
      print(formatAppsList(monorepoRoot ?? process.cwd()));
      process.exit(1);
    }
  }

  const targets = classifyTargets(opts.target);

  log.info("release", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Release             ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("release", `  App(s):     ${apps.join(", ")}`);
  log.info("release", `  Target:      ${opts.target}`);
  log.info("release", `  Stage:       ${opts.stage}`);
  log.info("release", `  Mode:        ${opts.mode}`);
  log.info("release", `  Output:      ${opts.out}`);
  if (opts.verbose) log.info("release", `  Verbose:     on`);
  log.info("release", "");

  let fail = 0;

  for (let _i = 0, _it = apps, _n = _it.length; _i < _n; _i++) { const app = _it[_i];
    const appDir = resolveAppDir(app) ?? resolve(monorepoRoot ?? process.cwd(), "apps", app);
    const info = getAppInfo(appDir, app);
    log.info("release", `App: ${app} | Product: "${info.productName}" | AppId: ${info.appId} | v${info.version}`);
    log.info("release", "");

    // Native packaging is a single compile step — build/package/release
    // all produce the same artifact.
    const isAndroid = targets.every((t) => MOBILE_TARGETS.has(t));
    log.info("release", `[package] Compiling ${app} (${targets.join(", ")})...`);
    const ok = isAndroid
      ? packageAndroid(app, appDir, opts, info)
      : packageNative(app, appDir, targets, opts, info);
    if (!ok) {
      log.error("release", `Packaging failed for ${app} — skipping.`);
      fail = 1;
      continue;
    }

    log.info("release", `${app} done.`);
    log.info("release", "");
  }

  // Summary
  log.info("release", "");
  if (fail) {
    log.error("release", "One or more apps failed — see output above.");
  } else {
    log.info("release", "All selected apps processed successfully.");
  }
  log.info("release", `Artifacts: ${opts.out}/`);

  process.exit(fail);
}
