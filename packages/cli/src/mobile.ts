// ============================================================================
// draft mobile — build + scaffold a Capacitor mobile target (Android / iOS)
// ============================================================================
//
// This command:
//   1. Builds the web bundle via the mobile Vite config (dist/mobile/).
//   2. Copies the engine-owned native shell (packages/mobile-shell/) into the
//      game directory's gitignored `android/` + `ios/` folders.
//   3. Patches game-specific values (appId, appName, port) into the shell.
//   4. Generates app icons from the game's `icon.png` (via jimp) if provided.
//   5. Applies the `mobile-overrides/` merge layer if present.
//   6. Ensures `capacitor.config.ts` exists (writes one if missing).
//   7. Runs `cap sync` to populate web assets + Capacitor plugin configs.
//   8. Builds the release APK via the Gradle wrapper (Android target) and
//      collects it into `release/` (+ unpacked to
//      `release/android-unpacked/`), mirroring `draft dist` → electron-builder
//      `release/` for desktop.
//
// The native shell is pre-wired with the embedded HTTP server (COOP/COEP
// headers for SharedArrayBuffer cross-origin isolation). No manual native
// code editing is required.
//
// Usage:
//   draft mobile [--game=<name>] [--target=<android|ios|all>]
//                [--port=<n>] [--skip-build] [--skip-gradle] [--no-icons] [--no-overrides]
//
// Prerequisites:
//   - Android: Android Studio + Android SDK (for `cap open android`)
//   - iOS: Xcode + CocoaPods (for `cap open ios`)
//   - Capacitor CLI: `bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios`
//   - The game must have a `src/mobile.ts` entry that calls
//     `createDowndraftMobileApp()`.

import { createLogger } from "@downdraft/core";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs as parseArgv, print, renderHelp } from "./args";
import { generateIcons } from "./mobile-icons";
import { getCommand } from "./usage";

const log = createLogger();

/**
 * Resolve the `cap` (Capacitor CLI) binary path.
 *
 * Capacitor is installed per-game (in `<gameDir>/node_modules/.bin/cap`), not
 * at the repo root. `npx cap` fails because npx looks in the CWD's
 * node_modules and the global path — neither has it. We resolve the local
 * binary directly and fall back to `npx cap` if it's not found.
 */
function resolveCapBinary(gameDir: string): string {
  const localCap = resolve(gameDir, "node_modules/.bin/cap");
  if (existsSync(localCap)) return localCap;
  // Fall back to npx (works if @capacitor/cli is globally installed or in the
  // repo root's node_modules)
  return "npx cap";
}

export interface MobileArgs {
  game: string;
  target: "android" | "ios" | "all";
  port: number;
  skipBuild: boolean;
  skipGradle: boolean;
  noIcons: boolean;
  noOverrides: boolean;
  verbose: boolean;
}

function parseMobileArgs(args: string[]): MobileArgs {
  const entry = getCommand("mobile")!;
  const parsed = parseArgv(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    process.exit(0);
  }
  const port = parsed.flags.port as number;
  return {
    game: parsed.flags.game as string,
    target: parsed.flags.target as MobileArgs["target"],
    port: port === 0 ? 8765 : port,
    skipBuild: parsed.flags["skip-build"] as boolean,
    skipGradle: parsed.flags["skip-gradle"] as boolean,
    noIcons: parsed.flags["no-icons"] as boolean,
    noOverrides: parsed.flags["no-overrides"] as boolean,
    verbose: parsed.flags.verbose as boolean,
  };
}

/**
 * Ensure the game has a mobile entry file. If none exists, auto-generate
 * a stub at `src/mobile.tsx` with the correct structure.
 *
 * The generated stub is a starting point — it has a placeholder GameModule
 * that the developer needs to wire up (same renderer/sim/UI as their
 * desktop `main.tsx`). Once a shared `game-module.ts` is extracted (TODO),
 * the stub becomes a one-liner that imports and reuses it.
 *
 * @returns true if an entry exists or was generated, false on error.
 */
export function ensureMobileEntry(gameDir: string, game: string, appId: string): boolean {
  const mobileEntryTs = resolve(gameDir, "src/mobile.ts");
  const mobileEntryTsx = resolve(gameDir, "src/mobile.tsx");
  if (existsSync(mobileEntryTs) || existsSync(mobileEntryTsx)) {
    return true;
  }

  log.info("mobile", `No mobile entry found — auto-generating src/mobile.tsx...`);

  const stub = generateMobileEntryStub(game, appId);
  writeFileSync(mobileEntryTsx, stub);
  log.info("mobile", `  → Wrote ${mobileEntryTsx}`);
  log.warn("mobile", "  ! This is a stub — wire up your renderer/sim/UI (same as main.tsx).");
  log.info("mobile", "  ! Once customized, commit this file. It will not be regenerated.");
  return true;
}

/**
 * Generate a mobile entry stub for a game.
 *
 * The stub has the correct `createDowndraftMobileApp()` call structure with
 * a placeholder GameModule. The developer needs to fill in the renderer
 * factory, sim adapter, and UI mount — copying from their `main.tsx`.
 */
export function generateMobileEntryStub(game: string, appId: string): string {
  return `// ============================================================================
// ${game} — Mobile Entry Point (auto-generated by \`draft mobile\`)
// ============================================================================
//
// This is a STUB. Wire up your renderer, sim, and UI — same as src/main.tsx.
// The key difference: use createDowndraftMobileApp() instead of startGame(),
// and add touchInput config. No devtools/MCP/OSR (Electron-only).
//
// Once customized, commit this file. \`draft mobile\` will not regenerate it.
//

import { createDowndraftMobileApp } from "@downdraft/app/mobile";
import type { GameModule, GameSimWorker } from "@downdraft/app/renderer";

// TODO: Import your renderer, sim, UI — same as main.tsx
// import React from "react";
// import { createRoot } from "react-dom/client";
// import App from "./app";
// import { YourRenderer } from "./renderer/your-renderer";
// import "./styles/globals.css";

// TODO: Copy your GameSimWorker adapter from main.tsx (if any)
class MobileSimAdapter implements GameSimWorker {
  private sab = new SharedArrayBuffer(1024);
  async start(_config: unknown): Promise<void> { /* wire up your sim */ }
  onEvent(_cb: (msg: any) => void): void { /* wire up your sim events */ }
  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

const mobileModule: GameModule = {
  // TODO: Wire up your renderer factory (copy from main.tsx)
  renderer: (canvas) => ({
    async init() { return true; },
    setBuffers() {},
    setupInputListeners() {},
    render() {},
    stop() {},
    getFPS() { return 0; },
  }),

  // TODO: Wire up your sim (copy from main.tsx)
  sim: () => new MobileSimAdapter(),
  simConfig: {},

  // TODO: Wire up your UI mount (copy from main.tsx)
  mountUI: (overlay) => {
    overlay.innerHTML = '<h1 style="color:white;font-family:monospace">${game} — mobile stub</h1>';
  },

  onReady: (_ctx) => {
    print("[mobile] ${game} ready");
  },
};

createDowndraftMobileApp({
  appId: "${appId}",
  module: mobileModule,
  // TODO: Choose a touch input scheme:
  //   "dual-stick"   — 3D FPS/TPS (left=move, right=look)
  //   "tap-to-move"  — 2D/3D click-to-move
  //   "tap"          — 2D click-based (falling-sand, sandjongg)
  touchInput: { scheme: "tap" },
}).catch((e) => {
  log.error("CLI", "[mobile] Fatal:", e);
});
`;
}

/**
 * Build the web bundle for mobile using the mobile Vite config.
 */
export async function buildMobileWeb(gameDir: string, env?: Record<string, string>): Promise<boolean> {
  log.info("mobile", "Building web bundle for mobile (dist/mobile/)...");

  // Forward env (e.g. DOWNDRAFT_BAKE=0) into the build process so the Vite
  // asset-bake plugin picks it up. Vite reads env at config-eval time.
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }

  // Use Vite's programmatic build API.
  const { build: viteBuild } = await import("vite");

  // If the game has a mobile.vite.config.ts, load it; otherwise use the
  // engine's default mobile config factory.
  let config: any;
  const gameConfigPath = resolve(gameDir, "mobile.vite.config.ts");
  if (existsSync(gameConfigPath)) {
    const mod = await import(gameConfigPath);
    config = mod.default;
  } else {
    log.warn("mobile", `No mobile.vite.config.ts found. Using default mobile Vite config.`);
    const { createDowndraftMobileViteConfig } = await import(
      "../../app/src/vite/mobile-vite-config"
    );
    config = createDowndraftMobileViteConfig({ root: gameDir, game: basename(gameDir) });
  }

  try {
    await viteBuild(config);
    log.info("mobile", "Web bundle built → dist/mobile/");
    return true;
  } catch (err) {
    log.error("mobile", `Web build failed: ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shell copy + patch
// ---------------------------------------------------------------------------

/**
 * Copy the engine-owned native shell into the game directory.
 *
 * Copies `packages/mobile-shell/{android,ios}/` → `games/<game>/{android,ios}/`.
 * Existing directories are replaced (rm + copy) so re-running `draft mobile`
 * picks up shell updates cleanly.
 */
function copyShell(gameDir: string, shellDir: string, target: MobileArgs["target"]): boolean {
  const platforms = target === "all" ? ["android", "ios"] : [target];

  for (const platform of platforms) {
    const src = resolve(shellDir, platform);
    if (!existsSync(src)) {
      log.error("mobile", `Shell ${platform} project not found at ${src}`);
      log.info("mobile", "Ensure packages/mobile-shell/ is present in the engine repo.");
      return false;
    }

    const dest = resolve(gameDir, platform);

    // Remove existing directory (it's gitignored, so safe to replace)
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }

    log.info("mobile", `Copying shell → ${platform}/...`);
    cpSync(src, dest, {
      recursive: true,
      force: true,
      // Skip build artifacts and gradle wrapper cache if present
      filter: (srcPath) => {
        const rel = srcPath.substring(src.length);
        return !rel.includes("/build/") && !rel.includes("/.gradle/");
      },
    });
    log.info("mobile", `  → ${platform}/ copied from packages/mobile-shell/${platform}/`);
  }

  return true;
}

/**
 * Patch game-specific values into the copied shell.
 *
 * Replaces placeholder strings in the native project files:
 *   __APP_ID__       → game's Capacitor appId (e.g. com.downdraft.sandjongg)
 *   __APP_NAME__     → game's display name (e.g. Sandjongg)
 *   __SERVER_PORT__  → embedded server port (e.g. 8765)
 *   com.downdraft.shell (iOS bundle ID) → game's appId
 */
export function patchShell(
  gameDir: string,
  appId: string,
  appName: string,
  port: number,
  target: MobileArgs["target"],
): void {
  const portStr = String(port);
  const platforms = target === "all" ? ["android", "ios"] : [target];

  for (const platform of platforms) {
    const platformDir = resolve(gameDir, platform);
    if (!existsSync(platformDir)) continue;

    log.info("mobile", `Patching ${platform} shell (appId=${appId}, name=${appName}, port=${port})...`);

    if (platform === "android") {
      patchFile(resolve(platformDir, "app/build.gradle"), [
        { from: "__APP_ID__", to: appId },
      ]);
      patchFile(resolve(platformDir, "app/src/main/res/values/strings.xml"), [
        { from: "__APP_NAME__", to: appName },
        { from: "__APP_ID__", to: appId },
      ]);
      patchFile(resolve(platformDir, "app/src/main/java/com/downdraft/shell/MainActivity.java"), [
        { from: "__SERVER_PORT__", to: portStr },
      ]);
    } else if (platform === "ios") {
      patchFile(resolve(platformDir, "App/App/AppDelegate.swift"), [
        { from: "__SERVER_PORT__", to: portStr },
      ]);
      patchFile(resolve(platformDir, "App/App/SceneDelegate.swift"), [
        { from: "__SERVER_PORT__", to: portStr },
      ]);
      patchFile(resolve(platformDir, "App/App/Info.plist"), [
        { from: "__APP_NAME__", to: appName },
      ]);
      patchFile(resolve(platformDir, "App/App.xcodeproj/project.pbxproj"), [
        { from: "com.downdraft.shell", to: appId },
      ]);
    }
  }
}

function patchFile(
  filePath: string,
  replacements: Array<{ from: string; to: string }>,
): void {
  if (!existsSync(filePath)) {
    log.warn("mobile", `  ! File not found for patching: ${filePath}`);
    return;
  }
  let content = readFileSync(filePath, "utf-8");
  let changed = false;
  for (const { from, to } of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(filePath, content);
    log.info("mobile", `  ✓ Patched ${basename(filePath)}`);
  }
}

// ---------------------------------------------------------------------------
// Override layer
// ---------------------------------------------------------------------------

/**
 * Apply the game's `mobile-overrides/` merge layer to the copied shell.
 *
 * This lets games add native permissions, dependencies, resources, and
 * other customizations without owning the full native project.
 *
 * Supported overrides:
 *   mobile-overrides/android/
 *     AndroidManifest.xml    → merged (appends <uses-permission> + other children)
 *     app/build.gradle       → appends dependency lines from dependencies { } block
 *     res/                   → recursively copied into app/src/main/res/ (overrides icons)
 *   mobile-overrides/ios/
 *     Info.plist             → merged (appends keys)
 *     Assets.xcassets/       → recursively copied (overrides icons)
 *     App.entitlements       → copied into App/App/
 *   mobile-overrides/native-deps.json  → structured extra deps
 */
export function applyOverrides(gameDir: string, target: MobileArgs["target"]): void {
  const overridesDir = resolve(gameDir, "mobile-overrides");
  if (!existsSync(overridesDir)) {
    log.info("mobile", "No mobile-overrides/ directory found — using stock shell.");
    return;
  }

  log.info("mobile", `Applying overrides from ${overridesDir}/...`);
  const platforms = target === "all" ? ["android", "ios"] : [target];

  for (const platform of platforms) {
    const platformOverrides = resolve(overridesDir, platform);
    if (!existsSync(platformOverrides)) continue;

    const platformDir = resolve(gameDir, platform);
    if (!existsSync(platformDir)) continue;

    if (platform === "android") {
      applyAndroidOverrides(platformOverrides, platformDir);
    } else if (platform === "ios") {
      applyIosOverrides(platformOverrides, platformDir);
    }
  }

  // Apply structured native deps
  const nativeDepsPath = resolve(overridesDir, "native-deps.json");
  if (existsSync(nativeDepsPath)) {
    applyNativeDeps(nativeDepsPath, gameDir, target);
  }
}

function applyAndroidOverrides(overridesDir: string, androidDir: string): void {
  // Merge AndroidManifest.xml
  const manifestOverride = resolve(overridesDir, "AndroidManifest.xml");
  if (existsSync(manifestOverride)) {
    const shellManifest = resolve(androidDir, "app/src/main/AndroidManifest.xml");
    mergeAndroidManifest(shellManifest, manifestOverride);
  }

  // Merge app/build.gradle (append dependencies)
  const gradleOverride = resolve(overridesDir, "app/build.gradle");
  if (existsSync(gradleOverride)) {
    const shellGradle = resolve(androidDir, "app/build.gradle");
    mergeGradleDeps(shellGradle, gradleOverride);
  }

  // Copy res/ overrides (icons, custom resources)
  const resOverride = resolve(overridesDir, "res");
  if (existsSync(resOverride)) {
    const shellRes = resolve(androidDir, "app/src/main/res");
    cpSync(resOverride, shellRes, { recursive: true, force: true });
    log.info("mobile", "  ✓ Copied res/ overrides");
  }
}

function applyIosOverrides(overridesDir: string, iosDir: string): void {
  // Merge Info.plist
  const plistOverride = resolve(overridesDir, "Info.plist");
  if (existsSync(plistOverride)) {
    const shellPlist = resolve(iosDir, "App/App/Info.plist");
    mergeInfoPlist(shellPlist, plistOverride);
  }

  // Copy Assets.xcassets/ overrides (icons)
  const assetsOverride = resolve(overridesDir, "Assets.xcassets");
  if (existsSync(assetsOverride)) {
    const shellAssets = resolve(iosDir, "App/App/Assets.xcassets");
    cpSync(assetsOverride, shellAssets, { recursive: true, force: true });
    log.info("mobile", "  ✓ Copied Assets.xcassets/ overrides");
  }

  // Copy entitlements
  const entitlementsOverride = resolve(overridesDir, "App.entitlements");
  if (existsSync(entitlementsOverride)) {
    const shellEntitlements = resolve(iosDir, "App/App/App.entitlements");
    cpSync(entitlementsOverride, shellEntitlements, { force: true });
    log.info("mobile", "  ✓ Copied App.entitlements (configure CODE_SIGN_ENTITLEMENTS in Xcode)");
  }
}

/**
 * Merge <uses-permission> and other child elements from the override
 * AndroidManifest.xml into the shell's manifest.
 *
 * This is a targeted merge: it extracts <uses-permission> tags and
 * <application> child elements from the override and appends them to the
 * shell manifest. It does NOT do full XML tree merging.
 */
function mergeAndroidManifest(shellPath: string, overridePath: string): void {
  const shell = readFileSync(shellPath, "utf-8");
  const override = readFileSync(overridePath, "utf-8");

  // Extract <uses-permission> tags from override
  const permRegex = /<uses-permission[^>]*\/>/g;
  const overridePerms = override.match(permRegex) ?? [];

  if (overridePerms.length === 0) {
    log.warn("mobile", "  ! No <uses-permission> tags found in override AndroidManifest.xml");
    return;
  }

  // Find existing permissions in shell to avoid duplicates
  const shellPerms = new Set((shell.match(permRegex) ?? []));
  const newPerms = overridePerms.filter((p) => !shellPerms.has(p));

  if (newPerms.length === 0) {
    log.info("mobile", "  → All override permissions already present in shell manifest");
    return;
  }

  // Insert new permissions before the <application> tag
  const manifestEnd = shell.indexOf("<application");
  if (manifestEnd === -1) {
    log.warn("mobile", "  ! Could not find <application> tag in shell manifest");
    return;
  }

  const patched = shell.slice(0, manifestEnd) + newPerms.join("\n    ") + "\n    " + shell.slice(manifestEnd);
  writeFileSync(shellPath, patched);
  log.info("mobile", `  ✓ Merged ${newPerms.length} permission(s) into AndroidManifest.xml`);
}

/**
 * Merge dependencies from the override build.gradle into the shell's.
 *
 * Extracts the contents of the `dependencies { }` block from the override
 * and appends them to the shell's dependencies block.
 */
function mergeGradleDeps(shellPath: string, overridePath: string): void {
  const shell = readFileSync(shellPath, "utf-8");
  const override = readFileSync(overridePath, "utf-8");

  // Extract dependencies block from override
  const depMatch = override.match(/dependencies\s*\{([\s\S]*?)\}/);
  if (!depMatch) {
    log.warn("mobile", "  ! No dependencies { } block found in override build.gradle");
    return;
  }

  const overrideDeps = depMatch[1].trim();
  if (!overrideDeps) {
    log.info("mobile", "  → Override build.gradle has no dependencies to merge");
    return;
  }

  // Append to shell's dependencies block (before the closing })
  const shellDepEnd = shell.lastIndexOf("}");
  const shellDepStart = shell.lastIndexOf("dependencies", shellDepEnd);
  if (shellDepStart === -1 || shellDepEnd === -1) {
    log.warn("mobile", "  ! Could not find dependencies block in shell build.gradle");
    return;
  }

  const patched = shell.slice(0, shellDepEnd) + "    // --- mobile-overrides ---\n    " + overrideDeps + "\n" + shell.slice(shellDepEnd);
  writeFileSync(shellPath, patched);
  log.info("mobile", "  ✓ Merged dependencies into app/build.gradle");
}

/**
 * Merge keys from the override Info.plist into the shell's.
 *
 * This is a targeted merge: it extracts top-level <key> + <value> pairs from
 * the override and inserts them into the shell's plist if they don't already
 * exist. Existing keys are NOT overwritten (shell values take precedence).
 */
function mergeInfoPlist(shellPath: string, overridePath: string): void {
  const shell = readFileSync(shellPath, "utf-8");
  const override = readFileSync(overridePath, "utf-8");

  // Extract key-value pairs from override plist
  // Plist format: <key>KEY</key> followed by <type>value</type>
  const keyValueRegex = /<key>([^<]+)<\/key>\s*<[^>]+>([^<]*)<\/[^>]+>/g;
  const overridePairs = new Map<string, string>();
  let match;
  while ((match = keyValueRegex.exec(override)) !== null) {
    overridePairs.set(match[1], match[0]);
  }

  if (overridePairs.size === 0) {
    log.warn("mobile", "  ! No key-value pairs found in override Info.plist");
    return;
  }

  // Find which keys are already in the shell
  const newPairs: string[] = [];
  for (const [key, xml] of overridePairs) {
    if (!shell.includes(`<key>${key}</key>`)) {
      newPairs.push(xml);
    }
  }

  if (newPairs.length === 0) {
    log.info("mobile", "  → All override plist keys already present in shell");
    return;
  }

  // Insert before the closing </dict>
  const closeDictIdx = shell.lastIndexOf("</dict>");
  if (closeDictIdx === -1) {
    log.warn("mobile", "  ! Could not find </dict> in shell Info.plist");
    return;
  }

  const patched = shell.slice(0, closeDictIdx) + "\t" + newPairs.join("\n\t") + "\n" + shell.slice(closeDictIdx);
  writeFileSync(shellPath, patched);
  log.info("mobile", `  ✓ Merged ${newPairs.length} key(s) into Info.plist`);
}

/**
 * Apply structured native dependencies from native-deps.json.
 *
 * Format:
 * {
 *   "android": ["com.some.sdk:sdk:1.0.0"],
 *   "ios": ["pod 'SomeSDK', '~> 1.0'"]
 * }
 */
function applyNativeDeps(
  depsPath: string,
  gameDir: string,
  target: MobileArgs["target"],
): void {
  const deps = JSON.parse(readFileSync(depsPath, "utf-8"));
  const platforms = target === "all" ? ["android", "ios"] : [target];

  for (const platform of platforms) {
    const platformDeps = deps[platform];
    if (!platformDeps || !Array.isArray(platformDeps) || platformDeps.length === 0) continue;

    if (platform === "android") {
      const gradlePath = resolve(gameDir, "android/app/build.gradle");
      if (!existsSync(gradlePath)) continue;
      let gradle = readFileSync(gradlePath, "utf-8");
      const depLines = platformDeps.map((d: string) => `    implementation "${d}"`).join("\n");
      const closeBrace = gradle.lastIndexOf("}");
      gradle = gradle.slice(0, closeBrace) + "    // --- native-deps.json ---\n" + depLines + "\n" + gradle.slice(closeBrace);
      writeFileSync(gradlePath, gradle);
      log.info("mobile", `  ✓ Added ${platformDeps.length} Android dep(s) from native-deps.json`);
    } else if (platform === "ios") {
      // iOS deps go into a Podfile memo — Capacitor manages the Podfile,
      // so we just log instructions.
      log.info("mobile", `  → iOS deps from native-deps.json: add to Podfile manually:`);
      for (const dep of platformDeps) {
        log.info("mobile", `      ${dep}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capacitor config
// ---------------------------------------------------------------------------

/**
 * Ensure the game has a capacitor.config.ts. Write one if missing.
 *
 * If one already exists, read the appId from it. If not, write a default
 * config with the embedded server URL.
 */
async function ensureCapacitorConfig(
  gameDir: string,
  appId: string,
  appName: string,
  port: number,
): Promise<string> {
  const capConfigPath = resolve(gameDir, "capacitor.config.ts");

  if (existsSync(capConfigPath)) {
    log.info("mobile", "capacitor.config.ts exists — using existing config.");
    // Read appId from existing config
    try {
      const mod = await import(capConfigPath);
      const capConfig = mod.default;
      if (capConfig?.appId) return capConfig.appId;
    } catch {
      // Ignore parse errors
    }
    return appId;
  }

  // Write a new capacitor.config.ts
  const capConfig = `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "${appId}",
  appName: "${appName}",
  webDir: "dist/mobile",
  server: {
    // The embedded HTTP server (started by the shell's MainActivity/AppDelegate)
    // serves assets with COOP/COEP headers for SharedArrayBuffer cross-origin
    // isolation. Capacitor loads from this URL directly.
    androidScheme: "http",
    iosScheme: "http",
    url: "http://127.0.0.1:${port}/index.html",
  },
};

export default config;
`;
  writeFileSync(capConfigPath, capConfig);
  log.info("mobile", `Wrote ${capConfigPath}`);
  return appId;
}

/**
 * Run `cap sync` to populate web assets + Capacitor plugin configs.
 */
async function syncCapacitor(gameDir: string, target: MobileArgs["target"]): Promise<boolean> {
  log.info("mobile", "Syncing web bundle to native projects...");

  const capBin = resolveCapBinary(gameDir);
  const capArgs = target === "all" ? ["sync"] : ["sync", target];
  try {
    const capResult = spawnSync(capBin, capArgs, { cwd: gameDir, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    if (capResult.stdout) process.stdout.write(capResult.stdout);
    if (capResult.stderr) process.stderr.write(capResult.stderr);
    if (capResult.status !== 0) throw new Error(`cap sync exited with code ${capResult.status}`);
    log.info("mobile", "Capacitor sync complete.");
    return true;
  } catch (err) {
    log.error("mobile", `Capacitor sync failed: ${(err as Error).message}`);
    log.info("mobile", "Ensure @capacitor/cli + @capacitor/android + @capacitor/ios are installed:");
    log.info("mobile", "  bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Native build + artifact collection
// ---------------------------------------------------------------------------

/**
 * Build the release APK via the Gradle wrapper.
 *
 * Runs `./gradlew assembleRelease` inside the game's `android/` directory.
 * The Gradle wrapper (gradlew / gradlew.bat) ships with the engine-owned
 * shell, so no system Gradle install is required — only the Android SDK.
 *
 * @returns true on success, false on failure.
 */
async function buildAndroidApk(gameDir: string): Promise<boolean> {
  const androidDir = resolve(gameDir, "android");
  if (!existsSync(androidDir)) {
    log.error("mobile", `Android project not found at ${androidDir} (did sync run?)`);
    return false;
  }

  const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

  // Write local.properties with the Android SDK path so Gradle can find it.
  // Try ANDROID_HOME, ANDROID_SDK_ROOT, then common default locations.
  const home = process.env.HOME ?? "";
  const sdkCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    `${home}/Android/Sdk`,
    `${home}/.local/share/android-sdk`,
    "/opt/android-sdk",
  ].filter(Boolean) as string[];
  const sdkDir = sdkCandidates.find((p) => existsSync(p));
  if (sdkDir) {
    writeFileSync(resolve(androidDir, "local.properties"), `sdk.dir=${sdkDir}\n`);
  } else {
    log.warn("mobile", "ANDROID_HOME / ANDROID_SDK_ROOT not set and no SDK found at common locations.");
    log.warn("mobile", "  Tried: " + sdkCandidates.join(", "));
    log.warn("mobile", "  Set ANDROID_HOME to your SDK path or install via Android Studio → SDK Manager.");
  }

  // Stop any stale Gradle daemons from previous runs — they can hold locks
  // and block the new build indefinitely. `gradlew --stop` is the graceful
  // way and is sufficient with --no-daemon on the new build. We avoid pkill/
  // pgrep here because the pattern can match the current process's command
  // line (which contains the pattern as an argument), causing self-kill.
  log.info("mobile", "Stopping stale Gradle daemons...");
  spawnSync(wrapper, ["--stop"], { cwd: androidDir, stdio: "ignore", timeout: 10_000 });

  log.info("mobile", "Building release APK (gradle assembleRelease)...");
  log.info("mobile", "  Requires the Android SDK. First run may download Gradle — be patient.");
  // Use spawnSync with piped stdio + a hard timeout + --no-daemon to prevent
  // stuck Gradle daemons and TTY hangs. stdio: "inherit" can block forever in
  // VSCode terminals when Gradle tries to read stdin; piping avoids that.
  const result = spawnSync(wrapper, ["assembleRelease", "--no-daemon"], {
    cwd: androidDir,
    stdio: ["ignore", "pipe", "pipe"], // pipe stdout/stderr — we log it ourselves
    timeout: 300_000, // 5 min hard timeout (cold Gradle + first build can be slow)
  });
  // Stream Gradle output to the console so the user sees progress.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    log.error("mobile", `Gradle build failed to start: ${(result.error as Error).message}`);
    return false;
  }
  if (result.signal === "SIGTERM") {
    log.error("mobile", "Gradle build timed out after 5 minutes. Check for stuck daemons or SDK issues.");
    return false;
  }
  if (result.status !== 0) {
    log.error("mobile", `Gradle build failed with exit code ${result.status}.`);
    log.info("mobile", "Ensure the Android SDK is installed (Android Studio → SDK Manager).");
    log.info("mobile", "Set ANDROID_HOME / ANDROID_SDK_ROOT to the SDK location if not auto-detected.");
    return false;
  }
  log.info("mobile", "APK build complete.");
  return true;
}

/**
 * Collect the built APK into the release directory, mirroring electron's
 * `release/` convention (see `draft dist` → electron-builder `directories.output`).
 *
 * - Copies the release APK → `release/<appName>-<version>-android.apk`
 * - Unpacks the APK contents → `release/android-unpacked/` (best-effort, for
 *   inspection; skipped if `unzip` is unavailable).
 *
 * Both directories are gitignored (covered by the root `release` entry in
 * `.gitignore`). Stale contents are cleared before each run so artifacts
 * never accumulate from previous builds.
 *
 * @returns the path to the collected APK, or null if none was found.
 */
export function collectAndroidArtifacts(
  gameDir: string,
  repoRoot: string,
  appName: string,
  version: string,
): string | null {
  const apkDir = resolve(gameDir, "android/app/build/outputs/apk/release");
  if (!existsSync(apkDir)) {
    log.error("mobile", `No APK output directory found at ${apkDir}`);
    log.info("mobile", "Did the gradle build produce an APK? Check android/app/build/outputs/.");
    return null;
  }

  // Find the produced APK. Release builds without a signing config produce
  // `app-release-unsigned.apk`; signed builds produce `app-release.apk`.
  const apks = readdirSync(apkDir).filter((f) => f.endsWith(".apk"));
  if (apks.length === 0) {
    log.error("mobile", `No .apk files found in ${apkDir}`);
    return null;
  }
  // Prefer a signed (non-"unsigned") apk if both exist; otherwise take the first.
  const chosen = apks.find((f) => !f.includes("unsigned")) ?? apks[0];
  const srcApk = resolve(apkDir, chosen);

  // Prepare release/ + release/android-unpacked/ — clear stale APK artifacts.
  const releaseDir = resolve(repoRoot, "release");
  const releaseUnpackedDir = resolve(repoRoot, "release/android-unpacked");
  if (!existsSync(releaseDir)) mkdirSync(releaseDir, { recursive: true });
  rmSync(releaseUnpackedDir, { recursive: true, force: true });
  // Remove stale .apk files from previous mobile builds (don't wipe the
  // whole release/ dir — desktop builds put their artifacts here too).
  for (const f of readdirSync(releaseDir)) {
    if (f.endsWith(".apk")) rmSync(resolve(releaseDir, f), { force: true });
  }

  const destName = `${appName}-${version}-android.apk`;
  const destApk = resolve(releaseDir, destName);
  cpSync(srcApk, destApk, { force: true });
  log.info("mobile", `  → APK collected: release/${destName}`);

  // Best-effort unpack for inspection (APK is a zip). Skipped if `unzip`
  // is unavailable — non-fatal.
  try {
    mkdirSync(releaseUnpackedDir, { recursive: true });
    const unzipResult = spawnSync("unzip", ["-o", destApk, "-d", releaseUnpackedDir], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    if (unzipResult.status !== 0) throw new Error(`unzip exited with code ${unzipResult.status}`);
    log.info("mobile", `  → Unpacked: release/android-unpacked/`);
  } catch {
    log.warn("mobile", "  ! Could not unpack APK (is `unzip` installed?). Skipping unpacked dir.");
    rmSync(releaseUnpackedDir, { recursive: true, force: true });
  }

  return destApk;
}

// ---------------------------------------------------------------------------
// APK signing
// ---------------------------------------------------------------------------
//
// `draft mobile` runs `gradlew assembleRelease` against a release buildType
// that has no `signingConfig` (the shell's app/build.gradle is stock). This
// produces an `app-release-unsigned.apk` that Android silently refuses to
// install — the device shows a generic "you can't install the app" message
// with no further detail. To avoid that footgun, we sign the collected APK
// as a post-build step:
//
//   1. Resolve a signing config (release keystore → debug keystore fallback).
//   2. Locate `apksigner` + `zipalign` from the Android SDK build-tools.
//   3. zipalign (4-byte, page-aligned .so) → apksigner sign → verify.
//
// Signing is a post-step, not a Gradle concern, so the shell's build.gradle
// stays stock and no secrets live in any Gradle file or game directory.

export interface SigningConfig {
  keystore: string;
  storePass: string;
  alias: string;
  keyPass: string;
  /** "release" = a real keystore was supplied; "debug" = debug-keystore fallback. */
  mode: "release" | "debug";
}

/**
 * Resolve the user's home directory.
 *
 * Prefers `process.env.HOME` (respects runtime overrides — important for
 * tests and for environments that reassign HOME) and falls back to
 * `os.homedir()`, which some runtimes cache at process start.
 */
function userHome(): string {
  return process.env.HOME || homedir();
}

/**
 * Resolve the keystore to sign the APK with.
 *
 * Precedence (env wins, per the "both, env wins" decision):
 *   1. Env vars:  DD_RELEASE_KEYSTORE / DD_RELEASE_KEYSTORE_PASS /
 *                 DD_RELEASE_KEY_ALIAS / DD_RELEASE_KEY_PASS
 *   2. ~/.downdraft/keystore.properties (gitignored, user-level):
 *        keystore=<path>
 *        storepass=<password>
 *        alias=<key alias>
 *        keypass=<key password>
 *   3. Fallback: ~/.android/debug.keystore (standard Android debug keystore,
 *      credentials alias=androiddebugkey / pass=android). Emits a warning
 *      that the APK is debug-signed and not suitable for distribution.
 *
 * @returns the resolved config, or null if no keystore is available at all
 *          (not even the debug keystore) — caller should warn + leave unsigned.
 */
export function resolveSigningConfig(): SigningConfig | null {
  // 1. Env vars
  const envKeystore = process.env.DD_RELEASE_KEYSTORE;
  if (envKeystore) {
    if (!existsSync(envKeystore)) {
      log.warn("mobile", `  ! DD_RELEASE_KEYSTORE points to a missing file: ${envKeystore}`);
    } else {
      return {
        keystore: envKeystore,
        storePass: process.env.DD_RELEASE_KEYSTORE_PASS ?? "",
        alias: process.env.DD_RELEASE_KEY_ALIAS ?? "",
        keyPass: process.env.DD_RELEASE_KEY_PASS ?? process.env.DD_RELEASE_KEYSTORE_PASS ?? "",
        mode: "release",
      };
    }
  }

  // 2. ~/.downdraft/keystore.properties
  const propsPath = join(userHome(), ".downdraft", "keystore.properties");
  if (existsSync(propsPath)) {
    const props = parsePropertiesFile(propsPath);
    const keystore = props.keystore;
    if (keystore && existsSync(keystore)) {
      return {
        keystore,
        storePass: props.storepass ?? "",
        alias: props.alias ?? "",
        keyPass: props.keypass ?? props.storepass ?? "",
        mode: "release",
      };
    }
    if (keystore) {
      log.warn("mobile", `  ! ~/.downdraft/keystore.properties references a missing keystore: ${keystore}`);
    }
  }

  // 3. Debug keystore fallback
  const debugKeystore = join(userHome(), ".android", "debug.keystore");
  if (existsSync(debugKeystore)) {
    log.warn("mobile", "  ! No release keystore configured — signing with the debug keystore.");
    log.warn("mobile", "  ! The APK is installable for testing but NOT suitable for distribution.");
    log.info("mobile", "  ! To sign for release, set DD_RELEASE_KEYSTORE* env vars or");
    log.info("mobile", "  ! create ~/.downdraft/keystore.properties (see draft mobile docs).");
    return {
      keystore: debugKeystore,
      storePass: "android",
      alias: "androiddebugkey",
      keyPass: "android",
      mode: "debug",
    };
  }

  return null;
}

/**
 * Parse a minimal Java .properties file (key=value, # comments, blank lines).
 * Leading/trailing whitespace is trimmed from both keys and values.
 */
function parsePropertiesFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export interface BuildToolsBinaries {
  apksigner: string;
  zipalign: string;
}

/**
 * Locate `apksigner` + `zipalign` from the Android SDK build-tools directory.
 *
 * Checks ANDROID_HOME, ANDROID_SDK_ROOT, and ~/Android/Sdk (Android Studio's
 * default install location on Linux/macOS). Picks the highest-versioned
 * build-tools/ subdirectory that contains both binaries.
 *
 * @returns the binary paths, or null if the SDK / build-tools can't be found.
 */
export function resolveAndroidBuildTools(): BuildToolsBinaries | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(userHome(), "Android", "Sdk"),
  ].filter((p): p is string => !!p && existsSync(p));

  for (const sdk of candidates) {
    const buildToolsRoot = join(sdk, "build-tools");
    if (!existsSync(buildToolsRoot)) continue;
    // Pick the highest version directory. Versions are like "35.0.0", "36.0.0".
    const versions = readdirSync(buildToolsRoot)
      .filter((d) => existsSync(join(buildToolsRoot, d, "apksigner")))
      .sort((a, b) => compareVersions(a, b));
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    const dir = join(buildToolsRoot, latest);
    const apksigner = join(dir, "apksigner");
    const zipalign = join(dir, "zipalign");
    if (existsSync(apksigner) && existsSync(zipalign)) {
      return { apksigner, zipalign };
    }
  }
  return null;
}

/** Compare dotted version strings (e.g. "35.0.0" vs "36.0.0"). Ascending. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Sign an APK in place: zipalign (4-byte, page-aligned .so) → apksigner sign
 * → apksigner verify. The original file is replaced by the signed copy.
 *
 * Order matters: zipalign MUST run before apksigner (apksigner v2/v3
 * preserves alignment; signing first then aligning invalidates v2/v3).
 *
 * @returns "release" | "debug" if signing succeeded, "skipped" if no
 *          keystore or build-tools were available (the APK is left unsigned
 *          with a clear warning — see the caller's Next-steps output).
 */
export function signAndroidApk(apkPath: string): "release" | "debug" | "skipped" {
  const config = resolveSigningConfig();
  if (!config) {
    log.warn("mobile", `  ! No keystore available (not even ~/.android/debug.keystore).`);
    log.warn("mobile", `  ! APK left unsigned: ${apkPath}`);
    log.warn("mobile", `  ! Android will refuse to install it. Generate a debug keystore with:`);
    log.warn("mobile", `  !   keytool -genkey -v -keystore ~/.android/debug.keystore -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android`);
    return "skipped";
  }

  const tools = resolveAndroidBuildTools();
  if (!tools) {
    log.warn("mobile", `  ! Android SDK build-tools not found (looked in ANDROID_HOME, ANDROID_SDK_ROOT, ~/Android/Sdk).`);
    log.warn("mobile", `  ! Cannot sign the APK — left unsigned: ${apkPath}`);
    return "skipped";
  }

  log.info("mobile", `Signing APK (${config.mode} keystore)...`);

  // 1. zipalign → temp file. -f overwrites, -p page-aligns .so to 4096 bytes.
  const alignedTmp = `${apkPath}.aligned`;
  const alignResult = spawnSync(
    tools.zipalign,
    ["-f", "-p", "4", apkPath, alignedTmp],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  if (alignResult.status !== 0) {
    log.error("mobile", `  zipalign failed (exit ${alignResult.status}): ${alignResult.stderr?.toString().trim()}`);
    rmSync(alignedTmp, { force: true });
    log.warn("mobile", `  ! APK left unsigned: ${apkPath}`);
    return "skipped";
  }

  // 2. apksigner sign on the aligned temp. v1 disabled (legacy JAR signing
  //    is unnecessary on minSdk 24+); v2 + v3 enabled (required by Android 11+).
  const signResult = spawnSync(
    tools.apksigner,
    [
      "sign",
      "--ks", config.keystore,
      "--ks-key-alias", config.alias,
      "--ks-pass", `pass:${config.storePass}`,
      "--key-pass", `pass:${config.keyPass}`,
      "--v1-signing-enabled", "false",
      "--v2-signing-enabled", "true",
      "--v3-signing-enabled", "true",
      alignedTmp,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  if (signResult.status !== 0) {
    log.error("mobile", `  apksigner sign failed (exit ${signResult.status}): ${signResult.stderr?.toString().trim()}`);
    rmSync(alignedTmp, { force: true });
    log.warn("mobile", `  ! APK left unsigned: ${apkPath}`);
    return "skipped";
  }

  // 3. Verify the signed temp before swapping it in.
  const verifyResult = spawnSync(tools.apksigner, ["verify", "--verbose", alignedTmp], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (verifyResult.status !== 0 || !verifyResult.stdout?.toString().includes("Verifies")) {
    log.error("mobile", `  apksigner verify failed: ${verifyResult.stdout?.toString().trim()}`);
    rmSync(alignedTmp, { force: true });
    log.warn("mobile", `  ! APK left unsigned: ${apkPath}`);
    return "skipped";
  }

  // 4. Replace the original with the signed + aligned copy.
  rmSync(apkPath, { force: true });
  // Rename across same directory — synchronous, atomic on same filesystem.
  renameSync(alignedTmp, apkPath);

  const schemes = verifyResult.stdout
    .toString()
    .split(/\r?\n/)
    .filter((l) => l.includes("Verified using v") && l.includes(": true"))
    .map((l) => l.replace(/Verified using /, "").replace(/ \(.*$/, "").trim());
  log.info("mobile", `  ✓ Signed (${config.mode}, ${schemes.join(" + ") || "v2/v3"}): ${basename(apkPath)}`);
  return config.mode;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Package a game for mobile distribution (Capacitor shell + Gradle + sign).
 *
 * Extracted from `mobile()` so `draft release --stage=package` can call it
 * directly without going through the argv-parsing entry point. This does
 * steps 3–9 of the mobile pipeline (shell copy through APK sign + collect).
 * The web bundle build (step 2) is handled separately by `buildMobileWeb()`.
 *
 * @returns the path to the collected APK (Android), or null for iOS-only.
 */
export async function packageMobile(
  opts: MobileArgs,
  gameDir: string,
  repoRoot: string | null,
): Promise<string | null> {
  // The Capacitor shell lives in packages/mobile-shell (private, engine-owned),
  // so mobile packaging is only available inside the monorepo.
  if (!repoRoot) {
    log.error("release:package:mobile", "Mobile packaging requires the downdraft monorepo.");
    log.info("release:package:mobile", "The Capacitor shell (packages/mobile-shell) is not published to npm.");
    process.exit(1);
  }
  const shellDir = resolve(repoRoot, "packages/mobile-shell");

  // Check prerequisites
  if (!existsSync(gameDir)) {
    log.error("release:package:mobile", `Game directory not found: ${gameDir}`);
    process.exit(1);
  }
  if (!existsSync(shellDir)) {
    log.error("release:package:mobile", `Mobile shell not found at ${shellDir}`);
    log.info("release:package:mobile", "Ensure packages/mobile-shell/ is present in the engine repo.");
    process.exit(1);
  }

  // Determine appId + appName
  let appId = `com.downdraft.${opts.game.replace(/-/g, "")}`;
  const capConfigPath = resolve(gameDir, "capacitor.config.ts");
  if (existsSync(capConfigPath)) {
    try {
      const mod = await import(capConfigPath);
      const capConfig = mod.default;
      if (capConfig?.appId) appId = capConfig.appId;
    } catch {
      // Ignore config parse errors — fall back to default appId
    }
  }

  // Determine appName + version from package.json (productName / version)
  let appName = opts.game;
  let version = "0.0.0";
  const pkgJsonPath = resolve(gameDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.productName) appName = pkg.productName;
      if (pkg.version) version = pkg.version;
    } catch {
      // Ignore parse errors
    }
  }

  // Ensure the game has a mobile entry file (auto-generate stub if missing)
  if (!ensureMobileEntry(gameDir, opts.game, appId)) {
    process.exit(1);
  }

  log.info("release:package:mobile", `  AppId:       ${appId}`);
  log.info("release:package:mobile", `  AppName:     ${appName}`);
  log.info("release:package:mobile", "");

  // Copy the engine-owned native shell into the game directory
  const copyOk = copyShell(gameDir, shellDir, opts.target);
  if (!copyOk) process.exit(1);

  // Patch game-specific values into the shell
  patchShell(gameDir, appId, appName, opts.port, opts.target);

  // Generate app icons + splash screens from icon.png (or placeholder)
  if (!opts.noIcons) {
    const androidDir = resolve(gameDir, "android");
    const iosAppDir = resolve(gameDir, "ios/App/App");
    await generateIcons(gameDir, androidDir, iosAppDir);
  } else {
    log.info("release:package:mobile", "Skipping icon generation (--no-icons).");
    log.warn("release:package:mobile", "  The shell has no placeholder images — build will fail without icons.");
    log.info("release:package:mobile", "  Provide icons via mobile-overrides/ or remove --no-icons.");
  }

  // Apply mobile-overrides/ merge layer (if present)
  if (!opts.noOverrides) {
    applyOverrides(gameDir, opts.target);
  } else {
    log.info("release:package:mobile", "Skipping overrides (--no-overrides).");
  }

  // Ensure capacitor.config.ts exists (write if missing)
  appId = await ensureCapacitorConfig(gameDir, appId, appName, opts.port);

  // Sync web bundle to native projects
  const syncOk = await syncCapacitor(gameDir, opts.target);
  if (!syncOk) process.exit(1);

  // Build the release APK + collect it into release/ (Android only).
  let apkPath: string | null = null;
  if (opts.target === "android" || opts.target === "all") {
    if (opts.skipGradle) {
      log.info("release:package:mobile", "Skipping Gradle APK build (--skip-gradle).");
    } else {
      const buildOk = await buildAndroidApk(gameDir);
      if (!buildOk) process.exit(1);

      apkPath = collectAndroidArtifacts(gameDir, repoRoot, appName, version);
      if (!apkPath) process.exit(1);

      // Sign the collected APK in place (release keystore → debug fallback).
      const signStatus = signAndroidApk(apkPath);
      if (signStatus === "release") {
        log.info("release:package:mobile", `  Signed with release keystore — ready for distribution.`);
      } else if (signStatus === "debug") {
        log.info("release:package:mobile", `  Signed with debug keystore — installable for testing, NOT for distribution.`);
      } else {
        log.info("release:package:mobile", `  UNSIGNED — Android will refuse to install it. See warnings above.`);
      }
    }
  }

  return apkPath;
}

export async function mobile(args: string[]): Promise<void> {
  const opts = parseMobileArgs(args);

  log.warn("mobile", "`draft mobile` is deprecated — use `draft release --target=android,ios` instead.");
  log.warn("mobile", "Delegating to `release`...");

  // Map old mobile args → release args.
  const releaseArgs: string[] = [`--game=${opts.game}`, `--target=${opts.target}`, `--port=${opts.port}`];
  if (opts.skipBuild) releaseArgs.push("--skip-build");
  if (opts.skipGradle) releaseArgs.push("--skip-gradle");
  if (opts.noIcons) releaseArgs.push("--no-icons");
  if (opts.noOverrides) releaseArgs.push("--no-overrides");
  if (opts.verbose) releaseArgs.push("--verbose");

  const { release } = await import("./release");
  await release(releaseArgs);
}
