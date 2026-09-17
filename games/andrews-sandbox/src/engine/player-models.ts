// ============================================================================
// Player Model Registry — builtin player models (Aisha, Robin, Humanling).
//
// Resolves Vite URLs for the FBX meshes + their sibling texture directories so
// the player-model loader can fetch external textures. The mesh + texture
// URLs are resolved at module load via import.meta.glob (renderer-side only —
// the sim worker reads DEFAULT_PLAYER_MODEL from shared/constants/player.ts).
// ============================================================================

import { DEFAULT_PLAYER_MODEL } from "@sandbox/shared/constants/player";

export interface PlayerModelDef {
  /** Stable id used by the sim save state + UI. */
  id: string;
  /** Display name for the Character tab. */
  name: string;
  /** FBX mesh URL (resolved by Vite). */
  meshUri: string;
  /** FBX filename (used by the loader for format detection). */
  filename: string;
  /** Base URL (directory) of the mesh, for resolving relative texture URIs. */
  meshBaseUrl: string;
  /** Texture search directories (absolute Vite URLs) tried in order when a
   *  material's embedded texture is not browser-decodable. */
  textureDirs: string[];
}

// ── Mixamo animation registry ──
// Maps animation state names to FBX filenames in the human_animation directory.
export interface PlayerAnimationDef {
  /** Animation state name (matches SkeletonAnimator state). */
  state: string;
  /** FBX filename in the human_animation directory. */
  filename: string;
}

export const PLAYER_ANIMATIONS: readonly PlayerAnimationDef[] = [
  { state: "Idle", filename: "X Bot@Idle.fbx" },
  { state: "Walk", filename: "X Bot@Walking.fbx" },
  { state: "Run", filename: "X Bot@Fast Run.fbx" },
];

// ── Asset glob: Vite (import.meta.glob) or Bun-native (createGlob) ──
// import.meta.glob is a Vite compile-time feature; under Bun-native mode we
// fall back to a filesystem glob returning file:// URLs.
const _glob = (import.meta as any).glob ?? ((pattern: string) => {
  try {
    const { createGlob } = require("@downdraft/core/platform/glob-polyfill");
    const modDir = (import.meta as any).dir ?? ".";
    return createGlob(modDir)(pattern, { query: "?url", eager: true });
  } catch { return {} as Record<string, string>; }
});

// Resolve Mixamo animation FBX URLs at module load.
const ANIM_GLOB = _glob("../assets/builtin/human_animation/*.fbx", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Resolve a Mixamo animation URL by filename. */
export function resolveAnimationUrl(filename: string): string | null {
  for (const [path, url] of Object.entries(ANIM_GLOB)) {
    if (path.endsWith(filename)) return cleanUrl(url);
  }
  return null;
}

// Resolve builtin asset URLs once at module load. The glob keys are the
// relative paths from this file; the values are the Vite-resolved URLs.
const MESH_GLOB = _glob("../assets/builtin/**/*.fbx", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const TEX_GLOB = _glob("../assets/builtin/**/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Strip the query string Vite appends to ?url imports. */
function cleanUrl(url: string): string {
  return url;
}

/** Return the directory URL for a builtin texture subdirectory, or "" if none. */
function textureDirFor(subdir: string): string {
  const prefix = `../assets/builtin/${subdir}/`;
  for (const [path, url] of Object.entries(TEX_GLOB)) {
    if (path.startsWith(prefix)) {
      const u = cleanUrl(url);
      const file = path.slice(prefix.length).split("/").pop()!;
      return u.slice(0, u.length - file.length);
    }
  }
  return "";
}

/** Resolve a mesh URL + base directory from the glob by subpath. */
function resolveMesh(subpath: string): { meshUri: string; meshBaseUrl: string } | null {
  for (const [path, url] of Object.entries(MESH_GLOB)) {
    if (path.endsWith(subpath)) {
      const u = cleanUrl(url);
      const file = path.split("/").pop()!;
      const base = u.slice(0, u.length - file.length);
      return { meshUri: u, meshBaseUrl: base };
    }
  }
  return null;
}

function buildDef(
  id: string,
  name: string,
  meshSubpath: string,
  textureSubdirs: string[],
): PlayerModelDef | null {
  const mesh = resolveMesh(meshSubpath);
  if (!mesh) return null;
  const filename = meshSubpath.split("/").pop()!;
  const textureDirs: string[] = [];
  for (const subdir of textureSubdirs) {
    const dir = textureDirFor(subdir);
    if (dir) textureDirs.push(dir);
  }
  return {
    id,
    name,
    meshUri: mesh.meshUri,
    filename,
    meshBaseUrl: mesh.meshBaseUrl,
    textureDirs,
  };
}

const _defs: PlayerModelDef[] = [];
const aisha = buildDef("aisha", "Aisha", "Aisha/mesh/Aisha.fbx", ["Aisha/texture", "Aisha/texture/skinColor_var"]);
if (aisha) _defs.push(aisha);
const robin = buildDef("robin", "Robin", "Robin/Robin/mesh/Robin.fbx", ["Robin/Robin/texture"]);
if (robin) _defs.push(robin);
const humanlingFe = buildDef("humanling-fe", "Humanling (F)", "Humanling/mesh/LP_fe_mesh.fbx", ["Humanling/textue"]);
if (humanlingFe) _defs.push(humanlingFe);
const humanlingMale = buildDef("humanling-male", "Humanling (M)", "Humanling/mesh/LP_male_mesh.fbx", ["Humanling/textue"]);
if (humanlingMale) _defs.push(humanlingMale);

export const PLAYER_MODELS: readonly PlayerModelDef[] = _defs;

const _byId = new Map<string, PlayerModelDef>(_defs.map((d) => [d.id, d]));

export function getPlayerModelDef(id: string): PlayerModelDef | null {
  return _byId.get(id) ?? null;
}

export function isValidPlayerModel(id: string): boolean {
  return _byId.has(id);
}

export { DEFAULT_PLAYER_MODEL };
