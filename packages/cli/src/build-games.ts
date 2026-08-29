// draft build-games — Build + package multiple games for desktop and/or mobile.
//
// Replaces the inline shell script in the VSCode "Build: Game(s)" task.
// Runs entirely in-process and calls process.exit() at the end so the
// VSCode terminal doesn't hang on lingering handles (Vite imports,
// Capacitor sync, Gradle daemons, etc.).
//
// Usage:
//   draft build-games --games=<g1,g2,...> --platforms=<p1,p2,...>
//
//   --games      Comma-separated game directory names (e.g. "sandjongg")
//   --platforms  Comma-separated platform specs (e.g. "win:portable,android:all")
//
// Platform specs:
//   win:<target>       Windows (portable | nsis)
//   linux:<target>     Linux (AppImage | deb | rpm | flatpak)
//   mac:<target>       macOS (dmg | zip)
//   android:all        Android (Capacitor + Gradle)
//   ios:all            iOS (Capacitor)
//
// Environment:
//   ANDROID_HOME  Android SDK path (defaults to $HOME/Android/Sdk)
//   JAVA_HOME     JDK path (defaults to /usr/lib/jvm/java-21-openjdk-amd64)

import { createLogger } from "@downdraft/core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArgError, parseArgs as parseArgv, print, renderHelp } from "./args";
import { mobile } from "./mobile";
import { getCommand } from "./usage";

const log = createLogger();

interface BuildGamesArgs {
  games: string[];
  platforms: string[];
}

function parseBuildGamesArgs(argv: string[]): BuildGamesArgs {
  const entry = getCommand("build-games")!;
  const parsed = parseArgv(argv, entry.schema);
  // parseArgv handles required-flag validation; if we get here, both are set.
  const games = (parsed.flags.games as string) ?? "";
  const platforms = (parsed.flags.platforms as string) ?? "";
  const gameList = games.split(",").map((s) => s.trim()).filter(Boolean);
  const platformList = platforms.split(",").map((s) => s.trim()).filter(Boolean);
  if (gameList.length === 0 || platformList.length === 0) {
    throw new ArgError("Usage: draft build-games --games=<g1,g2> --platforms=<p1,p2>");
  }
  return { games: gameList, platforms: platformList };
}

interface PlatformGroups {
  win: string[];
  linux: string[];
  mac: string[];
  android: boolean;
  ios: boolean;
}

function groupPlatforms(platforms: string[]): PlatformGroups {
  const groups: PlatformGroups = { win: [], linux: [], mac: [], android: false, ios: false };
  for (const spec of platforms) {
    const [p, t] = spec.includes(":") ? spec.split(":") : [spec, ""];
    switch (p) {
      case "win": groups.win.push(t); break;
      case "linux": groups.linux.push(t); break;
      case "mac": groups.mac.push(t); break;
      case "android": groups.android = true; break;
      case "ios": groups.ios = true; break;
    }
  }
  return groups;
}

function buildEbArgs(groups: PlatformGroups): string[] {
  const args: string[] = [];
  if (groups.win.length) args.push(`--win${groups.win.join("")}`);
  if (groups.linux.length) args.push(`--linux${groups.linux.join("")}`);
  if (groups.mac.length) args.push(`--mac${groups.mac.join("")}`);
  return args;
}

function getGameInfo(gameDir: string, game: string): { productName: string; appId: string } {
  const pkgPath = resolve(gameDir, "package.json");
  if (!existsSync(pkgPath)) return { productName: game, appId: `com.downdraft.${game}` };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const productName = pkg.productName ?? pkg.build?.productName ??
      String(pkg.name ?? game).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const appId = pkg.build?.appId ?? `com.downdraft.${game}`;
    return { productName, appId };
  } catch {
    return { productName: game, appId: `com.downdraft.${game}` };
  }
}

function runCommand(cmd: string, args: string[], cwd: string, label: string): boolean {
  log.info("build-games", `[${label}] Running: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 600_000, // 10 min hard timeout
  });
  if (result.error) {
    log.error("build-games", `[${label}] Failed to start: ${(result.error as Error).message}`);
    return false;
  }
  if (result.status !== 0) {
    log.error("build-games", `[${label}] Exited with code ${result.status}`);
    return false;
  }
  return true;
}

function openReleaseFolder(repoRoot: string): void {
  const releaseDir = resolve(repoRoot, "release");
  if (!existsSync(releaseDir)) return;
  log.info("build-games", "Opening release folder...");
  // Background the opener so it doesn't block the terminal.
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(opener, [releaseDir], { stdio: "ignore", detached: true });
}

export async function buildGames(argv: string[]): Promise<void> {
  const entry = getCommand("build-games")!;
  // Check for --help before parsing (parseArgv validates required flags).
  if (argv.includes("--help") || argv.includes("-h")) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }
  const repoRoot = process.cwd();
  const { games, platforms } = parseBuildGamesArgs(argv);
  const groups = groupPlatforms(platforms);
  const ebArgs = buildEbArgs(groups);
  const mobileTargets: string[] = [];
  if (groups.android) mobileTargets.push("android");
  if (groups.ios) mobileTargets.push("ios");

  let fail = 0;

  // --- Desktop builds (electron-vite + electron-builder) ---
  if (ebArgs.length > 0) {
    log.info("build-games", `Desktop target platforms: ${ebArgs.join(" ")}`);
    for (const game of games) {
      const gameDir = resolve(repoRoot, "games", game);
      const { productName, appId } = getGameInfo(gameDir, game);
      log.info("build-games", "");
      log.info("build-games", `Game: ${game} | Product: "${productName}" | AppId: ${appId}`);
      log.info("build-games", `Building ${game} with Vite...`);
      const viteOk = runCommand("npx", ["electron-vite", "build", "--config", `games/${game}/electron.vite.config.ts`], repoRoot, `Vite ${game}`);
      if (!viteOk) { log.error("build-games", `Vite build failed for ${game} — skipping`); fail = 1; continue; }
      log.info("build-games", `Packaging ${game} with electron-builder (${ebArgs.join(" ")})...`);
      const ebOk = runCommand("npx", [
        "electron-builder",
        `-c.productName=${productName}`,
        `-c.appId=${appId}`,
        `-c.extraMetadata.name=${game}`,
        ...ebArgs,
      ], repoRoot, `electron-builder ${game}`);
      if (!ebOk) { log.error("build-games", `electron-builder failed for ${game} — skipping`); fail = 1; continue; }
      log.info("build-games", `${game} done.`);
    }
  }

  // --- Mobile builds (draft mobile → Capacitor + Gradle) ---
  if (mobileTargets.length > 0) {
    log.info("build-games", "");
    log.info("build-games", `Mobile targets: ${mobileTargets.join(" ")}`);
    for (const game of games) {
      for (const target of mobileTargets) {
        log.info("build-games", "");
        log.info("build-games", `Mobile build: ${game} → ${target}`);
        try {
          await mobile(["--game", game, "--target", target]);
        } catch (err) {
          log.error("build-games", `Mobile build failed for ${game} (${target}): ${(err as Error).message}`);
          fail = 1;
        }
        log.info("build-games", `${game} (${target}) done.`);
      }
    }
  }

  // --- Summary ---
  log.info("build-games", "");
  if (fail) log.error("build-games", "One or more games failed — see output above.");
  log.info("build-games", "All selected games processed.");
  if (mobileTargets.length > 0) {
    log.info("build-games", "Android APK: release/<name>-<version>-android.apk");
    log.info("build-games", "iOS: open games/<game>/ios with Xcode");
  }

  openReleaseFolder(repoRoot);

  // Hard exit — Vite/Capacitor/Gradle leave lingering handles that prevent
  // the process from exiting on its own, which hangs the VSCode terminal.
  process.exit(fail);
}
