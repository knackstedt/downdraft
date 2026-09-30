// ============================================================================
// usage.ts — per-command usage strings + schema registry
// ============================================================================
//
// Single source of truth for every `draft` subcommand's synopsis, flags, and
// positionals. `index.ts` generates the top-level help from this registry;
// each command module imports its schema + usage string for `--help` output.
//

import type { CommandSchema } from "./args";

export interface CommandEntry {
  /** Command name as typed on the CLI (e.g. `"new"`). */
  name: string;
  /** One-line synopsis shown after `Usage:`. */
  usage: string;
  /** Short description for the top-level command list. */
  summary: string;
  /** Argument schema (flags + positionals). */
  schema: CommandSchema;
}

// ---------------------------------------------------------------------------
// Desktop target vocabulary (normalized): win | linux | mac | all
// Mobile target vocabulary: android | ios | all
// ---------------------------------------------------------------------------

const DESKTOP_TARGETS = ["win", "linux", "mac", "all"] as const;
const BUILD_TARGETS = ["current", "win", "linux", "mac"] as const;
const RELEASE_TARGETS = ["win", "linux", "mac", "all"] as const;
const RELEASE_STAGES = ["build", "package", "release"] as const;
const RENDERER_TARGETS = ["gpu", "cpu"] as const;
const BUILD_MODES = ["dev", "debug", "prod"] as const;

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const COMMANDS: CommandEntry[] = [
  {
    name: "release",
    usage: "draft release [options]",
    summary: "Native build + package pipeline — compiles the game to a standalone binary via scripts/package-native.mjs",
    schema: {
      flags: [
        { name: "game", alias: "g", type: "string", description: "Game to release (games/<game>). For multiple games, use --games. If omitted, infers from the current directory, or defaults to the only game in games/." },
        { name: "games", type: "string", description: "Comma-separated game names (e.g. sandjongg,to-the-ocean)" },
        { name: "target", alias: "t", type: "string", default: "all", enum: [...RELEASE_TARGETS], description: "Target platform(s): win, linux, mac, or all" },
        { name: "format", type: "string", description: "Deprecated no-op — native packaging produces a single binary + staged tree" },
        { name: "stage", type: "string", default: "release", enum: [...RELEASE_STAGES], description: "Stage: build, package, or release (all compile the native binary)" },
        { name: "mode", type: "string", default: "prod", enum: [...BUILD_MODES], description: "Build mode" },
        { name: "out", type: "string", default: "release", description: "Artifact output directory" },
        { name: "skip-build", type: "boolean", description: "Alias for --stage=package" },
        { name: "build-only", type: "boolean", description: "Alias for --stage=build" },
        { name: "mcp", type: "boolean", description: "Retain the MCP automation endpoint in the packaged binary" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "new",
    usage: "draft new [path] [options]",
    summary: "Scaffold a new game project",
    schema: {
      positionals: [{ name: "path", description: "Target directory (default: current dir)" }],
      flags: [
        { name: "template", type: "string", default: "minimal", description: "Project template (minimal | physics | full | gamemodule)" },
        { name: "name", type: "string", description: "Project name (defaults to directory basename)" },
        { name: "description", type: "string", description: "Project description" },
        { name: "author", type: "string", description: "Author name (written as { name } in package.json)" },
        { name: "version", type: "string", default: "0.1.0", description: "Initial version" },
        { name: "ai-companion", type: "boolean", description: "Scaffold .devin/ config + engine-prompt.md" },
        { name: "force", type: "boolean", description: "Scaffold into a non-empty directory" },
        { name: "list-templates", type: "boolean", description: "List available templates and exit" },
      ],
    },
  },
  {
    name: "dev",
    usage: "draft dev [options]",
    summary: "Start the game on the native runtime (Bun + winit + wgpu). Run from a game directory (cwd inference).",
    schema: {
      flags: [
        { name: "entry", type: "string", description: "Game entrypoint file (defaults to src/native-entry.ts)" },
        { name: "port", type: "number", description: "MCP HTTP port (default: auto-assign)" },
        { name: "runtime", type: "string", enum: ["bun", "node", "deno"], description: "JS runtime hosting the dev shell (default: bun → node → deno auto-detect)" },
        { name: "watch", type: "boolean", description: "Back-compat no-op — the HMR dev shell always watches" },
        { name: "no-hmr", type: "boolean", description: "Disable HMR — spawn the entry directly (bun run), no dev shell" },
        { name: "native", type: "boolean", description: "Back-compat alias — native is the default runtime" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "debug",
    usage: "draft debug [path] [options]",
    summary: "Run the engine in debug mode with profiling/visualization",
    schema: {
      positionals: [{ name: "path", description: "Project path (default: current dir)" }],
      flags: [
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
        { name: "no-devtools", type: "boolean", description: "Disable the devtools overlay (sets DOWNDRAFT_DISABLE_DEVTOOLS=1)" },
        { name: "inspector", type: "boolean", description: "Enable the Node inspector (chrome://inspect)" },
      ],
    },
  },
  {
    name: "build",
    usage: "draft build [path] [options]",
    summary: "Build a game for a target platform",
    schema: {
      positionals: [{ name: "path", description: "Project path (default: current dir)" }],
      flags: [
        { name: "game", alias: "g", type: "string", description: "Game to build (resolves games/<game>; overrides path)" },
        { name: "target", type: "string", default: "current", enum: [...BUILD_TARGETS], description: "Target platform" },
        { name: "mode", type: "string", default: "prod", enum: [...BUILD_MODES], description: "Build mode" },
        { name: "out", type: "string", default: "dist", description: "Output directory" },
        { name: "no-minify", type: "boolean", description: "Disable minification" },
        { name: "sourcemap", type: "boolean", description: "Generate source maps (on by default in non-prod modes)" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "build-games",
    usage: "draft build-games --games=<csv> --platforms=<csv>",
    summary: "Deprecated alias for `draft release --games=<csv>` (VSCode task)",
    schema: {
      flags: [
        { name: "games", type: "string", required: true, description: "Comma-separated game directory names (e.g. sandjongg)" },
        { name: "platforms", type: "string", required: true, description: "Comma-separated desktop targets (win | linux | mac; legacy :format suffixes are ignored)" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "dist",
    usage: "draft dist [options]",
    summary: "Package a game for distribution (deprecated alias for `draft release`)",
    schema: {
      flags: [
        { name: "game", alias: "g", type: "string", required: true, description: "Game to package (games/<game>)" },
        { name: "target", alias: "t", type: "string", default: "all", enum: [...DESKTOP_TARGETS], description: "Target platform" },
        { name: "config", alias: "c", type: "string", description: "Explicit path to a build.config.ts / config file" },
        { name: "project-dir", type: "string", description: "Override the project directory (default: repo root)" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "export",
    usage: "draft export [path] [options]",
    summary: "Package a built game for distribution (per-platform launchers)",
    schema: {
      positionals: [{ name: "path", description: "Project path (default: current dir)" }],
      flags: [
        { name: "target", type: "string", default: "all", enum: [...DESKTOP_TARGETS], description: "Target platform" },
        { name: "out", type: "string", default: "export", description: "Output directory" },
        { name: "no-compress", type: "boolean", description: "Disable compression" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "assets",
    usage: "draft assets <command> [project] [options]",
    summary: "Manage remote asset packs (pull, push, list, init, add, add-store)",
    schema: {
      positionals: [
        { name: "command", required: true, description: "init | add-store | add | pull | push | list" },
        { name: "project", description: "Project path (default: current dir)" },
      ],
      flags: [
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "mcp",
    usage: "draft mcp <action> [args] [options]",
    summary: "Call MCP automation tools on a running game (instances | tools | call | screenshot | stdio | run)",
    schema: {
      positionals: [
        { name: "action", required: true, description: "instances | tools | call | screenshot | stdio | run" },
        { name: "args", variadic: true, description: "Action args: <tool> [json] | <file.png> | <script> [script-args]" },
      ],
      flags: [
        { name: "app", type: "string", description: "Select instance by appId" },
        { name: "pid", type: "number", description: "Select instance by PID" },
        { name: "url", type: "string", description: "Explicit MCP HTTP URL (skips PID-file discovery)" },
        { name: "token", type: "string", description: "Bearer token (auto-read from <pid>.token otherwise)" },
        { name: "json", type: "boolean", description: "Print the raw result envelope (image data elided to {bytes} unless --out)" },
        { name: "out", type: "string", description: "Write image/binary result blocks to file(s)" },
        { name: "max-bytes", type: "number", description: "Cap printed output in bytes (default 262144)" },
        { name: "schema", type: "string", description: "tools action: print one tool's inputSchema JSON" },
        { name: "game", alias: "g", type: "string", description: "run action: game name (games/<name>)" },
        { name: "entry", type: "string", description: "run action: explicit native entry file" },
        { name: "headed", type: "boolean", description: "run action: show the game window" },
        { name: "gpu", type: "string", enum: ["auto", "hardware", "swiftshader"], description: "run action: WebGPU backend (default: swiftshader)" },
        { name: "deterministic", type: "boolean", description: "run action: DOWNDRAFT_DETERMINISTIC=1 (fixed seed, paused render loop)" },
        { name: "port", alias: "p", type: "number", description: "run action: pin the MCP port (default: auto)" },
        { name: "timeout", type: "number", description: "Per-request timeout ms; readiness budget for run" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
  {
    name: "test",
    usage: "draft test [options]",
    summary: "Run e2e tests via bun:test (SwiftShader + deterministic by default; default specs use the in-game MCP RPC harness)",
    schema: {
      flags: [
        { name: "game", alias: "g", type: "string", required: true, description: "Game to test (games/<game>)" },
        { name: "spec", alias: "s", type: "string", description: "Spec file to run (default: tests/e2e/<game>-smoke.spec.ts)" },
        { name: "port", alias: "p", type: "number", default: 0, description: "MCP port (0 = auto-assign a free port)" },
        { name: "renderer", alias: "r", type: "string", default: "cpu", enum: [...RENDERER_TARGETS], description: "WebGPU backend: cpu=SwiftShader, gpu=hardware" },
        { name: "no-deterministic", type: "boolean", description: "Disable fixed seed / render loop pause" },
        { name: "headed", type: "boolean", description: "Show the window instead of running headless" },
        { name: "verbose", alias: "v", type: "boolean", description: "Verbose logging" },
      ],
    },
  },
];

/** Look up a command entry by name. */
export function getCommand(name: string): CommandEntry | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Render the top-level `draft` help string from the registry. */
export function renderTopLevelHelp(version: string): string {
  const lines: string[] = [];
  lines.push(`DownDraft Engine CLI v${version}`);
  lines.push("");
  lines.push("Usage: draft <command> [options]");
  lines.push("");
  lines.push("Commands:");
  const maxName = Math.max(...COMMANDS.map((c) => c.name.length));
  COMMANDS.forEach((c) => {
    lines.push(`  ${c.name.padEnd(maxName + 2)} ${c.summary}`);
  });
  lines.push("");
  lines.push("Global options:");
  lines.push("  -h, --help     Show help for a command (draft <cmd> --help)");
  lines.push("  -V, --version  Print the CLI version and exit");
  lines.push("");
  lines.push("Run `draft help <command>` for command-specific details.");
  return lines.join("\n");
}
