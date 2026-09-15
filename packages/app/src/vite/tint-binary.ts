// ============================================================================
// tint-binary.ts — Locate (and optionally download) the Tint WGSL validator CLI
// ============================================================================
//
// Tint is Google's WGSL compiler (part of the Dawn project). We use the CLI
// binary to validate WGSL shaders at build/compile time, before they reach
// the renderer. Prebuilt binaries are fetched from eliemichel/dawn-prebuilt.
//
// Override the binary path with the TINT_BIN_PATH env var. Disable validation
// with DOWNDRAFT_SHADER_VALIDATE=0.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

// ── Platform detection ──
function platformTag(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "macos-aarch64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  return null;
}

// ── Binary search ──
const TINT_RELEASE_TAG = "tint/7213";

function downloadUrl(tag: string, platform: string): string {
  const cap = platform.charAt(0).toUpperCase() + platform.slice(1);
  const name = `Tint-7213-${platform}-Release.zip`;
  return `https://github.com/eliemichel/dawn-prebuilt/releases/download/${encodeURIComponent(tag)}/${name}`;
}

/**
 * Resolve the tint binary path. Search order:
 *   1. TINT_BIN_PATH env var
 *   2. packages/platform-native/native/bin/tint (pre-downloaded)
 *   3. System PATH (which tint)
 *   4. Download from eliemichel/dawn-prebuilt (cached in native/bin/)
 *
 * Returns the absolute path to the tint binary, or null if not available.
 */
export function resolveTintBinary(): string | null {
  // 0. Disabled?
  if (process.env.DOWNDRAFT_SHADER_VALIDATE === "0") return null;

  // 1. Explicit env var
  const envPath = process.env.TINT_BIN_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // 2. Pre-downloaded in native/bin/
  const binDir = resolve(_dirname, "..", "..", "..", "platform-native", "native", "bin");
  const localBin = join(binDir, process.platform === "win32" ? "tint.exe" : "tint");
  if (existsSync(localBin)) return localBin;

  // 3. System PATH
  try {
    const which = execSync(
      process.platform === "win32" ? "where tint" : "which tint",
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim().split("\n")[0];
    if (which && existsSync(which)) return which;
  } catch {
    // Not on PATH
  }

  // 4. Attempt download (best-effort, may fail in CI without network)
  const plat = platformTag();
  if (!plat) return null;
  try {
    return downloadTint(binDir, plat);
  } catch {
    return null;
  }
}

function downloadTint(binDir: string, plat: string): string {
  const url = downloadUrl(TINT_RELEASE_TAG, plat);
  const zipPath = join(binDir, "tint-download.zip");
  const extractDir = join(binDir, "tint-extract");

  mkdirSync(binDir, { recursive: true });

  // Download
  execSync(`curl -sL "${url}" -o "${zipPath}"`, { stdio: "ignore" });

  // Extract
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "ignore" });

  // Find the tint binary in the extracted dir
  function findBinary(dir: string): string | null {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const found = findBinary(full);
        if (found) return found;
      } else if (entry === "tint" || entry === "tint.exe") {
        return full;
      }
    }
    return null;
  }

  const found = findBinary(extractDir);
  if (!found) throw new Error("tint binary not found in archive");

  // Move to bin dir
  const dest = join(binDir, process.platform === "win32" ? "tint.exe" : "tint");
  renameSync(found, dest);

  // Cleanup
  try {
    execSync(`rm -rf "${extractDir}" "${zipPath}"`, { stdio: "ignore" });
  } catch {}

  // Make executable (non-Windows)
  if (process.platform !== "win32") {
    execSync(`chmod +x "${dest}"`, { stdio: "ignore" });
  }

  return dest;
}

/**
 * Validate WGSL source using the tint binary. Returns null on success,
 * or an error message string on failure.
 */
export function validateWgslWithTint(
  tintBin: string,
  source: string,
  filePath?: string,
): { ok: boolean; errors: string[]; warnings: string[] } {
  const tmpDir = mkdtempSync(join(tmpdir(), "downdraft-tint-"));
  const tmpFile = join(tmpDir, "shader.wgsl");

  try {
    writeFileSync(tmpFile, source, "utf-8");

    // Run tint to validate the WGSL. Use -f spvasm -o <tempfile> to generate
    // SPIR-V assembly output (we only care about errors/warnings, not the
    // output). Tint exits 0 on success, non-zero on error.
    // Note: -f none and -o /dev/null don't work reliably across tint versions.
    const outFile = join(tmpDir, "out.spvasm");

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      stdout = execSync(`"${tintBin}" -f spvasm "${tmpFile}" -o "${outFile}"`, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch (e: any) {
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      exitCode = e.status ?? 1;
    }

    const output = (stdout + stderr).trim();
    if (exitCode === 0 && !output) {
      return { ok: true, errors: [], warnings: [] };
    }

    // Parse tint output: lines like "file.wgsl:2:1 error: message"
    const errors: string[] = [];
    const warnings: string[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Tint prefixes errors with the filename:line:col
      const label = filePath ? filePath : "shader.wgsl";
      const cleanLine = trimmed.replace(tmpFile, label);
      if (cleanLine.includes("error:") || exitCode !== 0) {
        errors.push(cleanLine);
      } else if (cleanLine.includes("warning:")) {
        warnings.push(cleanLine);
      }
    }

    return {
      ok: errors.length === 0 && exitCode === 0,
      errors,
      warnings,
    };
  } finally {
    try {
      unlinkSync(tmpFile);
      execSync(`rmdir "${tmpDir}" 2>/dev/null || true`, { stdio: "ignore" });
    } catch {}
  }
}
