// ============================================================================
// Plugin scaffold — generates a new plugin directory from a template.
//
// Usage: `dd plugin new <name> --format <format> --game <game> [options]`
//        `dd mod new <name> --game <game> [options]`
//
// Generates:
//   - mod.json (manifest, when --mod is used) or plugin.json (legacy)
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
  /** Generate a mod.json (pack format) instead of a legacy plugin.json. */
  mod?: boolean;
  /** Mod extension types to include (only with --mod). */
  extensions?: Array<"assets" | "maps" | "physics" | "shader-postfx" | "shader-material">;
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
  if (opts.format !== "asset" || (opts.mod && !opts.extensions?.includes("assets"))) {
    mkdirSync(join(pluginDir, "src"), { recursive: true });
  }

  // ── Manifest: mod.json or plugin.json ──
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

  // ── Mod.json extensions ──
  if (opts.mod) {
    const extensions: Record<string, unknown> = {};
    if (opts.extensions?.includes("assets")) {
      extensions.assets = [];
      mkdirSync(join(pluginDir, "assets"), { recursive: true });
    }
    if (opts.extensions?.includes("maps")) {
      extensions.maps = [];
      mkdirSync(join(pluginDir, "maps"), { recursive: true });
    }
    if (opts.extensions?.includes("physics")) {
      extensions.physics = [];
      mkdirSync(join(pluginDir, "physics"), { recursive: true });
    }
    if (opts.extensions?.includes("shader-postfx") || opts.extensions?.includes("shader-material")) {
      extensions.shaders = {};
      if (opts.extensions?.includes("shader-postfx")) {
        (extensions.shaders as Record<string, unknown>).postfx = [];
        mkdirSync(join(pluginDir, "shaders"), { recursive: true });
      }
      if (opts.extensions?.includes("shader-material")) {
        (extensions.shaders as Record<string, unknown>).materials = [];
        if (!existsSync(join(pluginDir, "shaders"))) mkdirSync(join(pluginDir, "shaders"), { recursive: true });
      }
    }
    if (Object.keys(extensions).length > 0) manifest.extensions = extensions;
    // For a mod.json, use `logic` instead of top-level entry/permissions when
    // the format is code-bearing.
    if (opts.format !== "asset") {
      manifest.logic = {
        format: opts.format,
        thread: defaults.thread,
        entry: manifest.entry,
        permissions: defaults.permissions,
      };
    }
    writeFileSync(join(pluginDir, "mod.json"), JSON.stringify(manifest, null, 2) + "\n");
  } else {
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

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
  log.info("plugin", `  Manifest:  ${opts.mod ? "mod.json" : "plugin.json"}`);
  if (opts.mod && opts.extensions?.length) {
    log.info("plugin", `  Extensions: ${opts.extensions.join(", ")}`);
  }
  log.info("plugin", `  Target:    ${pluginDir}`);
  log.info("plugin", "");
  log.info("plugin", `Next steps:`);
  log.info("plugin", `  1. Edit ${opts.mod ? "mod.json" : "plugin.json"} to declare provides/requires/permissions`);
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
  return `;; ${opts.id} — WASM plugin (ABI v3)
;; v3 adds host-call imports (spawn_prop, set_physics, apply_impulse, etc.)
;; and the on_host_call_result export. v2 imports (log/state/events) are unchanged.
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

  ;; v3: Called when a host-call completes. request_id matches the id returned
  ;; by the host-call import. result_ptr/len point to a JSON result string
  ;; (or 0,0 for void). error_ptr/len point to an error string (or 0,0 on success).
  (func (export "on_host_call_result")
    (param $req i32) (param $rptr i32) (param $rlen i32) (param $eptr i32) (param $elen i32)
    ;; Handle host-call results
  )
)
`;
}

function README_TEMPLATE(opts: PluginScaffoldOptions): string {
  const manifestFile = opts.mod ? "mod.json" : "plugin.json";
  const extList = opts.mod && opts.extensions?.length
    ? `\n- **Extensions:** ${opts.extensions.join(", ")}`
    : "";
  return `# ${opts.name}

${opts.description ?? "A user-authored plugin for the Downdraft Engine."}

- **Format:** \`${opts.format}\`
- **Tier:** \`${FORMAT_DEFAULTS[opts.format].tier}\`
- **Thread:** \`${FORMAT_DEFAULTS[opts.format].thread}\`
- **Game:** \`${opts.game}\`${extList}

## Getting started

1. Edit \`${manifestFile}\` to declare your \`provides\`, \`requires\`, and \`permissions\`.
2. Implement the plugin entry in \`src/\`.
3. Add the plugin to your game's \`GameModule.plugins\` config.

## Built with

Generated by \`dd ${opts.mod ? "mod" : "plugin"} new\` — the Downdraft Engine CLI scaffold.
`;
}
