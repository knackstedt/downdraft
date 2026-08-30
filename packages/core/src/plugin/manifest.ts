// ============================================================================
// Plugin manifest — the plugin.json contract for user-authored plugins.
//
// A plugin is a runtime-loadable extension authored by an end user / modder
// (distinct from the compile-time `Module` system). Each plugin ships a
// `plugin.json` manifest that declares its identity, format, capability tier,
// requested permissions, target thread, and dependency graph.
//
// Validation rules enforce the tier/format/thread/permission matrix described
// in the plan. Validation is hand-rolled (no zod) to match the existing
// `validateManifest` style in `../assets/manifest.ts`.
// ============================================================================

/** The four supported plugin formats. */
export type PluginFormat = "worker-js" | "wasm" | "quickjs" | "asset";

/** The three capability tiers. See plan §"Tiered capability surface". */
export type PluginTier = "data" | "script" | "native";

/**
 * Where the plugin's code executes.
 * - `sim`       — inside the game's existing sim Web Worker.
 * - `renderer`  — in-process on the renderer (main) thread.
 * - `own-worker`— a dedicated Web Worker spawned for this plugin (WASM is
 *                 always forced to this for crash isolation).
 */
export type PluginThread = "sim" | "renderer" | "own-worker";

/**
 * Permissions a plugin may request. Each maps to a set of globals/capabilities
 * the sandbox shim keeps (vs. strips) before the plugin code runs. See
 * `permissions.ts` for the global-allowlist mapping.
 */
export type PluginPermission =
  | "ecs" // register ECS systems/components (native tier, sim thread)
  | "sab" // allocate SharedArrayBuffer channels
  | "gpu" // register renderer passes / GPU access (native tier, renderer/own-worker)
  | "events" // subscribe/publish on the game event bus
  | "state" // per-plugin KV state store
  | "tick" // register per-frame tick callbacks
  | "storage" // persist plugin state to OPFS
  | "network" // fetch / WebSocket / XMLHttpRequest
  | "log"; // structured logging (rate-limited)

/** Asset-pack section (only valid when `format: "asset"`). */
export interface AssetPluginManifest {
  /** Map of logical asset id → file path within the plugin dir. */
  files: Record<string, string>;
  /** Optional: textures to register into the AssetManager texture catalog. */
  textures?: string[];
  /** Optional: audio files to register into the audio loader. */
  audio?: string[];
  /** Optional: mesh/model files (glb/gltf) to register. */
  meshes?: string[];
  /** Optional: arbitrary JSON data files exposed to game code. */
  data?: string[];
}

/** The full `plugin.json` manifest. */
export interface PluginManifest {
  /** Unique plugin id, kebab-case (e.g. "overburden-bronze-blocks"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Author string. */
  author?: string;
  /** Short description. */
  description?: string;
  /** Semver range against the engine version (e.g. "^0.1.0"). Required. */
  engineVersion: string;
  /** Target game appId (e.g. "overburden"). Required so a plugin can't load into the wrong game. */
  game: string;
  /** Plugin format. */
  format: PluginFormat;
  /** Capability tier. */
  tier: PluginTier;
  /** Target thread. WASM is always forced to `own-worker`. */
  thread: PluginThread;
  /** Entry path relative to the plugin dir. Forbidden for `data` tier. */
  entry?: string;
  /** Requested permissions. Validated against the tier's allowed set. */
  permissions?: PluginPermission[];
  /** Stringly-typed plugin resource keys this plugin provides (namespace `game:kind/name`). */
  provides?: string[];
  /** Stringly-typed plugin resource keys this plugin requires. */
  requires?: string[];
  /** Other plugin ids (with optional `@version`) this plugin depends on. */
  dependencies?: string[];
  /** Asset section — only valid when `format: "asset"`. */
  assets?: AssetPluginManifest;
  /** QuickJS-specific config. Only valid when `format: "quickjs"`. */
  quickjs?: {
    /** Max instructions per eval/tick before the interrupt handler fires.
     *  Default: 1,000,000. */
    instructionBudget?: number;
  };
}

/** Result of manifest validation. */
export interface PluginManifestValidation {
  valid: boolean;
  errors: string[];
  /** A normalized copy of the manifest with host-enforced rewrites applied
   *  (e.g. `thread: own-worker` for wasm). Only present when valid. */
  normalized?: PluginManifest;
}

// ── Permission sets per tier (single source of truth; permissions.ts mirrors) ──

const SCRIPT_ALLOWED: ReadonlySet<PluginPermission> = new Set([
  "events",
  "state",
  "tick",
  "storage",
  "log",
]);

const NATIVE_ALLOWED: ReadonlySet<PluginPermission> = new Set([
  "ecs",
  "sab",
  "gpu",
  "events",
  "state",
  "tick",
  "storage",
  "network",
  "log",
]);

// ── Helpers ──

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Minimal semver range check: accepts "^1.2.3", "~1.2.3", "1.2.3", ">=1.0.0",
// "*", "x". Not a full semver implementation — good enough to reject garbage.
const SEMVER_RANGE_RE = /^(\^|~|>=?|=)?\s*(\d+|x|X)(?:\.(\d+|x|X))?(?:\.(\d+|x|X))?(?:[-+].+)?$/;
const SEMVER_PLAIN_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

function isSemverRange(s: string): boolean {
  return s === "*" || SEMVER_RANGE_RE.test(s);
}
function isSemverPlain(s: string): boolean {
  return SEMVER_PLAIN_RE.test(s);
}

/** Validate a plugin manifest. Returns a list of errors (empty if valid). */
export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest must be a JSON object"] };
  }
  const m = raw as Record<string, unknown>;

  // Required string fields
  if (typeof m.id !== "string" || !m.id) {
    errors.push("id: required string (kebab-case)");
  } else if (!KEBAB_RE.test(m.id)) {
    errors.push(`id: "${m.id}" must be kebab-case (lowercase, hyphen-separated)`);
  }
  if (typeof m.name !== "string" || !m.name) errors.push("name: required string");
  if (typeof m.version !== "string" || !isSemverPlain(m.version)) {
    errors.push(`version: required semver (e.g. "1.0.0"), got "${m.version}"`);
  }
  if (typeof m.engineVersion !== "string" || !isSemverRange(m.engineVersion)) {
    errors.push(`engineVersion: required semver range (e.g. "^0.1.0"), got "${m.engineVersion}"`);
  }
  if (typeof m.game !== "string" || !m.game) {
    errors.push("game: required string (target game appId)");
  }

  // format
  const format = m.format;
  const VALID_FORMATS: PluginFormat[] = ["worker-js", "wasm", "quickjs", "asset"];
  if (typeof format !== "string" || !VALID_FORMATS.includes(format as PluginFormat)) {
    errors.push(`format: required one of ${VALID_FORMATS.join("|")}, got "${format}"`);
  }

  // tier
  const tier = m.tier;
  const VALID_TIERS: PluginTier[] = ["data", "script", "native"];
  if (typeof tier !== "string" || !VALID_TIERS.includes(tier as PluginTier)) {
    errors.push(`tier: required one of ${VALID_TIERS.join("|")}, got "${tier}"`);
  }

  // thread
  const thread = m.thread;
  const VALID_THREADS: PluginThread[] = ["sim", "renderer", "own-worker"];
  if (typeof thread !== "string" || !VALID_THREADS.includes(thread as PluginThread)) {
    errors.push(`thread: required one of ${VALID_THREADS.join("|")}, got "${thread}"`);
  }

  // permissions
  const perms = m.permissions;
  let permList: PluginPermission[] = [];
  if (perms !== undefined) {
    if (!Array.isArray(perms) || !perms.every((p) => typeof p === "string")) {
      errors.push("permissions: must be an array of strings");
    } else {
      permList = perms as PluginPermission[];
    }
  }

  // entry
  if (m.entry !== undefined && typeof m.entry !== "string") {
    errors.push("entry: must be a string path");
  }

  // provides / requires / dependencies
  for (const field of ["provides", "requires", "dependencies"] as const) {
    const v = m[field];
    if (v !== undefined && (!Array.isArray(v) || !v.every((x) => typeof x === "string"))) {
      errors.push(`${field}: must be an array of strings`);
    }
  }

  // assets
  if (m.assets !== undefined) {
    if (typeof m.assets !== "object") {
      errors.push("assets: must be an object");
    } else {
      const a = m.assets as Record<string, unknown>;
      if (typeof a.files !== "object" || a.files === null) {
        errors.push("assets.files: required object (asset id → path)");
      } else {
        for (const [k, v] of Object.entries(a.files)) {
          if (typeof v !== "string") errors.push(`assets.files["${k}"]: must be a string path`);
        }
      }
      for (const sub of ["textures", "audio", "meshes", "data"] as const) {
        if (a[sub] !== undefined && (!Array.isArray(a[sub]) || !a[sub].every((x) => typeof x === "string"))) {
          errors.push(`assets.${sub}: must be an array of strings`);
        }
      }
    }
  }

  // ── Cross-field rules (only run if basic shape is OK) ──
  if (errors.length === 0) {
    const t = tier as PluginTier;
    const f = format as PluginFormat;
    let th = thread as PluginThread;

    // wasm always own-worker
    if (f === "wasm" && th !== "own-worker") {
      errors.push(`format "wasm" must use thread "own-worker" (got "${th}") — host will force it`);
    }

    // data tier ⇒ format asset, no perms, no entry
    if (t === "data") {
      if (f !== "asset") {
        errors.push(`tier "data" requires format "asset" (got "${f}")`);
      }
      if (permList.length > 0) {
        errors.push(`tier "data" must not request permissions (got [${permList.join(", ")}])`);
      }
      if (m.entry !== undefined) {
        errors.push(`tier "data" must not declare an entry (got "${m.entry}")`);
      }
    }

    // asset format ⇒ data tier
    if (f === "asset" && t !== "data") {
      errors.push(`format "asset" requires tier "data" (got "${t}")`);
    }

    // script tier permissions subset
    if (t === "script") {
      const bad = permList.filter((p) => !SCRIPT_ALLOWED.has(p));
      if (bad.length > 0) {
        errors.push(
          `tier "script" allows only [${[...SCRIPT_ALLOWED].join(", ")}] — disallowed: [${bad.join(", ")}]`,
        );
      }
    }

    // native tier: any permission allowed but must be explicit (no implicit grant).
    // (Nothing to enforce here beyond "must be a known permission", already checked.)
    if (t === "native") {
      const bad = permList.filter((p) => !NATIVE_ALLOWED.has(p));
      if (bad.length > 0) {
        errors.push(`tier "native" disallows unknown permissions: [${bad.join(", ")}]`);
      }
    }

    // code-bearing formats require an entry
    if ((f === "worker-js" || f === "wasm" || f === "quickjs") && m.entry === undefined) {
      errors.push(`format "${f}" requires an "entry" path`);
    }
    // asset format: entry forbidden, assets required
    if (f === "asset") {
      if (m.entry !== undefined) errors.push(`format "asset" must not declare an entry`);
      if (!m.assets) errors.push(`format "asset" requires an "assets" section`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // ── Normalize: force wasm → own-worker ──
  const normalized: PluginManifest = { ...(raw as PluginManifest) };
  if (normalized.format === "wasm") normalized.thread = "own-worker";
  return { valid: true, errors: [], normalized };
}
