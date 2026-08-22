// ============================================================================
// Sandjongg elements — 12 elemental tile types, each mapping to a sand Material.
// ============================================================================

import { Material } from "@downdraft/library-sand";

export interface ElementDef {
  id: number;
  name: string;
  /** Display color (CSS). */
  color: string;
  /** Accent/glyph color (CSS). */
  glyphColor: string;
  /** Sand material to spawn when crumbled. */
  sandMaterial: number;
  /** Glyph identifier for procedural Canvas2D drawing. */
  glyph: string;
}

export const ELEMENTS: ElementDef[] = [
  { id: 0,  name: "Fire",      color: "#e8453a", glyphColor: "#ffce54", sandMaterial: Material.Lava,         glyph: "flame" },
  { id: 1,  name: "Water",     color: "#2d7df0", glyphColor: "#a8d8ff", sandMaterial: Material.Water,        glyph: "drop" },
  { id: 2,  name: "Earth",     color: "#8b6f47", glyphColor: "#c4a878", sandMaterial: Material.Dirt,         glyph: "mountain" },
  { id: 3,  name: "Air",       color: "#b0c8d8", glyphColor: "#ffffff", sandMaterial: Material.Steam,        glyph: "swirl" },
  { id: 4,  name: "Lightning", color: "#f0c020", glyphColor: "#ffffff", sandMaterial: Material.Plasma,       glyph: "bolt" },
  { id: 5,  name: "Ice",       color: "#6cb8e8", glyphColor: "#e0f0ff", sandMaterial: Material.Ice,          glyph: "snowflake" },
  { id: 6,  name: "Plant",     color: "#3aa856", glyphColor: "#a8e8a0", sandMaterial: Material.Plant,       glyph: "leaf" },
  { id: 7,  name: "Metal",     color: "#9098a0", glyphColor: "#d0d8e0", sandMaterial: Material.Iron,        glyph: "ingot" },
  { id: 8,  name: "Light",     color: "#f8d870", glyphColor: "#ffffff", sandMaterial: Material.Fireflies,    glyph: "sun" },
  { id: 9,  name: "Shadow",    color: "#2a1a3a", glyphColor: "#6a4a8a", sandMaterial: Material.LiquidShadow, glyph: "crescent" },
  { id: 10, name: "Acid",      color: "#8bd040", glyphColor: "#e0ffa0", sandMaterial: Material.Acid,        glyph: "bubble" },
  { id: 11, name: "Crystal",   color: "#c080f0", glyphColor: "#e8c8ff", sandMaterial: Material.StarShard,   glyph: "hexagon" },
];

export const NUM_ELEMENTS = ELEMENTS.length;

/** Get the sand material for an element id. */
export function elementToMaterial(elementId: number): number {
  return ELEMENTS[elementId]?.sandMaterial ?? Material.Empty;
}

/** Get the element definition by id. */
export function getElement(id: number): ElementDef {
  return ELEMENTS[id];
}
