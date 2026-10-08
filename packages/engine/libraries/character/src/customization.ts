// ============================================================================
// Character customization — variant catalogs + selection resolution for
// modular character kits.
//
// Kits like the builtin Aisha/Robin/Humanling packs ship every outfit, hair
// style, beard, and accessory as sibling mesh nodes named `slot.NNN` (with
// Blender `_ptN` splits folding into their canonical variant). The destructive
// selectVariantMeshes/filterOptionalMeshes pipeline picks one variant per
// group at load time; this module instead builds a catalog of every variant
// and resolves a JSON-serializable CharacterCustomization into the mesh
// subset to upload — the model-viewer's selectedPartIndices contract applied
// to characters.
//
// Group classification:
//   internal   — /collider/ meshes: never listed, never rendered.
//   defaultOff — DEFAULT_OPTIONAL_MESH_PATTERNS (backpack, mask, vest,
//                headgear/headwear/headphone, legpouch, *_acc): hidden by
//                default (parity with filterOptionalMeshes) but equipable.
//   required   — body groups (head/torso/leg(s)/feet/hand(s)/eye(s)): must
//                always render a variant — "None" is not offered.
//   optional   — everything else (hair, beard, facewear, …): defaults to the
//                first variant, may be hidden or re-picked.
// ============================================================================

import type { MaterialData, MeshData, ModelData } from "@downdraft/engine/libraries/models";
import { DEFAULT_OPTIONAL_MESH_PATTERNS } from "./loader";

/** Serializable per-model customization — persisted in save state. */
export interface CharacterCustomization {
  /** group key → selected variant part-key ("ash_torso.007"), or null = hidden. */
  variants: Record<string, string | null>;
  /** material name → chosen texture asset path, absent = model default. */
  textures: Record<string, string>;
  /** material name → RGB tint (linear 0-1), absent = material default. */
  tints: Record<string, [number, number, number]>;
  /** Body girth scale delta (-1..1 fraction; 0/absent = authored shape).
   *  Applied at upload as a horizontal scale weighted by a skin-derived
   *  body-region field, so skin and garments widen together. */
  girth?: number;
}

/** One selectable variant inside a group. */
export interface VariantRef {
  /** Canonical part key ("ash_torso.007"); `_ptN` splits fold into this. */
  key: string;
  /** Mesh indices the variant covers (node.mesh + node.meshes + _ptN parts). */
  meshIndices: number[];
}

export type VariantGroupKind = "required" | "optional" | "defaultOff" | "internal";

/** A customization slot: one pickable variant (or None, when allowed). */
export interface VariantGroup {
  /** Group key ("ash_torso"). */
  key: string;
  /** Display label ("Upper Torso"). */
  label: string;
  /** Variants in node order. */
  variants: VariantRef[];
  kind: VariantGroupKind;
}

export interface VariantCatalog {
  groups: VariantGroup[];
  /** Fast group lookup by key. */
  byKey: Map<string, VariantGroup>;
}

export interface BuildCatalogOptions {
  /** Group-name suffixes (after stripping the `prefix_` model namespace)
   *  that must always render a variant. */
  requiredSuffixes?: readonly string[];
  /** Patterns marking groups hidden-but-equipable (default: optional mesh patterns). */
  defaultOffPatterns?: readonly RegExp[];
  /** Patterns marking groups never rendered or listed (default: /collider/i). */
  internalPatterns?: readonly RegExp[];
  /** Explicit required group keys — overrides suffix classification when present. */
  requiredGroups?: readonly string[];
}

const DEFAULT_REQUIRED_SUFFIXES: readonly string[] = [
  "head", "torso", "leg", "legs", "feet", "foot", "hand", "hands", "eye", "eyes",
];
const DEFAULT_INTERNAL_PATTERNS: readonly RegExp[] = [/collider/i];

/** Strip a Blender mesh-split `_ptN` suffix (shared with loader.selectVariantMeshes). */
function variantPartKey(name: string): string {
  return name.replace(/_pt\d+$/i, "");
}

/** Strip the trailing `.NNN` / `_NNN` variant suffix (shared with loader). */
function variantGroupKey(name: string): string {
  return variantPartKey(name).replace(/[._]\d+$/, "");
}

/** Group suffix used for required classification: "ash_torso" → "torso". */
function groupSuffix(key: string): string {
  return key.replace(/^[a-z]+_/i, "").toLowerCase();
}

/** "ash_upperTorso" → "Upper Torso"; "rb_headwear" → "Headwear". */
export function slotLabel(groupKey: string): string {
  const suffix = groupKey.replace(/^[a-z]+_/i, "");
  return suffix
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short variant label for UI: "ash_torso.007" → "7"; unnumbered base → "Base". */
export function variantLabel(variantKey: string): string {
  const m = /[._](\d+)$/.exec(variantKey);
  return m ? String(parseInt(m[1], 10)) : "Base";
}

/**
 * Build the variant catalog for a fully-loaded model (i.e. loaded WITHOUT the
 * destructive filterOptionalMeshes/selectVariantMeshes passes).
 */
export function buildVariantCatalog(model: ModelData, opts: BuildCatalogOptions = {}): VariantCatalog {
  const requiredSuffixes = opts.requiredSuffixes ?? DEFAULT_REQUIRED_SUFFIXES;
  const defaultOffPatterns = opts.defaultOffPatterns ?? DEFAULT_OPTIONAL_MESH_PATTERNS;
  const internalPatterns = opts.internalPatterns ?? DEFAULT_INTERNAL_PATTERNS;
  const requiredSet = opts.requiredGroups ? new Set(opts.requiredGroups) : null;

  // Collect mesh-bearing nodes into groups, keyed by variantGroupKey.
  // Within a group, variants are keyed by variantPartKey (canonical node name)
  // so a variant split across `rb_headwear.005`, `.005_pt1`, `.005_pt2` nodes
  // counts once and keeps every split mesh.
  const groupMap = new Map<string, { key: string; parts: Map<string, number[]> }>();
  const nodes = model.nodes ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const idxs: number[] = [];
    if (node.meshes) {
      for (let _j = 0, _it = node.meshes, _m = _it.length; _j < _m; _j++) { const mi = _it[_j];
        if (mi < model.meshes.length) idxs.push(mi);
      }
    } else if (node.mesh !== undefined && node.mesh < model.meshes.length) {
      idxs.push(node.mesh);
    }
    if (idxs.length === 0) continue;

    const gkey = variantGroupKey(node.name);
    const pkey = variantPartKey(node.name);
    let g = groupMap.get(gkey);
    if (!g) { g = { key: gkey, parts: new Map() }; groupMap.set(gkey, g); }
    let part = g.parts.get(pkey);
    if (!part) { part = []; g.parts.set(pkey, part); }
    for (let _j = 0, _n = idxs.length; _j < _n; _j++) part.push(idxs[_j]);
  }

  const groups: VariantGroup[] = [];
  const byKey = new Map<string, VariantGroup>();
  for (const g of groupMap.values()) {
    const variants: VariantRef[] = [];
    for (const [pkey, meshIndices] of g.parts.entries()) {
      variants.push({ key: pkey, meshIndices });
    }
    let kind: VariantGroupKind;
    if (internalPatterns.some((p) => p.test(g.key))) kind = "internal";
    else if (requiredSet ? requiredSet.has(g.key) : requiredSuffixes.includes(groupSuffix(g.key))) kind = "required";
    else if (defaultOffPatterns.some((p) => p.test(g.key))) kind = "defaultOff";
    else kind = "optional";
    const group: VariantGroup = { key: g.key, label: slotLabel(g.key), variants, kind };
    groups.push(group);
    byKey.set(g.key, group);
  }
  return { groups, byKey };
}

/**
 * The kit default — reproduces the legacy filterOptionalMeshes +
 * selectVariantMeshes pipeline exactly: required and optional groups keep
 * their first variant; defaultOff groups are hidden; internal groups render
 * nothing.
 */
export function defaultCustomization(catalog: VariantCatalog): CharacterCustomization {
  const variants: Record<string, string | null> = {};
  for (let _i = 0, _it = catalog.groups, _n = _it.length; _i < _n; _i++) { const g = _it[_i];
    if (g.kind === "internal") continue;
    variants[g.key] = g.kind === "defaultOff" ? null : (g.variants[0]?.key ?? null);
  }
  return { variants, textures: {}, tints: {} };
}

/** Groups the UI should list: everything except internal groups and
 *  required groups with a single variant (nothing to choose). */
export function customizableGroups(catalog: VariantCatalog): VariantGroup[] {
  const out: VariantGroup[] = [];
  for (let _i = 0, _it = catalog.groups, _n = _it.length; _i < _n; _i++) { const g = _it[_i];
    if (g.kind === "internal") continue;
    if (g.kind === "required" && g.variants.length <= 1) continue;
    out.push(g);
  }
  return out;
}

/** Validate a saved variant pick: returns the variant key, or the group's
 *  default when the saved value is missing/stale. */
export function effectiveVariantKey(group: VariantGroup, cust: CharacterCustomization): string | null {
  const saved = cust.variants[group.key];
  if (saved !== undefined) {
    if (saved === null) return group.kind === "required" ? (group.variants[0]?.key ?? null) : null;
    for (let _i = 0, _it = group.variants, _n = _it.length; _i < _n; _i++) { const v = _it[_i];
      if (v.key === saved) return saved;
    }
  }
  return group.kind === "defaultOff" ? null : (group.variants[0]?.key ?? null);
}

export interface ResolveMeshesOptions {
  /** Group suffixes whose skin-material meshes are treated as "under layers"
   *  (bare skin tucked beneath garments — legs/hands under hems and sleeves).
   *  Defaults cover the body-clothing region; the head/eyes are excluded so
   *  the face can't sink behind eyeball meshes. */
  innerLayerSuffixes?: readonly string[];
  /** Material names (string or RegExp) treated as skin — the universal
   *  under-layer that garments render over. */
  innerMaterials?: readonly (string | RegExp)[];
  /** Inward normal offset for skin meshes in inner groups, in model units
   *  (default 0.005 ≈ ~5mm at the 1.8m fit). */
  innerLayerOffset?: number;
  /** Bone-name → girth weight pairs (first match wins, fallback 0.5).
   *  Drives the body-region field for `customization.girth` — verts skinned
   *  to core bones deform fully, extremities stay put. Defaults cover the
   *  UE-style naming shared by all bundled kits. */
  girthBoneFactors?: readonly [RegExp, number][];
  /** Girth weight for verts with no skin data (rigid pieces still track
   *  body width so they don't sink into a widened torso). Default 0.7. */
  girthUnskinned?: number;
  /** Height window for the girth falloff, as fractions of model height
   *  measured up from the floor: [fullBelow, capAbove, topMul]. Below
   *  `fullBelow` the bone weight applies at full strength; it eases to
   *  `topMul` by `capAbove` so collars/hoods near the head don't balloon
   *  wider than the head itself. Default [0.72, 0.88, 0.3]. */
  girthUpWindow?: readonly [number, number, number];
}

const DEFAULT_INNER_SUFFIXES: readonly string[] = [
  "leg", "legs", "hand", "hands", "torso", "uppertorso", "foot", "feet",
];
const DEFAULT_INNER_MATERIALS: readonly RegExp[] = [/skin/i];
const DEFAULT_INNER_OFFSET = 0.01;

/** UE-style bone names → girth region weight. Ordered — first match wins. */
const DEFAULT_GIRTH_BONES: readonly [RegExp, number][] = [
  [/pelvis|spine/i, 1.0],
  [/thigh/i, 0.8],
  [/clavicle/i, 0.7],
  [/upperarm/i, 0.5],
  [/calf/i, 0.4],
  [/lowerarm/i, 0.3],
  [/neck|head/i, 0],
  [/foot|ball|toe/i, 0.15],
  [/hand|thumb|index|middle|ring|pinky|metacarpal/i, 0.15],
];
const DEFAULT_GIRTH_UNSKINNED = 0.7;
const GIRTH_FALLBACK = 0.5;
const DEFAULT_GIRTH_WINDOW: readonly [number, number, number] = [0.72, 0.88, 0.3];

function boneGirthFactor(name: string, table: readonly [RegExp, number][]): number {
  for (let i = 0; i < table.length; i++) if (table[i][0].test(name)) return table[i][1];
  return GIRTH_FALLBACK;
}

/** Per-mesh girth weights — cached so repeat resolves don't rescan skin
 *  weights. Keyed on the factors table + height window the field derives
 *  from (the window shifts if the selected mesh set's bounds change). */
const girthWeightCache = new WeakMap<MeshData, {
  src: readonly [RegExp, number][]; uF: number; uC: number; tm: number; weights: Float32Array;
}>();

function girthWeightsFor(
  model: ModelData, mesh: MeshData, table: readonly [RegExp, number][], unskinned: number,
  up: number, uFull: number, uCap: number, topMul: number,
): Float32Array {
  const hit = girthWeightCache.get(mesh);
  if (hit && hit.src === table && hit.uF === uFull && hit.uC === uCap && hit.tm === topMul) return hit.weights;
  const out = new Float32Array(mesh.vertexCount);
  if (mesh.joints && mesh.weights && mesh.joints.length >= mesh.vertexCount * 4 && model.skin) {
    const bones = model.skin.bones;
    const jf = new Float32Array(bones.length);
    for (let i = 0; i < bones.length; i++) jf[i] = boneGirthFactor(bones[i].name, table);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const b = v * 4;
      out[v] =
        jf[mesh.joints[b]] * mesh.weights[b] +
        jf[mesh.joints[b + 1]] * mesh.weights[b + 1] +
        jf[mesh.joints[b + 2]] * mesh.weights[b + 2] +
        jf[mesh.joints[b + 3]] * mesh.weights[b + 3];
    }
  } else {
    out.fill(unskinned);
  }
  // Height taper — weight gain lives in the torso/legs; ease toward
  // topMul approaching the head so collars don't out-widen the face.
  const span = uCap - uFull;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const u = mesh.vertices[v * 6 + up];
    if (u <= uFull || span <= 0) continue;
    if (u >= uCap) { out[v] *= topMul; continue; }
    const t = (u - uFull) / span;
    out[v] *= 1 + (topMul - 1) * t * t * (3 - 2 * t);
  }
  girthWeightCache.set(mesh, { src: table, uF: uFull, uC: uCap, tm: topMul, weights: out });
  return out;
}

/**
 * Resolve a customization into the mesh subset to upload. Internal groups
 * never contribute meshes; `null` selections contribute none. Required groups
 * fall back to their first variant when the saved pick is stale.
 *
 * Skin-material meshes in "inner" groups are shallow-cloned with a
 * `surfaceOffset` — modular kits author bare-skin shells that sit fractions
 * of a millimeter under garments; without the offset the skin z-fights or
 * pokes through where a garment variant doesn't fully cover it. The offset
 * only applies to skin meshes substantially enclosed by a non-skin mesh in
 * the same variant: a bare-skin pick (or one whose only non-skin meshes are
 * small accessories like nails or partially-overlapping cuffs) must keep its
 * authored surface, since a uniform inward offset on a limb-radius mesh
 * collapses it to the bone.
 */
export function resolveCustomizationMeshes(
  model: ModelData,
  catalog: VariantCatalog,
  cust: CharacterCustomization,
  opts: ResolveMeshesOptions = {},
): { meshes: MeshData[]; meshIndices: Set<number> } {
  const innerSuffixes = opts.innerLayerSuffixes ?? DEFAULT_INNER_SUFFIXES;
  const innerMats = opts.innerMaterials ?? DEFAULT_INNER_MATERIALS;
  const innerOffset = opts.innerLayerOffset ?? DEFAULT_INNER_OFFSET;
  const isSkin = (meshIdx: number) => {
    const name = model.materials?.[model.meshes[meshIdx].materialIndex ?? -1]?.name;
    return name !== undefined && innerMats.some((p) => (typeof p === "string" ? p === name : p.test(name)));
  };
  const meshIndices = new Set<number>();
  const innerIndices = new Set<number>();
  const boundsCache = new Map<number, MeshBounds | null>();
  for (let _i = 0, _it = catalog.groups, _n = _it.length; _i < _n; _i++) { const g = _it[_i];
    if (g.kind === "internal") continue;
    const pick = effectiveVariantKey(g, cust);
    if (pick === null) continue;
    const inner = innerOffset !== 0 && innerSuffixes.includes(groupSuffix(g.key));
    for (let _j = 0, _jt = g.variants, _m = _jt.length; _j < _m; _j++) { const v = _jt[_j];
      if (v.key !== pick) continue;
      for (let _k = 0, _kt = v.meshIndices, _l = _kt.length; _k < _l; _k++) {
        meshIndices.add(_kt[_k]);
      }
      if (!inner) continue;
      for (let _k = 0, _kt = v.meshIndices, _l = _kt.length; _k < _l; _k++) {
        const mi = _kt[_k];
        if (!isSkin(mi)) continue;
        const covered = v.meshIndices.some((j) => {
          if (j === mi || isSkin(j)) return false;
          const sb = meshBoundsCached(model.meshes, mi, boundsCache);
          const gb = meshBoundsCached(model.meshes, j, boundsCache);
          // ≥90% enclosed: the shell sits under the garment. Lower overlaps
          // are exposed surfaces (bare picks, crease slivers) that must keep
          // their authored shape — recessing them opens a gap at the seam.
          return sb !== null && gb !== null && boxOverlapFraction(sb, gb) >= 0.9;
        });
        if (covered) innerIndices.add(mi);
      }
    }
  }
  // Girth: scale the two horizontal axes about the body-center line.
  // Loaded vertex data is always engine y-up (normalizeModel bakes the
  // source up-axis conversion into the verts — do NOT use sourceUpAxis
  // here, it describes the file, not the stored data). Pivot on each
  // scaled axis is its bounds midpoint.
  const girth = cust.girth ?? 0;
  let gAxes: readonly [number, number] | null = null;
  let gCenters: readonly [number, number] | null = null;
  let gUp = 1, gUFull = 0, gUCap = 0, gUTop = 0;
  const gTable = opts.girthBoneFactors ?? DEFAULT_GIRTH_BONES;
  const gUnskinned = opts.girthUnskinned ?? DEFAULT_GIRTH_UNSKINNED;
  const gWindow = opts.girthUpWindow ?? DEFAULT_GIRTH_WINDOW;
  if (girth !== 0) {
    const b = computeMeshBounds(model.meshes, meshIndices);
    if (b) {
      const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const up = 1;
      const h = [0, 1, 2].filter((a) => a !== up) as [number, number];
      gAxes = h;
      gCenters = [(b.min[h[0]] + b.max[h[0]]) / 2, (b.min[h[1]] + b.max[h[1]]) / 2];
      gUp = up;
      const uSpan = Math.max(1e-6, ext[up]);
      gUFull = b.min[up] + uSpan * Math.min(gWindow[0], gWindow[1]);
      gUCap = b.min[up] + uSpan * Math.max(gWindow[0], gWindow[1]);
      gUTop = gWindow[2];
    }
  }
  const meshes: MeshData[] = [];
  for (let i = 0; i < model.meshes.length; i++) {
    if (!meshIndices.has(i)) continue;
    const m = model.meshes[i];
    const inner = innerIndices.has(i);
    if (!inner && !gAxes) { meshes.push(m); continue; }
    meshes.push({
      ...m,
      ...(inner ? { surfaceOffset: innerOffset } : {}),
      ...(gAxes ? { surfaceGirth: { factor: girth, weights: girthWeightsFor(model, m, gTable, gUnskinned, gUp, gUFull, gUCap, gUTop), axes: gAxes, centers: gCenters! } } : {}),
    });
  }
  return { meshes, meshIndices };
}

/** Mesh indices of visible *required* groups — the body used for scale fit
 *  (outfits/hats shouldn't change how the avatar fits the 1.8m capsule). */
export function requiredMeshIndices(catalog: VariantCatalog, cust: CharacterCustomization): Set<number> {
  const out = new Set<number>();
  for (let _i = 0, _it = catalog.groups, _n = _it.length; _i < _n; _i++) { const g = _it[_i];
    if (g.kind !== "required") continue;
    const pick = effectiveVariantKey(g, cust);
    if (pick === null) continue;
    for (let _j = 0, _jt = g.variants, _m = _jt.length; _j < _m; _j++) { const v = _jt[_j];
      if (v.key !== pick) continue;
      for (let _k = 0, _kt = v.meshIndices, _l = _kt.length; _k < _l; _k++) out.add(_kt[_k]);
    }
  }
  return out;
}

type MeshBounds = { min: [number, number, number]; max: [number, number, number] };

/** Per-mesh axis-aligned bounds (pos stride: xyz + normal xyz), or null for
 *  a mesh with no usable position data. */
function singleMeshBounds(mesh: MeshData): MeshBounds | null {
  const verts = mesh.vertices;
  const stride = mesh.vertexCount > 0 ? Math.floor(verts.length / mesh.vertexCount) : 0;
  if (stride < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.vertexCount; v++) {
    const x = verts[v * stride], y = verts[v * stride + 1], z = verts[v * stride + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

function meshBoundsCached(meshes: MeshData[], i: number, cache: Map<number, MeshBounds | null>): MeshBounds | null {
  let b = cache.get(i);
  if (b === undefined) {
    b = singleMeshBounds(meshes[i]);
    cache.set(i, b);
  }
  return b;
}

/** Fraction of box `a`'s volume overlapped by box `b` (0–1). */
function boxOverlapFraction(a: MeshBounds, b: MeshBounds): number {
  let f = 1;
  for (let i = 0; i < 3; i++) {
    const ext = Math.max(1e-9, a.max[i] - a.min[i]);
    f *= Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i])) / ext;
  }
  return f;
}

/** Axis-aligned bounds over vertex positions (pos stride: xyz + normal xyz). */
export function computeMeshBounds(
  meshes: MeshData[],
  meshIndices?: Set<number>,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (let i = 0; i < meshes.length; i++) {
    if (meshIndices && !meshIndices.has(i)) continue;
    const mesh = meshes[i];
    const verts = mesh.vertices;
    const stride = mesh.vertexCount > 0 ? Math.floor(verts.length / mesh.vertexCount) : 0;
    if (stride < 3) continue;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = verts[v * stride], y = verts[v * stride + 1], z = verts[v * stride + 2];
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      any = true;
    }
  }
  return any ? { min, max } : null;
}

/** Clone the materials array and apply a texture swap (bytes already fetched)
 *  and/or tint on the named material. Indices are preserved so mesh
 *  materialIndex lookups stay valid. Returns the ORIGINAL array untouched
 *  when no override applies. */
export function withMaterialOverrides(
  materials: MaterialData[] | undefined,
  overrides: Array<{ material: string; textureData?: ArrayBuffer | null; tint?: [number, number, number] }>,
): MaterialData[] | undefined {
  if (!materials || overrides.length === 0) return materials;
  let out: MaterialData[] | null = null;
  for (let _i = 0, _it = overrides, _n = _it.length; _i < _n; _i++) { const ov = _it[_i];
    for (let mi = 0; mi < materials.length; mi++) {
      if (materials[mi].name !== ov.material) continue;
      if (!out) out = materials.slice();
      const m = { ...out[mi] };
      if (ov.textureData !== undefined) {
        m.textureData = ov.textureData;
        m.textureUri = undefined;
      }
      if (ov.tint) m.baseColor = [ov.tint[0], ov.tint[1], ov.tint[2], m.baseColor[3]];
      out[mi] = m;
    }
  }
  return out ?? materials;
}
