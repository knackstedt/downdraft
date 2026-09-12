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
  | "log" // structured logging (rate-limited)
  | "physics" // mutate physics bodies via host-call bridge (native tier)
  | "assets"; // resolve + reference asset handles via host-call bridge (native tier)

// ── Mod (pack) extension types ──
//
// A `mod.json` declares a pack of extensions in addition to (or instead of)
// the legacy single-format fields. Each extension is declarative data
// registered by the host; the optional `logic` extension is code (worker-js
// or wasm) that runs sandboxed and may mutate the game via host calls.

/** Logic extension — the code entry of a mod. Either worker-js (TS) or wasm.
 *  Not required: a mod can be pure data (assets/shaders/maps/physics). */
export interface ModLogic {
  /** Code format. `quickjs` is kept for legacy `plugin.json` compat. */
  format: PluginFormat;
  /** Where the code runs. wasm is always forced to `own-worker`. */
  thread: PluginThread;
  /** Entry path relative to the mod dir. */
  entry: string;
  /** Requested permissions (validated against the native-tier set). */
  permissions?: PluginPermission[];
  /** QuickJS-specific config (only valid when `format: "quickjs"`). */
  quickjs?: { instructionBudget?: number };
}

/** Asset extension kinds registered into the AssetManager + content catalog. */
export interface ModAssetExtension {
  kind: "mesh" | "texture" | "pbr-material" | "texture-pipeline";
  /** Logical asset id (namespaced, e.g. "my-mod:crate"). */
  id: string;
  /** Path to the file relative to the mod dir. */
  path: string;
  /** pbr-material: descriptor fields (baseColor, metallic, roughness, texture refs). */
  /** texture-pipeline: pipeline descriptor. Extra fields are pass-through. */
  [key: string]: unknown;
}

/** Map extension — a JSON scene graph loaded into the MapRegistry. */
export interface ModMapExtension {
  kind: "map";
  id: string;
  path: string;
}

/** Physics extension — global physics overrides + material table. */
export interface ModPhysicsExtension {
  kind: "physics";
  id: string;
  path: string;
}

/** Postfx shader extension — a custom WGSL fragment effect for the PostProcessStack chain. */
export interface ModShaderPostfxExtension {
  kind: "shader-postfx";
  /** Effect id (namespaced, e.g. "my-mod:acid"). */
  id: string;
  /** Display name. */
  name: string;
  /** Path to the WGSL fragment shader relative to the mod dir. */
  wgsl: string;
  /** Bind group layout the shader expects. */
  layout: "cc" | "cd" | "cvvh" | "cvd" | "dnfn";
  /** Where in the chain this effect runs. */
  order: "hdr" | "color-grading" | "camera" | "stylized";
  /** Uniform buffer size in bytes (if the shader needs a uniform). */
  uniforms?: number;
  /** User-configurable settings shown in the Mods panel. */
  settings?: ModSetting[];
}

/** A user-configurable setting for a mod effect/material. */
export interface ModSetting {
  /** Setting key — used as the uniform field name. */
  key: string;
  /** Display label. */
  label: string;
  /** Setting type. */
  type: "slider" | "toggle" | "select";
  /** Default value. */
  default: number | boolean | string;
  /** For "slider": min, max, step. */
  min?: number;
  max?: number;
  step?: number;
  /** For "select": available options. */
  options?: Array<{ label: string; value: string }>;
}

/** Material shader extension — a custom WGSL material for spawned props. */
export interface ModShaderMaterialExtension {
  kind: "shader-material";
  /** Material id (namespaced, e.g. "my-mod:iridescent"). */
  id: string;
  /** Path to the WGSL material shader relative to the mod dir. */
  wgsl: string;
  /** Uniform buffer size in bytes. */
  uniforms?: number;
}

/** The bucketed extensions object on a mod.json. All fields optional. */
export interface ModExtensions {
  /** Asset entries (meshes, textures, PBR materials, texture pipelines). */
  assets?: ModAssetExtension[];
  /** Map scene graphs. */
  maps?: ModMapExtension[];
  /** Physics override descriptors. */
  physics?: ModPhysicsExtension[];
  /** Shader extensions (postfx chain effects + per-prop materials). */
  shaders?: {
    postfx?: ModShaderPostfxExtension[];
    materials?: ModShaderMaterialExtension[];
  };
}

/** The buckets an ExtensionLoader can handle. */
export type ModExtensionBucket =
  | "assets"
  | "maps"
  | "physics"
  | "shader-postfx"
  | "shader-material";

/** A flattened extension with its bucket tag, for dispatch. */
export interface ModExtensionDispatch {
  bucket: ModExtensionBucket;
  extension: Record<string, unknown>;
}

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
  // ── Mod (pack) fields ──
  /** Logic extension (code entry). Mutually exclusive with the legacy
   *  single-format shape: a mod.json uses `logic` + `extensions`; a legacy
   *  plugin.json uses `format`/`tier`/`thread`/`entry`/`assets`. The
   *  normalizer populates `logic` from the legacy fields so both work. */
  logic?: ModLogic;
  /** Declarative extensions (assets, maps, physics, shaders). */
  extensions?: ModExtensions;
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
  "physics",
  "assets",
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

  // ── Mod (pack) fields: logic + extensions ──
  if (m.logic !== undefined) {
    validateModLogic(m.logic as Record<string, unknown>, errors);
  }
  if (m.extensions !== undefined) {
    validateModExtensions(m.extensions as Record<string, unknown>, errors);
  }

  // ── Cross-field rules (only run if basic shape is OK) ──
  if (errors.length === 0) {
    const t = tier as PluginTier;
    const f = format as PluginFormat;
    let th = thread as PluginThread;
    const hasLogic = !!m.logic;
    // When logic is present, the entry lives on logic.entry and permissions
    // on logic.permissions; the top-level entry/permissions may be omitted.
    const effectiveEntry = m.entry ?? m.logic?.entry;
    const effectivePerms = m.logic?.permissions ?? permList;

    // wasm always own-worker (check both top-level and logic thread)
    if (f === "wasm" && th !== "own-worker") {
      errors.push(`format "wasm" must use thread "own-worker" (got "${th}") — host will force it`);
    }
    if (hasLogic && m.logic!.format === "wasm" && m.logic!.thread !== "own-worker") {
      errors.push(`logic.format "wasm" must use thread "own-worker" (got "${m.logic!.thread}") — host will force it`);
    }

    // data tier ⇒ format asset, no perms, no entry, no logic
    if (t === "data") {
      if (f !== "asset") {
        errors.push(`tier "data" requires format "asset" (got "${f}")`);
      }
      if (effectivePerms.length > 0) {
        errors.push(`tier "data" must not request permissions (got [${effectivePerms.join(", ")}])`);
      }
      if (effectiveEntry !== undefined) {
        errors.push(`tier "data" must not declare an entry (got "${effectiveEntry}")`);
      }
      if (hasLogic) {
        errors.push(`tier "data" must not declare a "logic" extension`);
      }
    }

    // asset format ⇒ data tier
    if (f === "asset" && t !== "data") {
      errors.push(`format "asset" requires tier "data" (got "${t}")`);
    }

    // script tier permissions subset
    if (t === "script") {
      const bad = effectivePerms.filter((p) => !SCRIPT_ALLOWED.has(p));
      if (bad.length > 0) {
        errors.push(
          `tier "script" allows only [${[...SCRIPT_ALLOWED].join(", ")}] — disallowed: [${bad.join(", ")}]`,
        );
      }
    }

    // native tier: any permission allowed but must be explicit (no implicit grant).
    // (Nothing to enforce here beyond "must be a known permission", already checked.)
    if (t === "native") {
      const bad = effectivePerms.filter((p) => !NATIVE_ALLOWED.has(p));
      if (bad.length > 0) {
        errors.push(`tier "native" disallows unknown permissions: [${bad.join(", ")}]`);
      }
    }

    // code-bearing formats require an entry (top-level OR logic.entry)
    if ((f === "worker-js" || f === "wasm" || f === "quickjs") && effectiveEntry === undefined) {
      errors.push(`format "${f}" requires an "entry" path`);
    }
    // asset format: entry forbidden, assets OR extensions required
    if (f === "asset") {
      if (effectiveEntry !== undefined) errors.push(`format "asset" must not declare an entry`);
      if (!m.assets && !m.extensions) errors.push(`format "asset" requires an "assets" section or "extensions"`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  // ── Normalize ──
  const normalized: PluginManifest = { ...(raw as PluginManifest) };
  if (normalized.format === "wasm") normalized.thread = "own-worker";
  // Populate logic + extensions from legacy fields if not already set, so the
  // host's extension dispatch works for both mod.json and legacy plugin.json.
  normalizeLogicAndExtensions(normalized);
  return { valid: true, errors: [], normalized };
}

// ── Mod logic validation ──

function validateModLogic(l: Record<string, unknown>, errors: string[]): void {
  const VALID_LOGIC_FORMATS: PluginFormat[] = ["worker-js", "wasm", "quickjs"];
  if (typeof l.format !== "string" || !VALID_LOGIC_FORMATS.includes(l.format as PluginFormat)) {
    errors.push(`logic.format: required one of ${VALID_LOGIC_FORMATS.join("|")}, got "${l.format}"`);
  }
  const VALID_THREADS: PluginThread[] = ["sim", "renderer", "own-worker"];
  if (typeof l.thread !== "string" || !VALID_THREADS.includes(l.thread as PluginThread)) {
    errors.push(`logic.thread: required one of ${VALID_THREADS.join("|")}, got "${l.thread}"`);
  }
  if (typeof l.entry !== "string" || !l.entry) {
    errors.push(`logic.entry: required string path, got "${l.entry}"`);
  }
  if (l.permissions !== undefined) {
    if (!Array.isArray(l.permissions) || !l.permissions.every((p) => typeof p === "string")) {
      errors.push("logic.permissions: must be an array of strings");
    }
  }
}

// ── Mod extensions validation ──

function validateModExtensions(e: Record<string, unknown>, errors: string[]): void {
  if (typeof e !== "object" || e === null) {
    errors.push("extensions: must be an object");
    return;
  }
  if (e.assets !== undefined) {
    if (!Array.isArray(e.assets)) {
      errors.push("extensions.assets: must be an array");
    } else {
      e.assets.forEach((a, i) => validateAssetExtension(a, i, errors));
    }
  }
  if (e.maps !== undefined) {
    if (!Array.isArray(e.maps)) {
      errors.push("extensions.maps: must be an array");
    } else {
      e.maps.forEach((mp, i) => {
        if (!mp || typeof mp !== "object") return errors.push(`extensions.maps[${i}]: must be an object`);
        if (typeof mp.id !== "string") errors.push(`extensions.maps[${i}].id: required string`);
        if (typeof mp.path !== "string") errors.push(`extensions.maps[${i}].path: required string`);
      });
    }
  }
  if (e.physics !== undefined) {
    if (!Array.isArray(e.physics)) {
      errors.push("extensions.physics: must be an array");
    } else {
      e.physics.forEach((p, i) => {
        if (!p || typeof p !== "object") return errors.push(`extensions.physics[${i}]: must be an object`);
        if (typeof p.id !== "string") errors.push(`extensions.physics[${i}].id: required string`);
        if (typeof p.path !== "string") errors.push(`extensions.physics[${i}].path: required string`);
      });
    }
  }
  if (e.shaders !== undefined) {
    if (typeof e.shaders !== "object" || e.shaders === null) {
      errors.push("extensions.shaders: must be an object");
    } else {
      const s = e.shaders as Record<string, unknown>;
      if (s.postfx !== undefined) {
        if (!Array.isArray(s.postfx)) {
          errors.push("extensions.shaders.postfx: must be an array");
        } else {
          s.postfx.forEach((fx, i) => validatePostfxExtension(fx, i, errors));
        }
      }
      if (s.materials !== undefined) {
        if (!Array.isArray(s.materials)) {
          errors.push("extensions.shaders.materials: must be an array");
        } else {
          s.materials.forEach((mat, i) => {
            if (!mat || typeof mat !== "object") return errors.push(`extensions.shaders.materials[${i}]: must be an object`);
            if (typeof mat.id !== "string") errors.push(`extensions.shaders.materials[${i}].id: required string`);
            if (typeof mat.wgsl !== "string") errors.push(`extensions.shaders.materials[${i}].wgsl: required string path`);
            if (mat.uniforms !== undefined && typeof mat.uniforms !== "number") errors.push(`extensions.shaders.materials[${i}].uniforms: must be a number`);
          });
        }
      }
    }
  }
}

function validateAssetExtension(a: unknown, i: number, errors: string[]): void {
  if (!a || typeof a !== "object") {
    errors.push(`extensions.assets[${i}]: must be an object`);
    return;
  }
  const ext = a as Record<string, unknown>;
  const VALID_KINDS = ["mesh", "texture", "pbr-material", "texture-pipeline"];
  if (typeof ext.kind !== "string" || !VALID_KINDS.includes(ext.kind)) {
    errors.push(`extensions.assets[${i}].kind: required one of ${VALID_KINDS.join("|")}, got "${ext.kind}"`);
  }
  if (typeof ext.id !== "string" || !ext.id) {
    errors.push(`extensions.assets[${i}].id: required string`);
  }
  if (typeof ext.path !== "string" || !ext.path) {
    errors.push(`extensions.assets[${i}].path: required string`);
  }
}

function validatePostfxExtension(fx: unknown, i: number, errors: string[]): void {
  if (!fx || typeof fx !== "object") {
    errors.push(`extensions.shaders.postfx[${i}]: must be an object`);
    return;
  }
  const ext = fx as Record<string, unknown>;
  if (typeof ext.id !== "string" || !ext.id) errors.push(`extensions.shaders.postfx[${i}].id: required string`);
  if (typeof ext.name !== "string") errors.push(`extensions.shaders.postfx[${i}].name: required string`);
  if (typeof ext.wgsl !== "string") errors.push(`extensions.shaders.postfx[${i}].wgsl: required string path`);
  const VALID_LAYOUTS = ["cc", "cd", "cvvh", "cvd", "dnfn"];
  if (typeof ext.layout !== "string" || !VALID_LAYOUTS.includes(ext.layout)) {
    errors.push(`extensions.shaders.postfx[${i}].layout: required one of ${VALID_LAYOUTS.join("|")}, got "${ext.layout}"`);
  }
  const VALID_ORDERS = ["hdr", "color-grading", "camera", "stylized"];
  if (typeof ext.order !== "string" || !VALID_ORDERS.includes(ext.order)) {
    errors.push(`extensions.shaders.postfx[${i}].order: required one of ${VALID_ORDERS.join("|")}, got "${ext.order}"`);
  }
  if (ext.uniforms !== undefined && typeof ext.uniforms !== "number") {
    errors.push(`extensions.shaders.postfx[${i}].uniforms: must be a number`);
  }
}

// ── Normalizer: populate logic + extensions from legacy plugin.json fields ──
//
// A legacy plugin.json uses `format`/`tier`/`thread`/`entry`/`permissions`/
// `assets`. A mod.json uses `logic`/`extensions`. This populates whichever is
// missing so the host's extension dispatch works uniformly for both shapes.
// The legacy fields are preserved (existing loaders still read them).

function normalizeLogicAndExtensions(m: PluginManifest): void {
  // When logic is present, ensure the top-level format/thread/entry/permissions
  // mirror it (so legacy loaders that read m.format / m.entry keep working).
  if (m.logic) {
    if (!m.format) m.format = m.logic.format;
    if (!m.thread) m.thread = m.logic.thread;
    if (!m.entry) m.entry = m.logic.entry;
    if (!m.permissions && m.logic.permissions) m.permissions = m.logic.permissions;
    if (m.logic.format === "wasm") m.thread = "own-worker";
  }
  // Populate `logic` from legacy fields when not already present and the
  // manifest is a code-bearing format.
  if (!m.logic && m.format && m.format !== "asset" && m.entry) {
    m.logic = {
      format: m.format,
      thread: m.thread,
      entry: m.entry,
      permissions: m.permissions,
      ...(m.quickjs ? { quickjs: m.quickjs } : {}),
    };
  }
  // Populate `extensions.assets` from the legacy `assets` section when not
  // already present (data-tier asset plugins).
  if (!m.extensions && m.assets) {
    const assets: ModAssetExtension[] = [];
    for (const meshPath of m.assets.meshes ?? []) {
      assets.push({ kind: "mesh", id: meshPath, path: meshPath });
    }
    for (const texPath of m.assets.textures ?? []) {
      assets.push({ kind: "texture", id: texPath, path: texPath });
    }
    for (const dataPath of m.assets.data ?? []) {
      // Legacy data files are registered as textures of kind "texture" only if
      // they're image files; otherwise they're opaque data. Keep them as
      // texture-kind entries with the data path so the asset loader can
      // dispatch by extension.
      assets.push({ kind: "texture", id: dataPath, path: dataPath });
    }
    if (assets.length > 0) m.extensions = { assets };
  }
}

/** Flatten a manifest's extensions into a dispatch list (bucket + extension).
 *  Returns extensions in a stable order: assets, maps, physics, shader-postfx,
 *  shader-material. Used by the host to drive ExtensionLoaders. */
export function flattenExtensions(m: PluginManifest): ModExtensionDispatch[] {
  const out: ModExtensionDispatch[] = [];
  const ext = m.extensions;
  if (!ext) return out;
  for (const a of ext.assets ?? []) out.push({ bucket: "assets", extension: a as unknown as Record<string, unknown> });
  for (const mp of ext.maps ?? []) out.push({ bucket: "maps", extension: mp as unknown as Record<string, unknown> });
  for (const p of ext.physics ?? []) out.push({ bucket: "physics", extension: p as unknown as Record<string, unknown> });
  for (const fx of ext.shaders?.postfx ?? []) out.push({ bucket: "shader-postfx", extension: fx as unknown as Record<string, unknown> });
  for (const mat of ext.shaders?.materials ?? []) out.push({ bucket: "shader-material", extension: mat as unknown as Record<string, unknown> });
  return out;
}
