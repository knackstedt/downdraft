// ============================================================================
// Plugin scaffold — generates a new plugin directory from a template.
//
// Usage: `dd plugin new <name> --format <format> --game <game> [options]`
//
// Generates:
//   - plugin.json (manifest)
//   - package.json
//   - src/index.ts (for worker-js/quickjs) or src/index.js (for quickjs)
//   - README.md
// ============================================================================

import type { PluginFormat, PluginThread, PluginTier } from "@downdraft/core";
import { createLogger } from "@downdraft/core";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const log = createLogger();

export interface PluginScaffoldOptions {
  /** Plugin id (kebab-case, e.g. "my-cool-plugin"). */
  id: string;
  /** Display name. */
  name: string;
  /** Plugin format. */
  format: PluginFormat;
  /** Target game appId (e.g. "downdraft-overburden"). */
  game: string;
  /** Plugin version. */
  version: string;
  /** Author. */
  author?: string;
  /** Description. */
  description?: string;
  /** Target directory (the plugin will be created as a subdirectory). */
  targetDir: string;
  /** Overwrite if directory exists. */
  force: boolean;
}

const FORMAT_DEFAULTS: Record<PluginFormat, { tier: PluginTier; thread: PluginThread; permissions: string[] }> = {
  "worker-js": { tier: "native", thread: "own-worker", permissions: ["ecs", "events", "state", "tick", "log"] },
  quickjs: { tier: "script", thread: "renderer", permissions: ["events", "state", "tick", "log"] },
  wasm: { tier: "native", thread: "own-worker", permissions: ["events", "state", "log"] },
  asset: { tier: "data", thread: "renderer", permissions: [] },
};

export async function scaffoldPlugin(opts: PluginScaffoldOptions): Promise<void> {
  const defaults = FORMAT_DEFAULTS[opts.format];
  const pluginDir = join(resolve(opts.targetDir), opts.id);

  if (existsSync(pluginDir) && !opts.force) {
    log.error("plugin", `Directory "${pluginDir}" already exists. Use --force to override.`);
    process.exit(1);
  }

  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(join(pluginDir, "src"), { recursive: true });

  // ── plugin.json ──
  const manifest: Record<string, unknown> = {
    id: opts.id,
    name: opts.name,
    version: opts.version,
    author: opts.author ?? "",
    description: opts.description ?? "",
    engineVersion: "^0.1.0",
    game: opts.game,
    format: opts.format,
    tier: defaults.tier,
    thread: defaults.thread,
    permissions: defaults.permissions,
    provides: [],
    requires: [],
    dependencies: [],
  };

  if (opts.format !== "asset") {
    manifest.entry = opts.format === "quickjs" ? "./src/index.js" : "./src/index.ts";
  } else {
    manifest.assets = { files: {}, textures: [], audio: [], meshes: [], data: [] };
  }

  if (opts.format === "quickjs") {
    manifest.quickjs = { instructionBudget: 500000 };
  }

  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  // ── package.json ──
  const pkgName = `@${opts.game.replace(/^downdraft-/, "")}/plugin-${opts.id}`;
  const pkg = {
    name: pkgName,
    version: opts.version,
    description: opts.description ?? `${opts.name} plugin`,
    author: opts.author ?? "",
    private: true,
    type: "module",
    dependencies: { "@downdraft/core": "workspace:*" },
  };
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // ── Entry file ──
  if (opts.format === "worker-js") {
    writeFileSync(join(pluginDir, "src/index.ts"), WORKER_JS_TEMPLATE(opts));
  } else if (opts.format === "quickjs") {
    writeFileSync(join(pluginDir, "src/index.js"), QUICKJS_TEMPLATE(opts));
  } else if (opts.format === "wasm") {
    writeFileSync(join(pluginDir, "src/plugin.wat"), WAT_TEMPLATE(opts));
  } else if (opts.format === "asset") {
    mkdirSync(join(pluginDir, "assets"), { recursive: true });
    writeFileSync(join(pluginDir, "assets/README.md"), "# Assets\nPlace your plugin assets here.\n");
  }

  // ── README.md ──
  writeFileSync(join(pluginDir, "README.md"), README_TEMPLATE(opts));

  log.info("plugin", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Plugin Scaffold     ║
  ╚══════════════════════════════════════════╝
  `);
  log.info("plugin", `  Plugin:    ${opts.id}`);
  log.info("plugin", `  Format:    ${opts.format}`);
  log.info("plugin", `  Tier:      ${defaults.tier}`);
  log.info("plugin", `  Thread:    ${defaults.thread}`);
  log.info("plugin", `  Game:      ${opts.game}`);
  log.info("plugin", `  Target:    ${pluginDir}`);
  log.info("plugin", "");
  log.info("plugin", `Next steps:`);
  log.info("plugin", `  1. Edit plugin.json to declare provides/requires/permissions`);
  log.info("plugin", `  2. Implement the plugin entry in src/`);
  log.info("plugin", `  3. Add the plugin to your game's GameModule.plugins config`);
}

function WORKER_JS_TEMPLATE(opts: PluginScaffoldOptions): string {
  return `import type { NativePluginContext, PluginEntry } from "@downdraft/core";

const plugin: PluginEntry<NativePluginContext> = {
  register(ctx: NativePluginContext) {
    ctx.log.info("${opts.id} plugin registered.");
    ctx.onDispose(() => {
      ctx.log.debug("${opts.id} plugin unloading.");
    });
  },
};

export default plugin;
`;
}

function QUICKJS_TEMPLATE(opts: PluginScaffoldOptions): string {
  return `function register(dd) {
  dd.log.info("${opts.id} plugin registered.");

  dd.onDispose(function() {
    dd.log.debug("${opts.id} plugin unloading.");
  });
}
`;
}

function WAT_TEMPLATE(opts: PluginScaffoldOptions): string {
  return `;; ${opts.id} — WASM plugin (ABI v2)
(module
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))

  (func (export "alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap))
    (global.set $heap (i32.add (global.get $heap) (local.get $size)))
    (local.get $ptr)
  )

  (func (export "register")
    ;; Initialize plugin state
  )

  (func (export "tick") (param $dt f32) (param $elapsed f32)
    ;; Per-tick logic
  )

  (func (export "dispose")
    ;; Cleanup
  )

  (func (export "on_event") (param $sub_id i32) (param $data_ptr i32) (param $data_len i32)
    ;; Handle events
  )
)
`;
}

function README_TEMPLATE(opts: PluginScaffoldOptions): string {
  return `# ${opts.name}

${opts.description ?? "A user-authored plugin for the Downdraft Engine."}

- **Format:** \`${opts.format}\`
- **Tier:** \`${FORMAT_DEFAULTS[opts.format].tier}\`
- **Thread:** \`${FORMAT_DEFAULTS[opts.format].thread}\`
- **Game:** \`${opts.game}\`

## Getting started

1. Edit \`plugin.json\` to declare your \`provides\`, \`requires\`, and \`permissions\`.
2. Implement the plugin entry in \`src/\`.
3. Add the plugin to your game's \`GameModule.plugins\` config.

## Built with

Generated by \`dd plugin new\` — the Downdraft Engine CLI plugin scaffold.
`;
}
