// ============================================================================
// createDowndraftBuilderConfig() — electron-builder config factory for games
// ============================================================================
//
// Each game's `build.config.ts` calls this factory to get a fully wired
// electron-builder Configuration with:
//   - Per-game Windows VS_VERSIONINFO fields (ProductName, FileDescription,
//     LegalCopyright, CompanyName, FileVersion) derived from game metadata.
//   - Shared Linux / deb / rpm / flatpak boilerplate (no duplication).
//   - An `afterAllArtifactBuild` hook that patches the PE COFF
//     `TimeDateStamp` of every produced .exe so VirusTotal reports the
//     actual build date instead of Electron's stale prebuilt-binary
//     timestamp (e.g. 2018-12-15).
//
// electron-builder's WinPackager.signAndEditResources() already maps these
// Configuration / metadata fields to rcedit version-string arguments:
//   FileDescription  ← metadata.description (|| productName)
//   ProductName      ← config.productName (|| metadata.productName || name)
//   LegalCopyright   ← config.copyright (|| default "Copyright © <year> <author>")
//   CompanyName      ← metadata.author.name
//   FileVersion      ← metadata.shortVersion (|| buildVersion)
//   ProductVersion   ← metadata.shortVersionWindows (|| getVersionInWeirdWindowsForm)
//   InternalName     ← exe basename (electron-builder default)
//
// So we only need to set: appId, productName, copyright (top-level config),
// and version / description / author (via extraMetadata, which is deep-merged
// into the package.json metadata that AppInfo reads from).

import type { BuildResult, Configuration } from "electron-builder";
import { execSync } from "node:child_process";
import { patchPeTimestamps } from "./pe-timestamp";

export interface DowndraftBuilderOptions {
  /** Reverse-DNS app identifier (e.g. "downdraft-to-the-ocean"). */
  appId: string;
  /** Human-readable product name (e.g. "To The Ocean"). */
  productName: string;
  /** Semver version string (e.g. "0.1.0"). Injected via extraMetadata. */
  version: string;
  /** One-line description → Windows FileDescription. */
  description?: string;
  /** Author / company name → Windows CompanyName. */
  author?: string;
  /** Explicit copyright line → Windows LegalCopyright.
   *  Defaults to `Copyright © <year> <author | productName>`. */
  copyright?: string;
  /** Optional shortVersion override (Windows FileVersion).
   *  Defaults to `version`. */
  shortVersion?: string;
  /** Optional overrides for the shared file set / output dir. */
  files?: string[];
  outputDir?: string;
  /** Optional per-platform overrides merged on top of the shared boilerplate. */
  win?: Partial<NonNullable<Configuration["win"]>>;
  linux?: Partial<NonNullable<Configuration["linux"]>>;
  /** When true (default), wire the PE timestamp patcher into
   *  afterAllArtifactBuild. Set to false to disable (e.g. for signed
   *  builds where the timestamp must be patched before signing, not after). */
  patchPeTimestamp?: boolean;
}

/**
 * Resolve the unix timestamp (seconds) to stamp into produced PE files.
 *
 * Precedence:
 *   1. `SOURCE_DATE_EPOCH` env var (reproducible builds) — if set & valid.
 *   2. HEAD git commit date (`git log -1 --format=%ct`) — deterministic
 *      per commit, so the same source always produces the same timestamp.
 *   3. `Date.now() / 1000` — wall-clock fallback when git is unavailable.
 */
export function resolveBuildTimestamp(): number {
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env != null && env !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  // Try git HEAD commit date. Use execSync for a deterministic result.
  try {
    const out = execSync("git log -1 --format=%ct", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ts = Number(out);
    if (Number.isFinite(ts) && ts > 0) return Math.floor(ts);
  } catch {
    // git not available or not a git repo — fall through.
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a per-game electron-builder Configuration with correct Windows
 * version-info branding and PE timestamp patching.
 */
export function createDowndraftBuilderConfig(
  opts: DowndraftBuilderOptions,
): Configuration {
  const year = new Date().getFullYear();
  const copyright =
    opts.copyright ??
    `Copyright © ${year} ${opts.author ?? opts.productName}`;

  // extraMetadata is deep-merged into the package.json metadata that
  // electron-builder's AppInfo reads from. Setting version/description/
  // author here means the game's package.json doesn't need to carry them
  // (though it's good practice to keep them in sync).
  const extraMetadata: Record<string, unknown> = {
    version: opts.version,
  };
  if (opts.description) extraMetadata.description = opts.description;
  if (opts.author) extraMetadata.author = { name: opts.author };
  if (opts.shortVersion) extraMetadata.shortVersion = opts.shortVersion;

  const config: Configuration = {
    appId: opts.appId,
    productName: opts.productName,
    copyright,
    directories: { output: opts.outputDir ?? "release" },
    files: opts.files ?? ["dist/**/*", "resources/**/*"],
    extraMetadata,
    win: {
      target: ["portable"],
      artifactName: "${productName}-${version}-${arch}-portable.exe",
      ...(opts.win ?? {}),
    },
    linux: {
      target: ["AppImage", "deb", "rpm", "flatpak"],
      category: "Game",
      artifactName: "${productName}-${version}-${arch}.${ext}",
      ...(opts.linux ?? {}),
    },
    deb: {
      depends: [
        "libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libxss1",
        "libxtst6",
        "xdg-utils",
        "libatspi2.0-0",
        "libuuid1",
        "libsecret-1-0",
      ],
    },
    rpm: {
      depends: [
        "gtk3",
        "libnotify",
        "nss",
        "libXScrnSaver",
        "libXtst",
        "xdg-utils",
        "at-spi2-atk",
        "libuuid",
        "libsecret",
      ],
    },
    flatpak: {
      base: "org.electronjs.Electron2.BaseApp",
      baseVersion: "23.08",
      finishArgs: [
        "--socket=x11",
        "--socket=wayland",
        "--share=ipc",
        "--share=network",
        "--device=dri",
        "--filesystem=home",
      ],
    },
    ...(opts.patchPeTimestamp ?? true
      ? {
          afterAllArtifactBuild: async (buildResult: BuildResult): Promise<string[]> => {
            const ts = resolveBuildTimestamp();
            const exes = buildResult.artifactPaths.filter((p) => p.endsWith(".exe"));
            if (exes.length === 0) return [];
            const results = await patchPeTimestamps(exes, ts);
            for (const r of results) {
              console.log(
                `[downdraft] Patched PE TimeDateStamp for ${r.file}: ` +
                  `${r.previous} → ${r.next}`,
              );
            }
            return [];
          },
        }
      : {}),
  };

  return config;
}
