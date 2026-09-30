// ============================================================================
// Button glyph naming — pad-type-aware labels for UI prompts.
// Returns `{ set, glyph }` where `set` identifies the icon family a UI
// toolkit should draw from ("xbox", "playstation", "switch", ...) and `glyph`
// is the key inside it ("a", "cross", "dpad-up", ...).
// ============================================================================

import { GP_BTN, PadType, type PadTypeValue } from "@downdraft/engine/sab/gamepad-devices";

export interface GlyphResult {
  set: string;
  glyph: string;
}

const FACE: Record<string, [string, string, string, string]> = {
  //            south    east    west    north
  xbox:        ["a",     "b",     "x",     "y"],
  playstation: ["cross", "circle", "square", "triangle"],
  switch:      ["b",     "a",     "y",     "x"],
  gamecube:    ["a",     "b",     "x",     "y"],
  n64:         ["a",     "b",     "c",     "c"],
  generic:     ["a",     "b",     "x",     "y"],
};

const COMMON: Record<number, string> = {
  [GP_BTN.LEFT_SHOULDER]: "lb",
  [GP_BTN.RIGHT_SHOULDER]: "rb",
  [GP_BTN.LEFT_TRIGGER_BTN]: "lt",
  [GP_BTN.RIGHT_TRIGGER_BTN]: "rt",
  [GP_BTN.SELECT]: "select",
  [GP_BTN.START]: "start",
  [GP_BTN.HOME]: "home",
  [GP_BTN.LEFT_STICK]: "l3",
  [GP_BTN.RIGHT_STICK]: "r3",
  [GP_BTN.DPAD_UP]: "dpad-up",
  [GP_BTN.DPAD_DOWN]: "dpad-down",
  [GP_BTN.DPAD_LEFT]: "dpad-left",
  [GP_BTN.DPAD_RIGHT]: "dpad-right",
  [GP_BTN.CAPTURE]: "capture",
};

function setForType(t: PadTypeValue): string {
  switch (t) {
    case PadType.PS3:
    case PadType.PS4:
    case PadType.PS5:
      return "playstation";
    case PadType.SWITCH:
      return "switch";
    case PadType.GAMECUBE:
      return "gamecube";
    case PadType.N64:
      return "n64";
    case PadType.WIIMOTE:
      return "wiimote";
    case PadType.XBOX:
    case PadType.STEAM:
    case PadType.GENERIC:
      return "xbox";
    default:
      return "generic";
  }
}

/** Glyph for a standard button bit on a pad of the given type. */
export function glyphFor(padType: PadTypeValue, bit: number): GlyphResult {
  const set = setForType(padType);
  if (bit >= GP_BTN.SOUTH && bit <= GP_BTN.NORTH) {
    const face = FACE[set] ?? FACE.generic;
    return { set, glyph: face[bit] };
  }
  const common = COMMON[bit];
  if (common) {
    // PlayStation names differ on shoulders/triggers/menu buttons.
    if (set === "playstation") {
      const ps: Record<string, string> = {
        lb: "l1", rb: "r1", lt: "l2", rt: "r2",
        select: "share", start: "options", home: "ps",
        l3: "l3", r3: "r3", capture: "share",
      };
      return { set, glyph: ps[common] ?? common };
    }
    if (set === "switch") {
      const sw: Record<string, string> = {
        lb: "l", rb: "r", lt: "zl", rt: "zr",
        select: "minus", start: "plus", home: "home", capture: "capture",
      };
      return { set, glyph: sw[common] ?? common };
    }
    return { set, glyph: common };
  }
  return { set, glyph: `btn-${bit}` };
}
