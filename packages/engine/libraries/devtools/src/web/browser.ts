// ============================================================================
// browser.ts — launches the devtools UI in a desktop browser.
//
// Priority: chromium-family with --app mode (chromeless window) first, then
// anything else we can find. Falls back to the OS default opener.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { spawn } from "node:child_process";

const log = createLogger("info");

interface BrowserCandidate {
  names: string[];
  /** App-window flag supported by chromium forks. */
  appMode: boolean;
}

const CANDIDATES: BrowserCandidate[] = [
  { names: ["chromium", "chromium-browser"], appMode: true },
  { names: ["brave-browser", "brave"], appMode: true },
  { names: ["vivaldi", "vivaldi-stable"], appMode: true },
  { names: ["firefox"], appMode: false },
  { names: ["google-chrome", "google-chrome-stable"], appMode: true },
  { names: ["microsoft-edge", "msedge"], appMode: true },
];

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? "").split(":");
  for (let i = 0; i < dirs.length; i++) {
    const p = `${dirs[i]}/${bin}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { accessSync, constants } = require("node:fs") as typeof import("node:fs");
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* next dir */ }
  }
  return null;
}

let resolved: { bin: string; appMode: boolean } | null | undefined;

function resolveBrowser(): { bin: string; appMode: boolean } | null {
  if (resolved !== undefined) return resolved;
  const override = process.env.DOWNDRAFT_DEVTOOLS_BROWSER;
  if (override) {
    resolved = { bin: which(override) ?? override, appMode: override.includes("chrom") };
    return resolved;
  }
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    for (let j = 0; j < c.names.length; j++) {
      const bin = which(c.names[j]);
      if (bin) {
        resolved = { bin, appMode: c.appMode };
        return resolved;
      }
    }
  }
  resolved = null;
  return null;
}

/**
 * Open `url` in the best available browser. Returns true if a process was
 * spawned; false when no browser was found (caller should log the URL).
 */
export function openDevToolsUrl(url: string): boolean {
  const b = resolveBrowser();
  if (b) {
    const args = b.appMode
      ? [`--app=${url}`, "--disable-session-crashed-bubble", "--no-first-run"]
      : [url];
    try {
      const child = spawn(b.bin, args, {
        detached: true, stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      child.on("error", (err) => {
        log.warn("devtools-browser", `failed to launch ${b.bin}: ${err}`);
      });
      log.info("devtools-browser", `opened ${b.bin}`);
      return true;
    } catch (err) {
      log.warn("devtools-browser", `spawn failed for ${b.bin}: ${err}`);
    }
  }
  // OS default opener fallback.
  const openers = ["xdg-open", "open"];
  for (let i = 0; i < openers.length; i++) {
    const bin = which(openers[i]);
    if (!bin) continue;
    try {
      const child = spawn(bin, [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch { /* try next */ }
  }
  return false;
}
