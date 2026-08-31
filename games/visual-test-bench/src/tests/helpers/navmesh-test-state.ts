// ============================================================================
// Navmesh test shared state + helpers
//
// Both navmesh tests (recast + legacy) share the same control state and
// auto-move logic. This keeps them in sync and reduces duplication.
// ============================================================================

import type { Vec3 } from "@downdraft/library-recast";
import { GROUND_HALF } from "./obstacle-scene";

// ── Shared control state (mutated by controls UI) ──

export let showMesh = true;
export let showPaths = true;
export let showObstacles = true;
let paused = false;
let agentSpeed = 3.5;

// Signals — set by button controls, consumed + cleared by the render loop.
let resetRequested = false;
let randomizeRequested = false;

export function getPaused(): boolean { return paused; }
export function getAgentSpeed(): number { return agentSpeed; }
export function isResetRequested(): boolean {
  if (resetRequested) { resetRequested = false; return true; }
  return false;
}
export function isRandomizeRequested(): boolean {
  if (randomizeRequested) { randomizeRequested = false; return true; }
  return false;
}

// ── Random point generation ──

/** Returns a random point within the navmesh bounds (ground plane ± obstacles). */
export function randomGroundPoint(): Vec3 {
  const margin = 3;
  const range = GROUND_HALF - margin;
  return [
    (Math.random() * 2 - 1) * range,
    0,
    (Math.random() * 2 - 1) * range,
  ];
}

// ── Shared control definitions ──

import type { TestControl } from "../../test-registry";

export function getNavmeshControls(): TestControl[] {
  return [
    { key: "play", label: paused ? "▶ Play" : "⏸ Pause", type: "button", value: false, onChange: () => { paused = !paused; } },
    { key: "reset", label: "↺ Reset", type: "button", value: false, onChange: () => { resetRequested = true; } },
    { key: "randomize", label: "🎲 Randomize", type: "button", value: false, onChange: () => { randomizeRequested = true; } },
    { key: "showMesh", label: "Show mesh", type: "checkbox", value: showMesh, onChange: (v) => { showMesh = v as boolean; } },
    { key: "showPaths", label: "Show paths", type: "checkbox", value: showPaths, onChange: (v) => { showPaths = v as boolean; } },
    { key: "showObstacles", label: "Show obstacles", type: "checkbox", value: showObstacles, onChange: (v) => { showObstacles = v as boolean; } },
    { key: "speed", label: "Agent speed", type: "slider", min: 1, max: 10, step: 0.5, value: agentSpeed, onChange: (v) => { agentSpeed = v as number; } },
  ];
}
