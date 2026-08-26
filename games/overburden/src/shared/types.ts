// ============================================================================
// Overburden — shared type definitions
// Used by both the simulation worker and the renderer.
// ============================================================================


// --- Block definition ---
export interface BlockDef {
  id: number;
  name: string;
  category: BlockCategory;
  hardness: number; // mining resistance (0 = instant, 100 = bedrock)
  color: [number, number, number]; // RGB 0-255 (palette color)
  textureVariant: number; // 0-31, indexes into texture atlas
  lightEmit: number; // 0-15 (torches, lava, glow)
  lightColor: [number, number, number]; // RGB 0-255 (emitter color; [0,0,0] for non-emitters)
  conductive: boolean; // passes electricity
  climbable: boolean; // ladder, rope
  flammable: boolean;
  fuelValue: number; // 0 = not fuel, 1-5 = fuel slots
  liquidFlow: number; // 0 = solid, 1-7 = flow level (for CA fluids)
  drops: BlockDrop[];
  placeable: boolean; // can player place this block?
  backwallProjection: boolean; // does this block project a backwall behind it?
  isStation: boolean; // is this a crafting surface?
  stationType?: CraftStation; // linked recipe station (if isStation)
  /** Light passes through this block without being blocked (bushes, glass, ...).
   *  When true, the volumetric light sim treats the cell as non-opaque and uses
   *  air attenuation when spreading light into it, even if category is solid/special. */
  lightPasses?: boolean;
}

export type BlockCategory = "solid" | "liquid" | "gas" | "backwall" | "special";

// --- Crafting station types ---
// Defined here (not in recipes.ts) to avoid a circular import:
// block-registry.ts imports types.ts for BlockDef, and BlockDef.stationType
// references CraftStation. recipes.ts re-exports this from types.ts.
export type CraftStation =
  | "hand"
  | "workbench"
  | "craft_bench"
  | "tool_bench"
  | "woodwork_bench"
  | "campfire"
  | "kiln"
  | "furnace"
  | "metalwork_bench"
  | "builder_bench"
  | "tailor_bench"
  | "compost_bin";

export interface BlockDrop {
  itemId: string;
  count: number;
  chance: number; // 0-1
}

// --- Chunk data structure ---
// Each chunk stores 6 planes + light + explored flag.
// The 6 planes are: foreground, background, mask, vfx, (sky is global, not per-cell).
// Light is stored per-cell but is separate from the 6 planes.
export interface Chunk {
  cx: number; // chunk X coordinate (0 to CHUNKS_X-1)
  cy: number; // chunk Y coordinate (0 to CHUNKS_Y-1)
  // 6 planes (each is CHUNK_CELLS long):
  foreground: Uint16Array; // block ID (0=air, 1+=solid/liquid)
  background: Uint16Array; // backwall block ID (0=none)
  mask: Uint8Array; // bit flags (MASK_SOLID | MASK_CLIMBABLE | ...)
  vfx: Uint32Array; // packed particle/effect data
  light: Uint8Array; // per-cell RGBA8 light (R,G,B,A per cell; 4 * CHUNK_CELLS bytes)
  explored: Uint8Array; // 1 = explored by blockhead (fog of war)
  // Metadata:
  generated: boolean; // has terrain + trees + features been generated?
  terrainGenerated: boolean; // has the base terrain (fg + bg) been generated?
  active: boolean; // is this chunk in the active grid?
  dirty: boolean; // has data changed since last render?
}

// --- Blockhead entity state ---
export interface BlockheadState {
  id: number; // unique blockhead ID
  x: number; // world X (float, sub-block precision)
  y: number; // world Y (float)
  vx: number; // velocity X
  vy: number; // velocity Y
  facing: number; // 1 = right, -1 = left
  onGround: boolean;
  // 6 attribute bars (0-100):
  health: number;
  happiness: number;
  hunger: number;
  energy: number;
  environment: number;
  air: number;
  // Animation:
  animState: BlockheadAnimState;
  animTime: number; // seconds in current animation
  // Mantle state: when active, the blockhead is smoothly vaulting onto a ledge
  mantleActive: boolean;
  mantleTime: number;     // 0..1 progress
  mantleFromX: number;
  mantleFromY: number;
  mantleToX: number;
  mantleToY: number;
  // Wall climbing state: true when the blockhead is actively climbing or
  // holding onto a wall. Used to distinguish "released climb → hold position"
  // from "walked off a ledge near a wall → fall normally".
  wallClimbing: boolean;
  // Inventory + tasks are stored separately (not in SAB)
}

export type BlockheadAnimState =
  | "idle"
  | "walk"
  | "dig"
  | "chop"
  | "sleep"
  | "swim"
  | "climb"
  | "fall";

// --- Task queue ---
export type TaskType =
  | "MOVE_TO"
  | "MINE_BLOCK"
  | "PLACE_BLOCK"
  | "CHOP_TREE"
  | "CRAFT_AT"
  | "COLLECT_ITEM"
  | "EAT"
  | "SLEEP"
  | "FISH"
  | "PLANT"
  | "BUILD_STRUCTURE";

export interface TaskEntry {
  type: TaskType;
  targetX: number;
  targetY: number;
  // Task-specific data:
  blockId?: number; // for PLACE_BLOCK
  recipeId?: string; // for CRAFT_AT
  itemId?: string; // for COLLECT_ITEM
  // Execution state:
  status: TaskStatus;
  path?: number[]; // packed path (x1,y1,x2,y2,...) from pathfinding
  pathIndex?: number;
}

export type TaskStatus = "pending" | "pathing" | "moving" | "executing" | "done" | "failed";

// --- Sim worker RPC protocol ---
export type SimRpcMethod =
  | "init"
  | "pause"
  | "resume"
  | "step"
  | "shutdown"
  | "setFocus" // set focused blockhead (for active grid centering)
  | "getStats"
  | "setBlock" // set a block at (x, y) — for editing
  | "getBlock"; // get a block at (x, y) — for inspection

export interface SimRpcRequest {
  method: SimRpcMethod;
  params: Record<string, unknown>;
}

export interface SimRpcResponse {
  result?: unknown;
  error?: string;
}

export interface SimStats {
  tick: number;
  loadedChunks: number;
  activeChunks: number;
  frozenChunks: number;
  blockheadCount: number;
}

// --- SAB (SharedArrayBuffer) layout ---
// The SAB is used to transfer grid data + blockhead state from the sim worker
// to the renderer without copying. The renderer reads from the SAB each frame.
export interface SabLayout {
  // Header (fixed size):
  buffer: ArrayBuffer;
  tick: Uint32Array; // [0] = current tick
  activeGridX: Int32Array; // [0] = active grid center chunk X
  activeGridY: Int32Array; // [0] = active grid center chunk Y
  blockheadCount: Uint32Array; // [0] = number of blockheads
  // Grid data (active grid only):
  // The active grid is (2*R+1) × (2*R+1) chunks.
  // Each chunk's planes are stored contiguously.
  gridForeground: Uint16Array; // [chunkIndex * CHUNK_CELLS + cellIndex]
  gridBackground: Uint16Array;
  gridLight: Uint8Array;
  // Blockhead state (fixed max):
  blockheadData: Float32Array; // [bhIndex * BH_STRIDE + offset]
}

// --- SAB blockhead stride ---
// Floats per blockhead in the SAB blockhead region:
//   0: x, 1: y, 2: vx, 3: vy, 4: facing, 5: onGround, 6: animFrame,
//   7: health, 8: hunger, 9: energy, 10: air, 11: happiness, 12: environment,
//   13: animState (encoded as int), 14: id, 15: wallClimbing (1/0)
export const BH_STRIDE = 16;
export const MAX_BLOCKHEADS = 32;

// --- Blockhead anim state encoding (for SAB transfer) ---
export const ANIM_IDLE = 0;
export const ANIM_WALK = 1;
export const ANIM_DIG = 2;
export const ANIM_CHOP = 3;
export const ANIM_SLEEP = 4;
export const ANIM_SWIM = 5;
export const ANIM_CLIMB = 6;
export const ANIM_FALL = 7;

export function animStateToCode(state: string): number {
  switch (state) {
    case "idle": return ANIM_IDLE;
    case "walk": return ANIM_WALK;
    case "dig": return ANIM_DIG;
    case "chop": return ANIM_CHOP;
    case "sleep": return ANIM_SLEEP;
    case "swim": return ANIM_SWIM;
    case "climb": return ANIM_CLIMB;
    case "fall": return ANIM_FALL;
    default: return ANIM_IDLE;
  }
}

export function animCodeToState(code: number): string {
  switch (code) {
    case ANIM_IDLE: return "idle";
    case ANIM_WALK: return "walk";
    case ANIM_DIG: return "dig";
    case ANIM_CHOP: return "chop";
    case ANIM_SLEEP: return "sleep";
    case ANIM_SWIM: return "swim";
    case ANIM_CLIMB: return "climb";
    case ANIM_FALL: return "fall";
    default: return "idle";
  }
}
