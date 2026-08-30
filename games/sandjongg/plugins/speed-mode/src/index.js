// ============================================================================
// sandjongg-speed-mode — QuickJS plugin entry (script tier)
//
// This file runs inside a QuickJS WASM VM. It defines a `register` function
// that the host calls with the `ddPlugin` bridged global. It uses:
//   - ddPlugin.events: subscribe to "sandjongg:tile_matched" + publish
//     "sandjongg:speed_mode_activated" / "sandjongg:speed_mode_expired".
//   - ddPlugin.state: track speed mode timer + boost multiplier.
//   - ddPlugin.tick: count down the speed mode duration.
//   - ddPlugin.log: log activation/expiration.
//   - ddPlugin.onDispose: cleanup.
//
// The plugin doubles the score for each tile match while speed mode is active.
// It activates when the game publishes "sandjongg:activate_speed_mode".
// ============================================================================

function register(dd) {
  var SPEED_DURATION_SEC = 30;
  var SCORE_MULTIPLIER = 2;
  var active = false;
  var remainingSec = 0;

  // Load persisted state.
  var savedActive = dd.state.get("speedModeActive");
  if (savedActive) {
    active = true;
    remainingSec = dd.state.get("speedModeRemaining") || 0;
  }

  // Subscribe to tile match events to apply the score boost.
  dd.events.subscribe("sandjongg:tile_matched", function(data) {
    if (!active) return;
    // Publish a boosted score event so the game can update its display.
    dd.events.publish("sandjongg:score_boosted", {
      originalScore: data.score,
      boostedScore: data.score * SCORE_MULTIPLIER,
      multiplier: SCORE_MULTIPLIER,
    });
  });

  // Subscribe to activation events.
  dd.events.subscribe("sandjongg:activate_speed_mode", function(_data) {
    if (active) return;
    active = true;
    remainingSec = SPEED_DURATION_SEC;
    dd.state.set("speedModeActive", true);
    dd.state.set("speedModeRemaining", remainingSec);
    dd.log.info("Speed mode activated! Double score for " + SPEED_DURATION_SEC + "s.");
    dd.events.publish("sandjongg:speed_mode_activated", {
      duration: SPEED_DURATION_SEC,
      multiplier: SCORE_MULTIPLIER,
    });
  });

  // Tick to count down the speed mode duration.
  dd.tick.onTick(function(dt, _elapsedTime) {
    if (!active) return;
    remainingSec -= dt;
    dd.state.set("speedModeRemaining", remainingSec);
    if (remainingSec <= 0) {
      active = false;
      remainingSec = 0;
      dd.state.set("speedModeActive", false);
      dd.state.set("speedModeRemaining", 0);
      dd.log.info("Speed mode expired.");
      dd.events.publish("sandjongg:speed_mode_expired", {});
    }
  });

  // Cleanup on unload.
  dd.onDispose(function() {
    dd.log.debug("Speed mode plugin unloading.");
  });

  dd.log.info("Speed mode plugin registered. Listening for activation events.");
}
