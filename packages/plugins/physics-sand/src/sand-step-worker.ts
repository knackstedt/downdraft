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

import { SandWorld } from "./sand-world";

let world: SandWorld | null = null;
let stripStartX = 0;
let stripEndX = 0;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      world = new SandWorld(msg.W, msg.H, {
        sab: msg.sab,
        gridOffset: msg.gridOffset,
        fieldsOffset: msg.fieldsOffset,
        skipMaskOffset: msg.skipMaskOffset,
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
