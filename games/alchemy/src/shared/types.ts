// ============================================================================
// Alchemy game shared types
// ============================================================================

export interface InputState {
  mouseDown: boolean;
  mouseRight: boolean;
  mouseX: number;
  mouseY: number;
  lastMouseX: number;
  lastMouseY: number;
  hasLastMouse: boolean;
  selectedMaterial: number;
  brushRadius: number;
}

// --- Effect system types ---

export type EffectDimension =
  | "toxic" | "corrosive" | "healing" | "luminous" | "volatile"
  | "reactive" | "dense" | "ethereal" | "thermal" | "necrotic"
  | "psychic" | "kinetic";

export type EffectVector = Record<EffectDimension, number>;

export interface PotionProperties {
  acidity: number;      // 0..1 (corrosive)
  basicity: number;     // 0..1 (inverse of acidic)
  viscosity: number;    // 0..1 (dense)
  glow: number;         // 0..1 (luminous)
  color: [number, number, number]; // RGB 0..1
  aura: number;         // 0..1 (ethereal + psychic)
  sparkle: number;      // 0..1 (volatile + kinetic)
}

export interface Effect {
  id: string;
  name: string;
  description: string;
  /** Predicate over the effect vector — returns true if this effect is active. */
  predicate: (vec: EffectVector) => boolean;
}

export interface Potion {
  id: string;
  name: string;
  properties: PotionProperties;
  effects: string[];        // effect ids
  effectVector: EffectVector;
  color: [number, number, number];
  ingredientsUsed: { mat: number; count: number }[];
  processHistory: ProcessStep[];
  createdAt: number;
}

export type ProcessStep = "heat" | "cool" | "settle";

// --- Recipe types ---

export interface Recipe {
  id: string;
  name: string;
  tier: number;
  ingredients: { mat: number; ratio: number }[]; // ratio is relative weight
  process: ProcessStep[];
  expectedEffects: string[];
  expectedResultVector: EffectVector;
  tolerance: number; // per-dimension tolerance for matching
  description: string;
}

// --- Ingredient / shop types ---

export type PackageType = "flask" | "test-tube" | "canteen" | "box" | "vial" | "sack";

export interface IngredientInfo {
  mat: number;
  name: string;
  tier: number;
  packageType: PackageType;
  doseSize: number;       // cells painted per dose
  dosePrice: number;      // money per dose
  effectVector: EffectVector;
  color: [number, number, number]; // RGB 0..1 for UI swatches
}

export interface UnlockTier {
  tier: number;
  name: string;
  unlockCost: number;
  ingredients: number[]; // material IDs
}

// --- Visitor types ---

export interface VisitorTemplate {
  id: string;
  name: string;
  face: string;           // emoji or ascii face
  requestFlavor: string[]; // multi-line dark-humor dialog
  desiredEffects: string[]; // effect ids the visitor wants
  budgetRange: [number, number];
  moodRange: [number, number]; // 0..1
  patienceSec: [number, number];
}

export interface Visitor {
  id: string;
  templateId: string;
  name: string;
  face: string;
  requestFlavor: string[];
  desiredEffects: string[];
  budget: number;
  mood: number;          // 0..1
  patienceSec: number;
  arrivedAt: number;     // timestamp
}

export interface VisitorOfferResult {
  matchScore: number;    // 0..1
  basePayout: number;
  moodMultiplier: number;
  finalPayout: number;
  responseLines: string[];
  accepted: boolean;
}

// --- Inventory ---

export interface IngredientInventory {
  mat: number;
  count: number; // doses
}

export interface SaveMetadata {
  id: string;
  name: string;
  timestamp: number;
  thumbnailUrl: string;
  gridW: number;
  gridH: number;
}
