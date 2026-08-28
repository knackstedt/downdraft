// ============================================================================
// draft mobile — build + scaffold a Capacitor mobile target (Android / iOS)
// ============================================================================
//
// This command:
//   1. Builds the web bundle via the mobile Vite config (dist/mobile/).
//   2. Initializes Capacitor in the game directory (if not already done).
//   3. Copies the web bundle to the Capacitor web assets directory.
//   4. Injects the embedded local HTTP server native code (serves assets with
//      COOP/COEP headers for SharedArrayBuffer cross-origin isolation).
//   5. Patches the native WebView to load http://127.0.0.1:<port>/index.html
//      instead of the Capacitor default scheme.
//
// Usage:
//   draft mobile [--game=<name>] [--target=<android|ios|all>]
//                [--port=<n>] [--skip-build] [--skip-cap-init]
//
// Prerequisites:
//   - Android: Android Studio + Android SDK (for `npx cap open android`)
//   - iOS: Xcode + CocoaPods (for `npx cap open ios`)
//   - Capacitor CLI: `bun add -d @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios`
//   - The game must have a `src/mobile.ts` entry that calls
//     `createDowndraftMobileApp()`.

import { createLogger } from "@downdraft/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { detectGame } from "./detect-game";

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

interface MobileArgs {
  game: string;
  target: "android" | "ios" | "all";
  port: number;
  skipBuild: boolean;
  skipCapInit: boolean;
}

function parseArgs(args: string[]): MobileArgs {
  const opts: MobileArgs = {
    game: detectGame() ?? "to-the-ocean",
    target: "all",
    port: 8765,
    skipBuild: false,
    skipCapInit: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--game" || arg === "-g") {
      opts.game = args[++i] ?? opts.game;
    } else if (arg?.startsWith("--game=")) {
      opts.game = arg.slice("--game=".length);
    } else if (arg === "--target" || arg === "-t") {
      opts.target = (args[++i] as MobileArgs["target"]) ?? opts.target;
    } else if (arg?.startsWith("--target=")) {
      opts.target = arg.slice("--target=".length) as MobileArgs["target"];
    } else if (arg === "--port") {
      opts.port = parseInt(args[++i] ?? "8765", 10);
    } else if (arg?.startsWith("--port=")) {
      opts.port = parseInt(arg.slice("--port=".length), 10);
    } else if (arg === "--skip-build") {
      opts.skipBuild = true;
    } else if (arg === "--skip-cap-init") {
      opts.skipCapInit = true;
    }
  }
  return opts;
}

/**
 * Check that the game has a mobile entry file.
 */
function checkMobileEntry(gameDir: string): boolean {
  const mobileEntry = resolve(gameDir, "src/mobile.ts");
  if (!existsSync(mobileEntry)) {
    log.error("mobile", `No mobile entry found at ${mobileEntry}`);
    log.info("mobile", `Create one that calls createDowndraftMobileApp() from "@downdraft/app/mobile".`);
    return false;
  }
  return true;
}

/**
 * Check that the game has a mobile Vite config.
 */
function checkMobileViteConfig(gameDir: string): string | null {
  const configPath = resolve(gameDir, "mobile.vite.config.ts");
  if (existsSync(configPath)) return configPath;
  log.warn("mobile", `No mobile.vite.config.ts found at ${configPath}.`);
  log.info("mobile", `Using default mobile Vite config (createDowndraftMobileViteConfig).`);
  return null;
}

/**
 * Build the web bundle for mobile using the mobile Vite config.
 */
async function buildMobileWeb(gameDir: string, _configPath: string | null): Promise<boolean> {
  log.info("mobile", "Building web bundle for mobile (dist/mobile/)...");

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
    const { createDowndraftMobileViteConfig } = await import(
      "../../packages/app/src/vite/mobile-vite-config"
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

/**
 * Initialize Capacitor in the game directory (if not already done).
 */
async function initCapacitor(
  gameDir: string,
  game: string,
  appId: string,
  target: MobileArgs["target"],
  skipCapInit: boolean,
): Promise<boolean> {
  const capacitorConfigPath = resolve(gameDir, "capacitor.config.ts");

  if (!existsSync(capacitorConfigPath) && !skipCapInit) {
    log.info("mobile", "Initializing Capacitor...");
    const { execSync } = await import("node:child_process");

    // Write a capacitor.config.ts
    const capConfig = `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "${appId}",
  appName: "${game}",
  webDir: "dist/mobile",
  server: {
    // The embedded HTTP server serves assets with COOP/COEP headers for
    // SharedArrayBuffer cross-origin isolation. The native code overrides
    // this to load from http://127.0.0.1:${8765}/index.html at runtime.
    androidScheme: "http",
    iosScheme: "http",
  },
};

export default config;
`;
    writeFileSync(capacitorConfigPath, capConfig);
    log.info("mobile", `Wrote ${capacitorConfigPath}`);

    // Add native platforms
    const capBin = resolveCapBinary(gameDir);
    if (target === "android" || target === "all") {
      try {
        execSync(`${capBin} add android`, { cwd: gameDir, stdio: "inherit" });
        log.info("mobile", "Android platform added.");
      } catch (err) {
        log.error("mobile", `Failed to add Android platform: ${(err as Error).message}`);
        log.info("mobile", "Ensure @capacitor/android is installed: bun add -d @capacitor/android @capacitor/cli");
        return false;
      }
    }

    if (target === "ios" || target === "all") {
      try {
        execSync(`${capBin} add ios`, { cwd: gameDir, stdio: "inherit" });
        log.info("mobile", "iOS platform added.");
      } catch (err) {
        log.error("mobile", `Failed to add iOS platform: ${(err as Error).message}`);
        log.info("mobile", "Ensure @capacitor/ios is installed: bun add -d @capacitor/ios @capacitor/cli");
        return false;
      }
    }
  } else if (skipCapInit) {
    log.info("mobile", "Skipping Capacitor init (--skip-cap-init).");
  } else {
    log.info("mobile", "Capacitor already initialized (capacitor.config.ts exists).");
  }

  return true;
}

/**
 * Copy the web bundle to the Capacitor web assets directory and sync.
 */
async function syncCapacitor(gameDir: string, target: MobileArgs["target"]): Promise<boolean> {
  log.info("mobile", "Syncing web bundle to native projects...");
  const { execSync } = await import("node:child_process");

  const capBin = resolveCapBinary(gameDir);
  const capCmd = target === "all" ? `${capBin} sync` : `${capBin} sync ${target}`;
  try {
    execSync(capCmd, { cwd: gameDir, stdio: "inherit" });
    log.info("mobile", "Capacitor sync complete.");
    return true;
  } catch (err) {
    log.error("mobile", `Capacitor sync failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Inject the embedded HTTP server native code into the Android project.
 *
 * Copies the EmbeddedServer.java template and patches the MainActivity
 * to load from http://127.0.0.1:<port>/index.html.
 */
function injectAndroidServer(gameDir: string, port: number): void {
  const androidDir = resolve(gameDir, "android");
  if (!existsSync(androidDir)) {
    log.warn("mobile", "Android project not found — skipping Android server injection.");
    return;
  }

  log.info("mobile", `Injecting embedded HTTP server into Android (port ${port})...`);

  // Copy the EmbeddedServer.java template
  const templateDir = resolve(import.meta.dir, "../templates/mobile/android");
  const targetJavaDir = resolve(androidDir, "app/src/main/java/com/downdraft/embeddedserver");
  if (existsSync(templateDir)) {
    if (!existsSync(targetJavaDir)) mkdirSync(targetJavaDir, { recursive: true });
    const serverTemplate = resolve(templateDir, "EmbeddedServer.java");
    if (existsSync(serverTemplate)) {
      let content = readFileSync(serverTemplate, "utf-8");
      // Replace port placeholder
      content = content.replace(/\{\{PORT\}\}/g, String(port));
      writeFileSync(resolve(targetJavaDir, "EmbeddedServer.java"), content);
      log.info("mobile", `  → EmbeddedServer.java (port ${port})`);
    }
  }

  // Note: The actual MainActivity patching (to start the server + load the URL)
  // is documented in the template README. Games need to add the server start
  // call to their MainActivity.onCreate(). This is a one-time manual step
  // because Android project structure varies.
  log.info("mobile", "  → See packages/cli/templates/mobile/android/README.md for MainActivity wiring.");
}

/**
 * Inject the embedded HTTP server native code into the iOS project.
 */
function injectIosServer(gameDir: string, port: number): void {
  const iosDir = resolve(gameDir, "ios");
  if (!existsSync(iosDir)) {
    log.warn("mobile", "iOS project not found — skipping iOS server injection.");
    return;
  }

  log.info("mobile", `Injecting embedded HTTP server into iOS (port ${port})...`);

  // Copy the EmbeddedServer.swift template
  const templateDir = resolve(import.meta.dir, "../templates/mobile/ios");
  if (existsSync(templateDir)) {
    const serverTemplate = resolve(templateDir, "EmbeddedServer.swift");
    if (existsSync(serverTemplate)) {
      let content = readFileSync(serverTemplate, "utf-8");
      content = content.replace(/\{\{PORT\}\}/g, String(port));
      // Copy into the iOS App folder
      const appDir = resolve(iosDir, "App");
      if (existsSync(appDir)) {
        writeFileSync(resolve(appDir, "EmbeddedServer.swift"), content);
        log.info("mobile", `  → App/EmbeddedServer.swift (port ${port})`);
      }
    }
  }

  log.info("mobile", "  → See packages/cli/templates/mobile/ios/README.md for AppDelegate wiring.");
}

export async function mobile(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const repoRoot = resolve(import.meta.dir, "../../..");
  const gameDir = resolve(repoRoot, "games", opts.game);

  log.info("mobile", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Mobile (Capacitor)  ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("mobile", `  Game:        ${opts.game}`);
  log.info("mobile", `  Target:      ${opts.target}`);
  log.info("mobile", `  Port:        ${opts.port}`);
  log.info("mobile", `  Skip build:  ${opts.skipBuild}`);
  log.info("mobile", "");

  // 1. Check prerequisites
  if (!existsSync(gameDir)) {
    log.error("mobile", `Game directory not found: ${gameDir}`);
    process.exit(1);
  }

  if (!checkMobileEntry(gameDir)) {
    process.exit(1);
  }

  const configPath = checkMobileViteConfig(gameDir);

  // Determine appId from the game's package.json or capacitor config
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
  log.info("mobile", `  AppId:       ${appId}`);
  log.info("mobile", "");

  // 2. Build the web bundle
  if (!opts.skipBuild) {
    const ok = await buildMobileWeb(gameDir, configPath);
    if (!ok) process.exit(1);
  } else {
    log.info("mobile", "Skipping web build (--skip-build).");
  }

  // 3. Initialize Capacitor
  const capOk = await initCapacitor(gameDir, opts.game, appId, opts.target, opts.skipCapInit);
  if (!capOk) process.exit(1);

  // 4. Sync web bundle to native projects
  const syncOk = await syncCapacitor(gameDir, opts.target);
  if (!syncOk) process.exit(1);

  // 5. Inject embedded HTTP server (COOP/COEP for SharedArrayBuffer)
  if (opts.target === "android" || opts.target === "all") {
    injectAndroidServer(gameDir, opts.port);
  }
  if (opts.target === "ios" || opts.target === "all") {
    injectIosServer(gameDir, opts.port);
  }

  log.info("mobile", "");
  log.info("mobile", "Mobile build complete.");
  log.info("mobile", "");
  log.info("mobile", "Next steps:");
  const capBin = resolveCapBinary(gameDir);
  if (opts.target === "android" || opts.target === "all") {
    log.info("mobile", `  Android: ${capBin} open android  (then Run in Android Studio)`);
  }
  if (opts.target === "ios" || opts.target === "all") {
    log.info("mobile", `  iOS:     ${capBin} open ios      (then Run in Xcode)`);
  }
  log.info("mobile", "");
  log.info("mobile", "IMPORTANT: WebGPU requires Android WebView 121+ or iOS / iPadOS 26+.");
  log.info("mobile", "SharedArrayBuffer requires the embedded HTTP server (COOP/COEP headers).");
  log.info("mobile", "See packages/cli/templates/mobile/ for native wiring instructions.");
}
