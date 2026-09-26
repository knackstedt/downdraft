// ============================================================================
// Sand step worker — processes one vertical strip of the sand grid per step.
//
// Spawned by SandStepPool (which runs inside the mining worker). Each sand-step
// worker shares the grid + fields via a SharedArrayBuffer and only writes to
// its assigned strip [stripStartX, stripEndX). Cross-strip writes are skipped
// by write guards in SandWorld; the coordinator's boundary cleanup pass
// handles them after all workers finish.
//
// Communication:
//   - init: { sab, gridOffset, fieldsOffset, W, H, stripStartX, stripEndX, frame }
//   - step: { frame } → processes one SandWorld.step() for this strip
//   - The worker responds with { done: true } when the step is complete.
//   - Atomics.wait/postMessage handshake for low-latency dispatch.
// ============================================================================

import { MAT_GRAVITY, MAT_GRAVITY_DIR, SandWorld } from "./sand-world";

// --- Gravity overrides for static materials ---
// Games can pass `gravityOverrides` in the init message to patch the gravity
// lookup tables for materials that are static by default (gravityDir=0) but
// need to fall in the game's context (e.g. Sandjongg's Ice/Plant/Fireflies).
// This runs in the sand-step worker thread, which has its own module instance
// separate from the game worker.
let gravityOverrides: { mat: number; gravityDir: number; gravity: number }[] | null = null;

function applyGravityOverrides(): void {
  if (!gravityOverrides) return;
  gravityOverrides.forEach((o) => {
    MAT_GRAVITY_DIR[o.mat] = o.gravityDir;
    if (o.gravity !== 0) MAT_GRAVITY[o.mat] = o.gravity;
  });
}

let world: SandWorld | null = null;
let stripStartX = 0;
let stripEndX = 0;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      // Apply gravity overrides before creating the SandWorld so the patched
      // tables are used from the first step.
      if (msg.gravityOverrides) {
        gravityOverrides = msg.gravityOverrides;
        applyGravityOverrides();
      }
      world = new SandWorld(msg.W, msg.H, {
        sab: msg.sab,
        gridOffset: msg.gridOffset,
        fieldsOffset: msg.fieldsOffset,
        skipMaskOffset: msg.skipMaskOffset,
        deferredMaskOffset: msg.deferredMaskOffset,
        histogramOffset: msg.histogramOffset,
        skipStoneFloor: true,
      });
      stripStartX = msg.stripStartX;
      stripEndX = msg.stripEndX;
      world.setStripBounds(stripStartX, stripEndX);
      // Copy preserveFlagsMask + disturbedFlags from the coordinator (game-specific).
      if (msg.preserveFlagsMask !== undefined) world.preserveFlagsMask = msg.preserveFlagsMask;
      if (msg.disturbedFlags !== undefined) world.disturbedFlags = msg.disturbedFlags;
      self.postMessage({ type: "ready" });
      break;
    }
    case "step": {
      if (!world) return;
      // Sync strip bounds (in case the coordinator rebalanced strips).
      if (msg.stripStartX !== undefined && msg.stripEndX !== undefined) {
        stripStartX = msg.stripStartX;
        stripEndX = msg.stripEndX;
        world.setStripBounds(stripStartX, stripEndX);
      }
      // Sync per-step config from coordinator.
      if (msg.interlaceEnabled !== undefined) world.interlaceEnabled = msg.interlaceEnabled;
      if (msg.interlaceScale !== undefined) world.interlaceScale = msg.interlaceScale;
      if (msg.horizontalImpulseChance !== undefined) world.horizontalImpulseChance = msg.horizontalImpulseChance;
      if (msg.horizontalImpulseStrength !== undefined) world.horizontalImpulseStrength = msg.horizontalImpulseStrength;
      // Set the frame number so interlace + fuse burn + C4 visited arrays work.
      world.frame = msg.frame;
      world.step();
      self.postMessage({ type: "done", activeCount: world.getActiveCount() });
      break;
    }
    case "setSkipMask": {
      // The skip mask is shared via SAB — the coordinator sets it directly.
      // This message is a no-op placeholder for future per-worker skip masks.
      break;
    }
    case "shutdown": {
      world = null;
      self.close();
      break;
    }
  }
};
