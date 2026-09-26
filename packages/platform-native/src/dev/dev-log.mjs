// ============================================================================
// dev-log.mjs — plain-ESM mirror of the engine logger's line format
// (packages/engine/core/src/util/logger.ts → ConsoleLogger.write).
//
// dev-shell.mjs stays TypeScript-free so bun/node/deno can all host it, which
// means it can't import the real logger — this module reproduces the exact
// output shape so supervisor/HMR lines are indistinguishable from engine logs:
//
//   HH:MM:SS LEVEL [module] message
//
// If ConsoleLogger's layout changes, mirror the change here.
// ============================================================================

import { execSync } from "node:child_process";
import { inspect } from "node:util";

const proc = globalThis.process ?? { env: {}, platform: "", stdout: undefined, stderr: undefined };

const BROKEN_PIPE_CODES = new Set(["EPIPE", "ECONNRESET", "EBADF", "EIO"]);

function isBrokenPipeError(err) {
  if (!err || typeof err !== "object") return false;
  if ("code" in err && BROKEN_PIPE_CODES.has(err.code)) return true;
  if (err instanceof Error && err.message.includes("write EPIPE")) return true;
  return false;
}

if (proc?.stdout?.on) proc.stdout.on("error", (e) => { if (!isBrokenPipeError(e)) throw e; });
if (proc?.stderr?.on) proc.stderr.on("error", (e) => { if (!isBrokenPipeError(e)) throw e; });

// ── Palette — same values as THEMES in logger.ts ────────────────────────────

const THEMES = {
  dark: {
    trace: "\x1b[38;2;69;197;139m",
    debug: "\x1b[38;2;82;148;226m",
    info: "\x1b[38;2;28;198;106m",
    warn: "\x1b[38;2;242;148;76m",
    error: "\x1b[38;2;255;110;110m",
    fatal: "\x1b[38;2;255;20;20m",
    module: "\x1b[38;2;82;148;226m",
    gray: "\x1b[38;2;128;128;128m",
    time: "\x1b[38;2;69;197;139m",
  },
  light: {
    trace: "\x1b[38;2;12;157;118m",
    debug: "\x1b[38;2;2;122;232m",
    info: "\x1b[38;2;12;157;118m",
    warn: "\x1b[38;2;201;111;5m",
    error: "\x1b[38;2;200;80;80m",
    fatal: "\x1b[38;2;255;20;20m",
    module: "\x1b[38;2;2;122;232m",
    gray: "\x1b[38;2;100;100;100m",
    time: "\x1b[38;2;12;157;118m",
  },
};

const reset = "\x1b[0m";
const bold = "\x1b[1m";

// ── Theme detection — same signals as logger.ts getTheme() ──────────────────

function tryExecSync(cmd, opts) {
  try { return execSync(cmd, opts).toString(); } catch { return null; }
}

let _theme;
function getTheme() {
  if (_theme) return _theme;

  const colorfgbg = proc.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    if (parts.length > 1) {
      const bg = parseInt(parts[parts.length - 1]);
      if (bg >= 0 && bg <= 7) return (_theme = "dark");
      if (bg >= 8 && bg <= 15) return (_theme = "light");
    }
  }

  if (proc.platform !== "win32" && proc.stdout?.isTTY) {
    try {
      const probe = `
                if [ -t 0 ]; then
                    stty -echo
                    printf "\\033]11;?\\007"
                    read -d $'\\a' -s -t 0.1 response
                    stty echo
                    echo $response
                fi
            `;
      const response = tryExecSync(probe, {
        shell: "/bin/bash",
        stdio: ["inherit", "pipe", "ignore"],
      });
      if (response && response.includes("rgb:")) {
        const match = response.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
        if (match) {
          const r = parseInt(match[1], 16);
          const g = parseInt(match[2], 16);
          const b = parseInt(match[3], 16);
          const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / (Math.pow(16, match[1].length) - 1);
          return (_theme = brightness > 0.5 ? "light" : "dark");
        }
      }
    } catch { /* OSC 11 failed, continue to fallbacks */ }
  }

  if (proc.platform === "darwin") {
    try {
      const style = tryExecSync("defaults read -g AppleInterfaceStyle", { stdio: ["ignore", "pipe", "ignore"] });
      if (style !== null && style.trim() === "Dark") return (_theme = "dark");
    } catch {
      return (_theme = "light");
    }
  } else if (proc.platform === "linux") {
    try {
      const style = tryExecSync("gsettings get org.gnome.desktop.interface color-scheme", { stdio: ["ignore", "pipe", "ignore"] });
      if (style !== null) {
        const trimmed = style.trim().replace(/'/g, "");
        if (trimmed === "prefer-dark" || trimmed.includes("dark")) return (_theme = "dark");
        if (trimmed === "prefer-light" || trimmed.includes("light")) return (_theme = "light");
      }
    } catch { }

    try {
      const style = tryExecSync(
        "dbus-send --session --print-reply=literal --dest=org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings.Read string:'org.freedesktop.appearance' string:'color-scheme'",
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      if (style && style.includes("uint32 1")) return (_theme = "dark");
      if (style && style.includes("uint32 2")) return (_theme = "light");
    } catch { }
  }

  return (_theme = "dark");
}

// ── Level gate — same defaults as createLogger() ────────────────────────────

const LEVEL_INT = { trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6 };
const GATE = LEVEL_INT[proc.env.EMBER_LOG_LEVEL] ?? LEVEL_INT[proc.env.NODE_ENV === "test" ? "warn" : "info"];

/**
 * Write one formatted line — same layout as ConsoleLogger.write, minus the
 * syntax-highlight/linkify passes (supervisor messages are plain text).
 * Everything goes to stdout, mirroring the logger (stderr only under
 * DOWNDRAFT_MCP so MCP stdio stays clean).
 */
export function writeLine(level, module, msg) {
  if ((LEVEL_INT[level] ?? 3) < GATE) return;
  const palette = THEMES[getTheme()];
  const clean = String(msg).replace(/\n+$/, "");
  const ts = new Date().toTimeString().slice(0, 8);
  const line = `${palette.time}${ts} ${palette[level] ?? palette.info}${bold}${level.toUpperCase()}${reset} ${palette.gray}[${palette.module}${module}${palette.gray}] ${reset}${clean}\n`;
  const stream = proc.env.DOWNDRAFT_MCP === "1" ? proc.stderr : proc.stdout;
  try {
    stream.write(line);
  } catch (e) {
    if (!isBrokenPipeError(e)) throw e;
  }
}

// ── Console bridge ──────────────────────────────────────────────────────────
// The vite ModuleRunner evaluates modules in this same process (shared
// globalThis), so vite's client code — and any stray console.* in game/engine
// code — lands on our stdout unformatted. Route every console method through
// writeLine: a leading "[tag]" prefix becomes the module name (matching how
// log.info(module, msg) renders), and lines already in engine format pass
// through untouched.

const CONSOLE_LEVEL = {
  log: "info", info: "info", warn: "warn", error: "error",
  debug: "debug", trace: "trace", dir: "info", group: "info", groupEnd: "info",
};

const FORMATTED_LINE = /^\d{2}:\d{2}:\d{2} (TRACE|DEBUG|INFO|WARN|ERROR|FATAL) /;
const TAG_PREFIX = /^\[([^\]\s]+)\]\s*/;

function stringifyArg(a) {
  if (a instanceof Error) return a.stack ?? String(a);
  if (typeof a === "object" && a !== null) {
    try { return inspect(a, { depth: 3, breakLength: Infinity }); }
    catch { return String(a); }
  }
  return String(a);
}

/** Patch globalThis.console so raw console.* output renders in logger format.
 *  Returns a restore function. */
export function installConsoleBridge() {
  const originals = {};
  for (const [method, level] of Object.entries(CONSOLE_LEVEL)) {
    originals[method] = console[method]?.bind(console);
    if (!originals[method]) continue;
    console[method] = (...args) => {
      const msg = args.map(stringifyArg).join(" ");
      if (FORMATTED_LINE.test(msg)) { originals[method](msg); return; }
      const m = msg.match(TAG_PREFIX);
      writeLine(level, m ? m[1] : "console", m ? msg.slice(m[0].length) : msg);
    };
  }
  return () => {
    for (const [method, fn] of Object.entries(originals)) {
      if (fn) console[method] = fn;
    }
  };
}
