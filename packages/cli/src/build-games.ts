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

import { createLogger } from "@downdraft/engine";
import { ArgError, parseArgs as parseArgv, print, renderHelp } from "./args";
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

export async function buildGames(argv: string[]): Promise<void> {
  const entry = getCommand("build-games")!;
  // Check for --help before parsing (parseArgv validates required flags).
  if (argv.includes("--help") || argv.includes("-h")) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  log.warn("build-games", "`draft build-games` is deprecated — use `draft release --games=<csv> --target=<csv>` instead.");
  log.warn("build-games", "Delegating to `release`...");

  const { games, platforms } = parseBuildGamesArgs(argv);
  const groups = groupPlatforms(platforms);

  // Build the release target string from the platform groups.
  const targets: string[] = [];
  if (groups.win.length || groups.linux.length || groups.mac.length) {
    const desktop: string[] = [];
    if (groups.win.length) desktop.push("win");
    if (groups.linux.length) desktop.push("linux");
    if (groups.mac.length) desktop.push("mac");
    targets.push(...desktop);
  }
  if (groups.android) targets.push("android");
  if (groups.ios) targets.push("ios");

  // Build the release format string from the platform sub-targets.
  const formats: string[] = [];
  for (const t of groups.win) if (t) formats.push(`win:${t}`);
  for (const t of groups.linux) if (t) formats.push(`linux:${t}`);
  for (const t of groups.mac) if (t) formats.push(`mac:${t}`);

  const releaseArgs: string[] = [
    `--games=${games.join(",")}`,
    `--target=${targets.join(",")}`,
  ];
  if (formats.length > 0) releaseArgs.push(`--format=${formats.join(",")}`);
  if (argv.includes("--verbose") || argv.includes("-v")) releaseArgs.push("--verbose");

  const { release } = await import("./release");
  await release(releaseArgs);
}
