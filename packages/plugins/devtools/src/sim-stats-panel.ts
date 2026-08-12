// ============================================================================
// createSimStatsPanelExtension — reusable DevTools "Sim" tab for any game
// that implements ISimStatsProvider (exposed via __sceneInspector).
//
// Renders a stats grid (FPS, tick, frame, paused, speed + game-specific extra
// rows) and control buttons (Pause/Resume, Step, Clear) + a speed slider.
// The tab is gated by requiredMethods so it only appears for games that
// implement the provider.
// ============================================================================

import type { IDevToolsPanelExtension, ISimStats } from "./types";

export interface SimStatsPanelOptions {
  /** Tab label shown in the tab bar. Default: "Sim". */
  tabLabel?: string;
  /** Tab tooltip. Default: "Simulation stats & controls". */
  tabTooltip?: string;
  /** Order/priority for tab placement. Default: 50 (before game tabs at 100+). */
  order?: number;
  /**
   * Optional callback to append custom rows to the stats grid, given the
   * latest ISimStats snapshot. Returns an array of [label, value] pairs.
   * Values are stringified by the panel's debugGridHtml helper.
   */
  extraRows?: (stats: ISimStats) => [string, string][];
}

export function createSimStatsPanelExtension(opts: SimStatsPanelOptions = {}): IDevToolsPanelExtension {
  const tabLabel = opts.tabLabel ?? "Sim";
  const tabTooltip = opts.tabTooltip ?? "Simulation stats & controls";
  const order = opts.order ?? 50;
  const hasExtra = typeof opts.extraRows === "function";
  // The extraRows callback runs in the page context (renderer side), but the
  // panel script is sandboxed and can't see the TS closure. We serialize the
  // callback's source so it can be eval'd in-page alongside getSimStats().
  // If no extraRows is provided, the script skips the extra-rows section.
  const extraRowsSrc = hasExtra
    ? opts.extraRows!.toString()
    : "null";

  const html = `
<div class="panel-header">
  <h3>Simulation</h3>
  <span id="sim-status-badge" class="perf-status">Waiting for data...</span>
</div>
<div id="sim-stats-panel">
  <div class="debug-section">
    <h4>Stats</h4>
    <div id="sim-stats-grid" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>Controls</h4>
    <div class="world-control-row">
      <button id="btn-sim-pause" class="import-action-btn">Pause</button>
      <button id="btn-sim-step" class="import-action-btn" title="Advance one tick while paused">Step</button>
      <button id="btn-sim-clear" class="import-action-btn" title="Clear/reset the simulation">Clear</button>
    </div>
    <div class="world-control-row">
      <label>Speed <span id="sim-speed-display" style="color:#888;font-weight:normal">1.00x</span></label>
      <input type="range" id="sim-speed-slider" min="0" max="10" step="0.25" value="1" style="flex:1">
      <button id="btn-sim-speed-reset" class="import-action-btn">Reset</button>
    </div>
  </div>
</div>
`;

  const css = `
#sim-stats-panel {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}
#sim-stats-panel .debug-section {
  margin-bottom: 12px;
}
#sim-stats-panel .debug-section h4 {
  font-size: 12px;
  color: #569cd6;
  margin: 8px 0 4px 0;
  border-bottom: 1px solid #333;
  padding-bottom: 2px;
}
#sim-stats-panel .world-control-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
}
#sim-stats-panel .world-control-row label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #d4d4d4;
}
#sim-stats-panel .world-control-row input[type="range"] {
  accent-color: #0e639c;
  cursor: pointer;
}
#sim-stats-panel .import-action-btn {
  background: #0e639c;
  color: #fff;
  border: 1px solid #0e639c;
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 2px;
  cursor: pointer;
}
#sim-stats-panel .import-action-btn:hover {
  background: #1177bb;
}
#sim-stats-panel #btn-sim-clear {
  background: #5a1d1d;
  border-color: #5a1d1d;
}
#sim-stats-panel #btn-sim-clear:hover {
  background: #7a2828;
}
#sim-status-badge.paused {
  color: #e5c07b;
}
#sim-status-badge.running {
  color: #98c379;
}
`;

  // The script is sandbox-evaled with {document, console, panel} and uses
  // window.DevToolsPanel helpers (callInspector, evalInPage, escapeHtml,
  // fmtVal, debugGridHtml). It returns {onActivate, onRefresh, onDeactivate}.
  const script = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var evalInPage = DevToolsPanel.evalInPage;
  var escapeHtml = DevToolsPanel.escapeHtml;
  var fmtVal = DevToolsPanel.fmtVal;
  var debugGridHtml = DevToolsPanel.debugGridHtml;

  // extraRowsFn is serialized from the game's SimStatsPanelOptions.extraRows
  // callback. It runs in the PAGE context (not the sandbox) so it can access
  // the full ISimStats object returned by __sceneInspector.getSimStats().
  var extraRowsFn = ${extraRowsSrc};

  function refreshSimStats() {
    var gridEl = document.getElementById("sim-stats-grid");
    var statusEl = document.getElementById("sim-status-badge");
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getSimStats()) : null",
      function (result, err) {
        if (err || !result) {
          if (gridEl) gridEl.innerHTML = '<div class="debug-label">Not available</div>';
          if (statusEl) { statusEl.textContent = "Not available"; statusEl.className = "perf-status"; }
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s) {
            if (gridEl) gridEl.innerHTML = '<div class="debug-label">Not available</div>';
            return;
          }
          var rows = [
            ["FPS", fmtVal(s.fps, 0)],
            ["Tick", s.tick],
            ["Frame", s.frame],
            ["Paused", s.paused ? "Yes" : "No"],
            ["Speed", fmtVal(s.speed, 2) + "x"],
          ];
          if (extraRowsFn && s.extra) {
            try {
              var extra = extraRowsFn(s);
              if (extra && extra.length) {
                for (var i = 0; i < extra.length; i++) {
                  rows.push([extra[i][0], String(extra[i][1])]);
                }
              }
            } catch (e) {
              rows.push(["Extra error", escapeHtml(String(e))]);
            }
          }
          if (gridEl) gridEl.innerHTML = debugGridHtml(rows);
          if (statusEl) {
            statusEl.textContent = s.paused ? "Paused" : "Running";
            statusEl.className = "perf-status " + (s.paused ? "paused" : "running");
          }
          // Sync pause button label
          var pauseBtn = document.getElementById("btn-sim-pause");
          if (pauseBtn) pauseBtn.textContent = s.paused ? "Resume" : "Pause";
          // Sync speed slider/display (only if not focused — avoid clobbering user input)
          var slider = document.getElementById("sim-speed-slider");
          var display = document.getElementById("sim-speed-display");
          if (slider && document.activeElement !== slider) slider.value = s.speed;
          if (display) display.textContent = fmtVal(s.speed, 2) + "x";
        } catch (e) {
          if (gridEl) gridEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>';
        }
      }
    );
  }

  function setupControls() {
    var pauseBtn = document.getElementById("btn-sim-pause");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", function () {
        // Toggle based on current label to avoid race with refresh
        var isPaused = pauseBtn.textContent === "Resume";
        if (isPaused) {
          callInspector("resumeSim", null);
        } else {
          callInspector("pauseSim", null);
        }
        setTimeout(refreshSimStats, 50);
      });
    }
    var stepBtn = document.getElementById("btn-sim-step");
    if (stepBtn) {
      stepBtn.addEventListener("click", function () {
        callInspector("stepSim", null);
        setTimeout(refreshSimStats, 50);
      });
    }
    var clearBtn = document.getElementById("btn-sim-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        callInspector("clearSim", null);
        setTimeout(refreshSimStats, 50);
      });
    }
    var slider = document.getElementById("sim-speed-slider");
    var display = document.getElementById("sim-speed-display");
    if (slider) {
      slider.addEventListener("input", function () {
        var speed = parseFloat(slider.value);
        if (display) display.textContent = speed.toFixed(2) + "x";
      });
      slider.addEventListener("change", function () {
        var speed = parseFloat(slider.value);
        callInspector("setSimSpeed", [speed]);
      });
    }
    var resetBtn = document.getElementById("btn-sim-speed-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (slider) slider.value = 1;
        if (display) display.textContent = "1.00x";
        callInspector("setSimSpeed", [1]);
      });
    }
  }

  return {
    onActivate: function () {
      setupControls();
      // Initial refresh — onRefresh timer is started by the panel core
      refreshSimStats();
    },
    onRefresh: refreshSimStats,
    onDeactivate: function () {},
  };
})
`;

  return {
    id: "sim-stats",
    tabLabel,
    tabTooltip,
    order,
    requiredMethods: ["getSimStats", "pauseSim", "resumeSim"],
    html,
    css,
    script,
  };
}
