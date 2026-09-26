// ============================================================================
// Rule compiler — compiles ReactionRule[] into typed-array lookup tables.
//
// The compiler organizes rules by material for O(1) lookup in the hot path.
// Each material gets a contiguous slice of the flat rule array, so the engine
// can dispatch to the right rules with a simple bounds check.
// ============================================================================

import { MAX_MATERIAL } from "../materials";
import type { ReactionRule } from "./rule-types";

export interface CompiledRule {
  // Condition data
  hasChance: boolean;
  chance: number;
  minTemp: number;  // -Infinity = no min
  maxTemp: number;  // +Infinity = no max
  // Neighbor requirements (precompiled to flat arrays for cache efficiency)
  neighborCount: number;
  // For each neighbor requirement:
  neighborDirs: Uint8Array;     // DIR bitmask
  neighborMatchKind: Uint8Array; // 0=material, 1=class, 2=is_hot, 3=is_fire, 4=not_material, 5=not_wall, 6=is_cold
  neighborMatchValue: Uint32Array; // material id or flag bit
  neighborMinCount: Uint8Array;
  // Actions (flat arrays)
  actionCount: number;
  actionTypes: Uint8Array;      // 0=transform_self, 1=transform_neighbor, 2=transform_first_matching, 3=clear_self, 4=clear_neighbor, 5=explode, 6=impulse
  actionMat: Uint32Array;       // target material for transform actions
  actionLifetime: Uint32Array;  // target lifetime (0 = use default)
  actionRadius: Uint32Array;    // radius for explode/impulse
  actionStrength: Float32Array; // strength for impulse
  // Match data for transform_neighbor/clear_neighbor actions
  actionMatchKind: Uint8Array;
  actionMatchValue: Uint32Array;
}

export interface CompiledRuleSet {
  // ruleIndices[mat] = start index into the rules array
  ruleIndices: Int32Array;  // length MAX_MATERIAL+1, -1 = no rules
  ruleCounts: Uint8Array;   // length MAX_MATERIAL+1
  rules: CompiledRule[];
}

const MAX_NEIGHBORS = 8;
const MAX_ACTIONS = 8;

export function compileRules(allRules: ReactionRule[]): CompiledRuleSet {
  // Group rules by material
  const byMaterial: ReactionRule[][] = new Array(MAX_MATERIAL + 1);
  allRules.forEach((rule) => {
    if (!byMaterial[rule.material]) byMaterial[rule.material] = [];
    byMaterial[rule.material].push(rule);
  });

  const ruleIndices = new Int32Array(MAX_MATERIAL + 1).fill(-1);
  const ruleCounts = new Uint8Array(MAX_MATERIAL + 1);
  const compiled: CompiledRule[] = [];

  let cursor = 0;
  for (let mat = 0; mat <= MAX_MATERIAL; mat++) {
    const rules = byMaterial[mat];
    if (!rules || rules.length === 0) continue;
    // Sort by priority (lower = higher priority)
    rules.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    ruleIndices[mat] = cursor;
    ruleCounts[mat] = rules.length;
    rules.forEach((rule) => {
      compiled.push(compileRule(rule));
      cursor++;
    });
  }

  return { ruleIndices, ruleCounts, rules: compiled };
}

function compileRule(rule: ReactionRule): CompiledRule {
  const neighborReqs = rule.requireNeighbors ?? [];
  const nc = Math.min(neighborReqs.length, MAX_NEIGHBORS);
  const actions = rule.actions;
  const ac = Math.min(actions.length, MAX_ACTIONS);

  const neighborDirs = new Uint8Array(MAX_NEIGHBORS);
  const neighborMatchKind = new Uint8Array(MAX_NEIGHBORS);
  const neighborMatchValue = new Uint32Array(MAX_NEIGHBORS);
  const neighborMinCount = new Uint8Array(MAX_NEIGHBORS);

  for (let i = 0; i < nc; i++) {
    const req = neighborReqs[i];
    neighborDirs[i] = req.directions;
    neighborMinCount[i] = req.minCount ?? 1;
    switch (req.match.kind) {
      case "material": neighborMatchKind[i] = 0; neighborMatchValue[i] = req.match.mat; break;
      case "material_class": neighborMatchKind[i] = 1; neighborMatchValue[i] = req.match.flag; break;
      case "is_hot": neighborMatchKind[i] = 2; break;
      case "is_fire": neighborMatchKind[i] = 3; break;
      case "is_cold": neighborMatchKind[i] = 6; break;
      case "not_material": neighborMatchKind[i] = 4; neighborMatchValue[i] = req.match.mat; break;
      case "not_wall": neighborMatchKind[i] = 5; break;
    }
  }

  const actionTypes = new Uint8Array(MAX_ACTIONS);
  const actionMat = new Uint32Array(MAX_ACTIONS);
  const actionLifetime = new Uint32Array(MAX_ACTIONS);
  const actionRadius = new Uint32Array(MAX_ACTIONS);
  const actionStrength = new Float32Array(MAX_ACTIONS);
  const actionMatchKind = new Uint8Array(MAX_ACTIONS);
  const actionMatchValue = new Uint32Array(MAX_ACTIONS);

  for (let i = 0; i < ac; i++) {
    const action = actions[i];
    switch (action.type) {
      case "transform_self":
        actionTypes[i] = 0; actionMat[i] = action.mat; actionLifetime[i] = action.lifetime ?? 0; break;
      case "transform_neighbor":
        actionTypes[i] = 1; actionMat[i] = action.mat; actionLifetime[i] = action.lifetime ?? 0;
        setMatch(action.match, i, actionMatchKind, actionMatchValue); break;
      case "transform_first_matching_neighbor":
        actionTypes[i] = 2; actionMat[i] = action.mat; actionLifetime[i] = action.lifetime ?? 0;
        setMatch(action.match, i, actionMatchKind, actionMatchValue); break;
      case "clear_self":
        actionTypes[i] = 3; break;
      case "clear_neighbor":
        actionTypes[i] = 4; setMatch(action.match, i, actionMatchKind, actionMatchValue); break;
      case "explode":
        actionTypes[i] = 5; actionRadius[i] = action.radius; break;
      case "impulse":
        actionTypes[i] = 6; actionRadius[i] = action.radius; actionStrength[i] = action.strength; break;
    }
  }

  return {
    hasChance: rule.chance !== undefined,
    chance: rule.chance ?? 1,
    minTemp: rule.minTemp ?? -Infinity,
    maxTemp: rule.maxTemp ?? Infinity,
    neighborCount: nc,
    neighborDirs, neighborMatchKind, neighborMatchValue, neighborMinCount,
    actionCount: ac,
    actionTypes, actionMat, actionLifetime, actionRadius, actionStrength,
    actionMatchKind, actionMatchValue,
  };
}

function setMatch(
  match: ReactionRule["actions"][0] extends infer A
    ? A extends { match: infer M } ? M : never : never,
  i: number,
  kinds: Uint8Array,
  values: Uint32Array,
): void {
  if (!match) return;
  switch (match.kind) {
    case "material": kinds[i] = 0; values[i] = match.mat; break;
    case "material_class": kinds[i] = 1; values[i] = match.flag; break;
    case "is_hot": kinds[i] = 2; break;
    case "is_fire": kinds[i] = 3; break;
    case "is_cold": kinds[i] = 6; break;
    case "not_material": kinds[i] = 4; values[i] = match.mat; break;
    case "not_wall": kinds[i] = 5; break;
  }
}
