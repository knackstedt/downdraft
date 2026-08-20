// ============================================================================
// Rule engine — evaluates compiled rules for each active cell.
//
// Replaces applyReactions() with a data-driven dispatch. The engine iterates
// the active-cell list, looks up rules for each material, evaluates conditions,
// and executes actions.
//
// Complex reactions from applySpecialReactions() are handled as custom
// material-specific handlers that run after the data-driven rules. This allows
// gradual migration — simple reactions move to the rule system, complex ones
// stay as optimized code.
// ============================================================================

import {
    packCell
} from "../cell";
import {
    IS_FIRE,
    IS_HOT,
    MAT_FLAGS,
    MAT_LIFETIME,
    Material
} from "../materials";
import type { SandWorld } from "../sand-world";
import { builtinRules } from "./builtin-rules";
import { compileRules, type CompiledRule, type CompiledRuleSet } from "./rule-compiler";

// Direction offsets for the 8 neighbors, indexed by DIR bitmask bit position.
// Bit 0 = N (0,-1), Bit 1 = S (0,+1), Bit 2 = E (+1,0), Bit 3 = W (-1,0),
// Bit 4 = NE (+1,-1), Bit 5 = NW (-1,-1), Bit 6 = SE (+1,+1), Bit 7 = SW (-1,+1)
const DIR_DX = [0, 0, 1, -1, 1, -1, 1, -1];
const DIR_DY = [-1, 1, 0, 0, -1, -1, 1, 1];

export class RuleEngine {
  private compiled: CompiledRuleSet;

  constructor() {
    this.compiled = compileRules(builtinRules);
  }

  /**
   * Execute data-driven rules for all active cells.
   * Replaces SandWorld.applyReactions().
   */
  execute(world: SandWorld): void {
    const W = world.W, H = world.H;
    const grid = world.grid;
    const fields = world.fields;
    const active = world.getActiveCells();
    const count = world.getActiveCount();
    const rng = world.getRng();
    const compiled = this.compiled;
    const rules = compiled.rules;
    const ruleIndices = compiled.ruleIndices;
    const ruleCounts = compiled.ruleCounts;

    for (let a = 0; a < count; a++) {
      const idx = active[a];
      const packed = grid[idx];
      if (packed === 0) continue;

      const mat = packed & 0xff;
      if (mat === Material.Empty) continue;

      // Look up rules for this material
      const ruleStart = ruleIndices[mat];
      if (ruleStart < 0) continue;
      const ruleCount = ruleCounts[mat];

      const fi = idx * 4;
      const temp = fields[fi + 1] / 128; // FIELD.TEMP = 1
      const x = idx % W;
      const y = (idx / W) | 0;

      for (let r = 0; r < ruleCount; r++) {
        const rule = rules[ruleStart + r];

        // Check temperature bounds
        if (temp < rule.minTemp || temp > rule.maxTemp) continue;

        // Check chance gate
        if (rule.hasChance && rng.random() >= rule.chance) continue;

        // Check neighbor requirements
        if (rule.neighborCount > 0) {
          if (!checkNeighbors(rule, grid, W, H, x, y)) continue;
        }

        // Execute actions
        executeActions(rule, world, grid, W, H, x, y, idx, mat, rng);
        break; // only one rule fires per cell per frame
      }
    }
  }
}

/** Check all neighbor requirements for a rule. */
function checkNeighbors(rule: CompiledRule, grid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
  for (let n = 0; n < rule.neighborCount; n++) {
    const dirs = rule.neighborDirs[n];
    const matchKind = rule.neighborMatchKind[n];
    const matchValue = rule.neighborMatchValue[n];
    const minCount = rule.neighborMinCount[n];

    let found = 0;
    // Check each direction in the bitmask
    for (let d = 0; d < 8; d++) {
      if (!(dirs & (1 << d))) continue;
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nMat = grid[ny * W + nx] & 0xff;
      if (matchNeighbor(matchKind, matchValue, nMat)) {
        found++;
        if (found >= minCount) break;
      }
    }
    if (found < minCount) return false;
  }
  return true;
}

/** Check if a neighbor material matches the requirement. */
function matchNeighbor(kind: number, value: number, nMat: number): boolean {
  switch (kind) {
    case 0: return nMat === value;          // material
    case 1: return (MAT_FLAGS[nMat] & value) !== 0;  // material_class
    case 2: return IS_HOT[nMat] !== 0;      // is_hot
    case 3: return IS_FIRE[nMat] !== 0;     // is_fire
    case 4: return nMat !== value;          // not_material
    case 5: return nMat !== Material.Wall;  // not_wall
    default: return false;
  }
}

/** Execute all actions for a rule. */
function executeActions(
  rule: CompiledRule,
  world: SandWorld,
  grid: Uint32Array,
  W: number, H: number,
  x: number, y: number,
  idx: number,
  mat: number,
  rng: { randomShade(): number; random(): number },
): void {
  // Write bounds for strip mode — neighbor transforms that would write
  // outside the strip are skipped (the coordinator's boundary cleanup
  // handles them). Self transforms are always safe (the cell is in the strip).
  const writeXMin = world.writeXMin;
  const writeXMax = world.writeXMax;
  for (let i = 0; i < rule.actionCount; i++) {
    const type = rule.actionTypes[i];
    switch (type) {
      case 0: { // transform_self
        const newMat = rule.actionMat[i];
        const lt = rule.actionLifetime[i] || MAT_LIFETIME[newMat];
        grid[idx] = packCell(newMat, lt, rng.randomShade());
        break;
      }
      case 1: { // transform_neighbor (all matching neighbors)
        const newMat = rule.actionMat[i];
        const lt = rule.actionLifetime[i] || MAT_LIFETIME[newMat];
        const mk = rule.actionMatchKind[i];
        const mv = rule.actionMatchValue[i];
        for (let d = 0; d < 8; d++) {
          const nx = x + DIR_DX[d];
          const ny = y + DIR_DY[d];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < writeXMin || nx >= writeXMax) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (matchNeighbor(mk, mv, nMat)) {
            grid[ni] = packCell(newMat, lt, rng.randomShade());
          }
        }
        break;
      }
      case 2: { // transform_first_matching_neighbor
        const newMat = rule.actionMat[i];
        const lt = rule.actionLifetime[i] || MAT_LIFETIME[newMat];
        const mk = rule.actionMatchKind[i];
        const mv = rule.actionMatchValue[i];
        for (let d = 0; d < 8; d++) {
          const nx = x + DIR_DX[d];
          const ny = y + DIR_DY[d];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < writeXMin || nx >= writeXMax) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (matchNeighbor(mk, mv, nMat)) {
            grid[ni] = packCell(newMat, lt, rng.randomShade());
            break;
          }
        }
        break;
      }
      case 3: { // clear_self
        grid[idx] = 0;
        break;
      }
      case 4: { // clear_neighbor
        const mk = rule.actionMatchKind[i];
        const mv = rule.actionMatchValue[i];
        for (let d = 0; d < 8; d++) {
          const nx = x + DIR_DX[d];
          const ny = y + DIR_DY[d];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          if (nx < writeXMin || nx >= writeXMax) continue;
          const ni = ny * W + nx;
          const nMat = grid[ni] & 0xff;
          if (matchNeighbor(mk, mv, nMat)) {
            grid[ni] = 0;
          }
        }
        break;
      }
      case 5: { // explode
        // Delegate to world's explode method via reflection
        (world as any).explode(x, y, rule.actionRadius[i]);
        break;
      }
      case 6: { // impulse
        (world as any).applyImpulse(x, y, rule.actionRadius[i], rule.actionStrength[i]);
        break;
      }
    }
  }
}
