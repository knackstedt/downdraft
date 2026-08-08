// ============================================================================
// .ddmeta.json — Downdraft model import settings sidecar format
// ============================================================================
// Uses comment-json for JSON-with-comments support, making sidecars
// human-editable for artists. The format is a superset of JSON.
//

import { parse as commentParse, stringify as commentStringify } from "comment-json";
import type { ImportSettings, UnitSystem, UpAxis } from "./types";

/**
 * Parse a .ddmeta.json file (JSON with comments) into partial ImportSettings.
 * Returns null if the file is empty or invalid.
 */
export function parseDdmeta(jsonText: string): Partial<ImportSettings> | null {
  let parsed: unknown;
  try {
    parsed = commentParse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const result: Partial<ImportSettings> = {};

  if (typeof obj["upAxis"] === "string" && (obj["upAxis"] === "y" || obj["upAxis"] === "z")) {
    result.upAxis = obj["upAxis"] as UpAxis;
  }

  if (typeof obj["units"] === "string") {
    const u = obj["units"] as string;
    if (u === "meters" || u === "centimeters" || u === "inches" || u === "millimeters" || u === "units") {
      result.units = u as UnitSystem;
    }
  }

  if (typeof obj["scale"] === "number" && isFinite(obj["scale"])) {
    result.scale = obj["scale"];
  }

  if (Array.isArray(obj["rotation"]) && obj["rotation"].length === 4) {
    const r = obj["rotation"] as number[];
    if (r.every((v) => typeof v === "number" && isFinite(v))) {
      result.rotation = [r[0], r[1], r[2], r[3]] as [number, number, number, number];
    }
  }

  if (typeof obj["centerToOrigin"] === "boolean") {
    result.centerToOrigin = obj["centerToOrigin"];
  }

  if (obj["autoFit"] === null || typeof obj["autoFit"] === "number") {
    result.autoFit = obj["autoFit"] as number | null;
  }

  if (typeof obj["nodeTransforms"] === "string" && (obj["nodeTransforms"] === "apply" || obj["nodeTransforms"] === "ignore")) {
    result.nodeTransforms = obj["nodeTransforms"] as "apply" | "ignore";
  }

  return result;
}

/**
 * Serialize ImportSettings to a .ddmeta.json string with helpful comments.
 */
export function writeDdmeta(settings: ImportSettings): string {
  const obj = {
    upAxis: settings.upAxis,
    units: settings.units,
    scale: settings.scale,
    rotation: [...settings.rotation],
    centerToOrigin: settings.centerToOrigin,
    autoFit: settings.autoFit,
    nodeTransforms: settings.nodeTransforms,
  };
  return commentStringify(obj, null, 2);
}

/**
 * Create a starter .ddmeta.json with commented-out fields and parser-detected
 * defaults. Artists can uncomment and modify fields as needed.
 */
export function createDefaultDdmeta(
  _modelName: string,
  parserDefaults: Partial<ImportSettings>,
): string {
  const lines: string[] = [
    "{",
    `  // Downdraft model import settings for ${_modelName}`,
    "  // Uncomment and modify fields to override parser-detected defaults.",
    "",
    `  "upAxis": "${parserDefaults.upAxis ?? "y"}",  // "y" or "z" — source asset up-axis. Engine is Y-up.`,
    `  "units": "${parserDefaults.units ?? "meters"}",  // "meters" | "centimeters" | "inches" | "millimeters" | "units"`,
    "",
    "  // Additional scale multiplier (applied after unit conversion). Default: 1.0",
    `  "scale": ${parserDefaults.scale ?? 1.0},`,
    "",
    "  // Root pre-rotation quaternion [x, y, z, w]. Default: identity",
    `  "rotation": [${(parserDefaults.rotation ?? [0, 0, 0, 1]).join(", ")}],`,
    "",
    "  // Subtract bounding-box center to place model at origin. Default: false",
    `  "centerToOrigin": ${parserDefaults.centerToOrigin ?? false},`,
    "",
    "  // Auto-fit: null = off, or target max-dimension in meters (e.g. 2.0)",
    `  "autoFit": ${parserDefaults.autoFit === null ? "null" : parserDefaults.autoFit},`,
    "",
    '  // Node transform handling: "apply" = bake node hierarchy into vertices, "ignore" = raw mesh',
    `  "nodeTransforms": "${parserDefaults.nodeTransforms ?? "apply"}"`,
    "}",
  ];
  return lines.join("\n");
}
