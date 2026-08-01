// ============================================================================
// Game-specific DevTools panel extensions for to-the-ocean.
// These are declarative definitions that the core DevTools panel loads
// dynamically via __sceneInspector.getPanelExtensions() / getOverlayToggles().
// ============================================================================

import type { IDevToolsPanelExtension, IDevToolsOverlayToggle } from "@downdraft/plugin-devtools";

// --- Debug Info Panel ---

const debugInfoHtml = `
<div class="panel-header">
  <h3>Debug Info</h3>
</div>
<div id="debug-info-content">
  <div class="debug-section">
    <h4>Simulation Speed <span id="sim-speed-display" style="color:#888;font-weight:normal">1.00x</span></h4>
    <div class="world-control-row">
      <input type="range" id="sim-speed-slider" min="0" max="10" step="0.25" value="1" style="flex:1">
      <button id="btn-sim-speed-reset" class="import-action-btn">Reset</button>
    </div>
  </div>
  <div class="debug-section">
    <h4>Renderer Stats</h4>
    <div id="renderer-stats" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>World / Sim State</h4>
    <div id="sim-state" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>Physics</h4>
    <div id="physics-stats" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>Players</h4>
    <div id="player-stats"></div>
  </div>
</div>
`;

const debugInfoCss = `
#debug-info-panel {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}

#player-stats {
  font-size: 11px;
}

.player-card {
  border: 1px solid #333;
  border-radius: 3px;
  margin: 4px 0;
  padding: 6px 8px;
  background: #1a1a2e;
}

.player-card-header {
  font-weight: bold;
  color: #4ec9b0;
  margin-bottom: 4px;
  font-size: 12px;
}

.player-card .prop-group {
  margin-bottom: 6px;
}

.player-card .prop-group-title {
  font-size: 10px;
  color: #569cd6;
  margin-bottom: 2px;
  border-bottom: 1px solid #333;
  padding-bottom: 1px;
}

.player-card .prop-row {
  margin-bottom: 2px;
}

.player-card .prop-label {
  width: 60px;
  font-size: 10px;
}

.player-card input[type="number"] {
  font-size: 10px;
  padding: 1px 3px;
}

.player-flags {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.player-flag-badge {
  background: #3a1a1a;
  color: #f44747;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
}

.player-flag-badge.safe {
  background: #1a3a1a;
  color: #6a9955;
}

.world-control-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
}

.world-control-row label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #d4d4d4;
}

.world-control-row input[type="number"] {
  width: 70px;
  padding: 2px 6px;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  color: #dcdcaa;
  font-family: monospace;
  font-size: 11px;
  border-radius: 2px;
}

.world-control-row select {
  padding: 2px 6px;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  color: #d4d4d4;
  font-size: 11px;
  border-radius: 2px;
  cursor: pointer;
}

.world-control-row input[type="range"] {
  accent-color: #0e639c;
  cursor: pointer;
}
`;

const debugInfoScript = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var evalInPage = DevToolsPanel.evalInPage;
  var escapeHtml = DevToolsPanel.escapeHtml;
  var fmtVal = DevToolsPanel.fmtVal;
  var fmtVec3 = DevToolsPanel.fmtVec3;
  var debugGridHtml = DevToolsPanel.debugGridHtml;

  var CAMERA_MODES = { 0: "FirstPerson", 1: "ThirdPerson", 2: "FreeCam" };

  function refreshDebugInfo() {
    var rendererStatsEl = document.getElementById("renderer-stats");
    var simStateEl = document.getElementById("sim-state");
    var physicsStatsEl = document.getElementById("physics-stats");
    var playerStatsEl = document.getElementById("player-stats");

    // Renderer stats
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getRendererStats()) : null",
      function (result, err) {
        if (err || !result) { if (rendererStatsEl) rendererStatsEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
        try {
          var s = JSON.parse(result);
          if (!s) { if (rendererStatsEl) rendererStatsEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
          var rows = [
            ["FPS", fmtVal(s.fps, 0)], ["Tick", s.tick],
            ["Entities", s.entityCount], ["Players", s.playerCount],
            ["Canvas", s.canvasW + "x" + s.canvasH],
            ["Viewport", s.viewportW + "x" + s.viewportH],
            ["Water Valid", s.waterValid ? "Yes" : "No"],
            ["Water Grid", s.waterGrid],
            ["Player Pos", fmtVec3(s.playerPos, 1)],
            ["Heading", fmtVal(s.heading, 2)], ["Pitch", fmtVal(s.pitch, 2)],
            ["Camera Mode", CAMERA_MODES[s.cameraMode] || s.cameraMode],
            ["Keys", s.keys || "—"],
          ];
          if (rendererStatsEl) rendererStatsEl.innerHTML = debugGridHtml(rows);
        } catch (e) { if (rendererStatsEl) rendererStatsEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>'; }
      }
    );

    // Sim state
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getSimState()) : null",
      function (result, err) {
        if (err || !result) { if (simStateEl) simStateEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
        try {
          var s = JSON.parse(result);
          if (!s) { if (simStateEl) simStateEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
          var rows = [
            ["Tick", s.tick],
            ["Time of Day", s.timeStr + " (" + fmtVal(s.timeOfDay, 3) + ")"],
            ["Weather", s.weatherName + " (" + fmtVal(s.weatherIntensity, 2) + ")"],
            ["Wind Speed", fmtVal(s.windSpeed, 1) + " m/s"],
            ["Wind Dir", "(" + fmtVal(s.windDirX, 2) + ", " + fmtVal(s.windDirZ, 2) + ")"],
            ["Visibility", fmtVal(s.visibility, 1)],
            ["Ambient Temp", fmtVal(s.ambientTemp, 1) + "°C"],
            ["Active Players", "0x" + s.activePlayers.toString(16)],
            ["Gamemode", s.gamemode],
            ["Entity Count", s.entityCount],
            ["Player Count", s.playerCount],
            ["Chunk Count", s.chunkCount],
          ];
          if (simStateEl) simStateEl.innerHTML = debugGridHtml(rows);
        } catch (e) { if (simStateEl) simStateEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>'; }
      }
    );

    // Physics stats
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getPhysicsStats()) : null",
      function (result, err) {
        if (err || !result) { if (physicsStatsEl) physicsStatsEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
        try {
          var s = JSON.parse(result);
          if (!s) { if (physicsStatsEl) physicsStatsEl.innerHTML = '<div class="debug-label">Not available</div>'; return; }
          var rows = [
            ["Initialized", s.initialized ? "Yes" : "No"],
            ["Failed", s.failed ? "Yes" : "No"],
            ["Body Count", s.bodyCount],
            ["Physics Tick", s.tickCount],
          ];
          if (physicsStatsEl) physicsStatsEl.innerHTML = debugGridHtml(rows);
        } catch (e) { if (physicsStatsEl) physicsStatsEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>'; }
      }
    );

    // Player stats
    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getPlayerStats()) : null",
      function (result, err) {
        if (err || !result) { if (playerStatsEl) playerStatsEl.innerHTML = '<p class="empty-state">Not available</p>'; return; }
        try {
          var s = JSON.parse(result);
          if (!s || !s.players || s.players.length === 0) {
            if (playerStatsEl) playerStatsEl.innerHTML = '<p class="empty-state">No players</p>';
            return;
          }
          var html = "";
          for (var i = 0; i < s.players.length; i++) {
            var p = s.players[i];
            html += '<div class="player-card">';
            html += '<div class="player-card-header">Player ' + i + ' (slot ' + p.slot + ')</div>';

            html += '<div class="prop-group"><div class="prop-group-title">Position <span style="color:#888;font-size:9px">(sim-controlled)</span></div>';
            html += '<div class="prop-row"><span class="prop-label">Pos</span><div class="prop-value"><div class="vec3-input">';
            html += '<span class="axis-label">X</span><input type="number" step="0.1" value="' + p.position[0].toFixed(1) + '" disabled>';
            html += '<span class="axis-label">Y</span><input type="number" step="0.1" value="' + p.position[1].toFixed(1) + '" disabled>';
            html += '<span class="axis-label">Z</span><input type="number" step="0.1" value="' + p.position[2].toFixed(1) + '" disabled>';
            html += '</div></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Heading</span><div class="prop-value"><input type="number" step="0.01" value="' + p.heading.toFixed(2) + '" disabled style="width:60px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Pitch</span><div class="prop-value"><input type="number" step="0.01" value="' + p.pitch.toFixed(2) + '" disabled style="width:60px;"></div></div>';
            html += '</div>';

            html += '<div class="prop-group"><div class="prop-group-title">Vitals</div>';
            html += '<div class="prop-row"><span class="prop-label">Health</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-health" value="' + p.health.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">/ ' + p.maxHealth.toFixed(1) + '</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Hunger</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-hunger" value="' + p.hunger.toFixed(1) + '" style="width:50px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Thirst</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-thirst" value="' + p.thirst.toFixed(1) + '" style="width:50px;"></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Oxygen</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-oxygen" value="' + p.oxygen.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">/ ' + p.maxOxygen.toFixed(1) + '</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Temp</span><div class="prop-value"><input type="number" step="0.1" id="plr-' + i + '-temp" value="' + p.temperature.toFixed(1) + '" style="width:50px;"> <span style="color:#666;font-size:10px">°C</span></div></div>';
            html += '<div class="prop-row"><span class="prop-label">Gold</span><div class="prop-value"><input type="number" step="1" id="plr-' + i + '-gold" value="' + p.gold.toFixed(0) + '" style="width:60px;"></div></div>';
            html += '</div>';

            if (p.flagNames && p.flagNames.length > 0) {
              html += '<div class="player-flags">';
              for (var fi = 0; fi < p.flagNames.length; fi++) {
                var badgeClass = p.flagNames[fi] === "DEAD" ? "" : "safe";
                html += '<span class="player-flag-badge ' + badgeClass + '">' + escapeHtml(p.flagNames[fi]) + '</span>';
              }
              html += '</div>';
            }

            // Attach change handlers for editable fields
            (function (idx) {
              setTimeout(function () {
                var fields = ["health", "hunger", "thirst", "oxygen", "temp", "gold"];
                for (var k = 0; k < fields.length; k++) {
                  (function (field) {
                    var el = document.getElementById("plr-" + idx + "-" + field);
                    if (el) {
                      el.addEventListener("change", function () {
                        callInspector("setPlayerStat", [idx, field, parseFloat(el.value)]);
                      });
                    }
                  })(fields[k]);
                }
              }, 0);
            })(i);

            html += '</div>';
          }
          if (playerStatsEl) playerStatsEl.innerHTML = html;
        } catch (e) { if (playerStatsEl) playerStatsEl.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(String(e)) + '</p>'; }
      }
    );
  }

  function setupSimSpeedSlider() {
    var simSpeedSlider = document.getElementById("sim-speed-slider");
    var simSpeedDisplay = document.getElementById("sim-speed-display");
    if (simSpeedSlider) {
      simSpeedSlider.addEventListener("input", function () {
        var speed = parseFloat(simSpeedSlider.value);
        if (simSpeedDisplay) simSpeedDisplay.textContent = speed.toFixed(2) + "x";
        callInspector("setSimSpeed", [speed]);
      });
    }
    var btnSimSpeedReset = document.getElementById("btn-sim-speed-reset");
    if (btnSimSpeedReset) {
      btnSimSpeedReset.addEventListener("click", function () {
        if (simSpeedSlider) simSpeedSlider.value = 1;
        if (simSpeedDisplay) simSpeedDisplay.textContent = "1.00x";
        callInspector("setSimSpeed", [1]);
      });
    }
  }

  return {
    onActivate: function () {
      setupSimSpeedSlider();
      callInspector("getSimSpeed").then(function (res) {
        if (res.result != null) {
          var speed = res.result;
          var slider = document.getElementById("sim-speed-slider");
          var display = document.getElementById("sim-speed-display");
          if (slider) slider.value = speed;
          if (display) display.textContent = speed.toFixed(2) + "x";
        }
      });
    },
    onRefresh: refreshDebugInfo,
    onDeactivate: function () {},
  };
})
`;

// --- Boat Layout Panel ---

const boatLayoutHtml = `
<div class="panel-header">
  <h3>Boat Layout — 2D Layer Projections</h3>
  <select id="boat-select"></select>
</div>
<div id="boat-layers"></div>
<div id="boat-orthos">
  <div class="ortho-view">
    <h4>Side (X-Y)</h4>
    <canvas id="boat-side" width="400" height="200"></canvas>
  </div>
  <div class="ortho-view">
    <h4>Front (Z-Y)</h4>
    <canvas id="boat-front" width="400" height="200"></canvas>
  </div>
  <div class="ortho-view">
    <h4>Top (X-Z)</h4>
    <canvas id="boat-top" width="400" height="200"></canvas>
  </div>
</div>
<div id="boat-cell-tooltip" class="boat-cell-tooltip"></div>
`;

const boatLayoutCss = `
#boat-layout-panel {
  flex: 1;
  overflow-y: auto;
  background: #1e1e1e;
  padding: 8px;
  display: flex;
  flex-direction: column;
}

#boat-layout-panel .panel-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

#boat-layout-panel .panel-header h3 {
  font-size: 13px;
  color: #d4d4d4;
}

#boat-layout-panel select {
  background: #2d2d2d;
  color: #d4d4d4;
  border: 1px solid #3e3e3e;
  padding: 2px 6px;
  font-size: 12px;
}

#boat-layers {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
  justify-content: center;
}

.boat-layer-card {
  background: #2d2d2d;
  border: 1px solid #3e3e3e;
  border-radius: 4px;
  padding: 6px;
}

.boat-layer-card h4 {
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  text-align: center;
}

#boat-orthos {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.ortho-view {
  background: #2d2d2d;
  border: 1px solid #3e3e3e;
  border-radius: 4px;
  padding: 6px;
}

.ortho-view h4 {
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  text-align: center;
}

.ortho-view canvas {
  display: block;
  background: #111;
  border: 1px solid #333;
}

.boat-cell-tooltip {
  position: fixed;
  z-index: 10001;
  background: #1a1a2e;
  border: 1px solid #0e639c;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 11px;
  color: #d4d4d4;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
  line-height: 1.5;
  display: none;
}

.boat-cell-tooltip .tooltip-title {
  font-weight: 600;
  color: #4ec9b0;
  margin-bottom: 2px;
}

.boat-cell-tooltip .tooltip-row {
  display: flex;
  gap: 6px;
}

.boat-cell-tooltip .tooltip-label {
  color: #888;
  min-width: 50px;
}

.boat-cell-tooltip .tooltip-value {
  color: #dcdcaa;
  font-family: monospace;
}
`;

const boatLayoutScript = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var escapeHtml = DevToolsPanel.escapeHtml;

  var boatLayoutData = null;
  var selectedBoatIdx = 0;
  var boatLayerHitData = {};

  var CELL_HULL = 0, CELL_BOW = 1, CELL_CABIN = 2, CELL_MAST = 3, CELL_DECK = 4,
      CELL_RAIL = 5, CELL_WALL = 6, CELL_HULL_CURVE_L = 7, CELL_HULL_CURVE_R = 8,
      CELL_BOW_MODERN = 9, CELL_STERN = 10, CELL_PONTOON = 11, CELL_BRIDGE = 12, CELL_HELM = 13;

  var CELL_NAMES = {
    0: "HULL", 1: "BOW", 2: "CABIN", 3: "MAST", 4: "DECK",
    5: "RAIL", 6: "WALL", 7: "CURVE_L", 8: "CURVE_R", 9: "BOW_MOD",
    10: "STERN", 11: "PONTOON", 12: "BRIDGE", 13: "HELM",
  };

  var CELL_COLORS_CSS = {
    0: "#735a3f", 1: "#8c6647", 2: "#997a4d", 3: "#594026",
    4: "#806138", 5: "#664d33", 6: "#805933", 7: "#6b5238",
    8: "#6b5238", 9: "#806140", 10: "#7a5c3d", 11: "#594d47",
    12: "#806138", 13: "#8c734d",
  };

  var CELL_HEIGHTS = {
    0: { y0: -0.3, y1: 0.9 }, 1: { y0: -0.3, y1: 0.9 }, 9: { y0: -0.3, y1: 0.9 },
    7: { y0: -0.3, y1: 0.9 }, 8: { y0: -0.3, y1: 0.9 }, 10: { y0: -0.3, y1: 0.9 },
    11: { y0: -0.3, y1: 0.5 }, 6: { y0: -0.1, y1: 0.6 }, 2: { y0: 0.1, y1: 0.35 },
    3: { y0: -0.1, y1: 2.0 }, 13: { y0: -0.1, y1: 0.4 }, 5: { y0: -0.1, y1: 0.35 },
    4: { y0: 0.1, y1: 0.1 }, 12: { y0: -0.05, y1: 0.05 },
  };

  var CELL_SIZE = 2;
  var LAYER_HEIGHT = 1.0;

  function getCellShape2D(gridX, gridZ, type, rotation) {
    var s = CELL_SIZE / 2;
    var cx = gridX * CELL_SIZE;
    var cz = gridZ * CELL_SIZE;
    var x0 = cx - s, x1 = cx + s;
    var z0 = cz - s, z1 = cz + s;
    var rot = rotation % 4;
    var shape;

    switch (type) {
      case CELL_BOW:
      case CELL_BOW_MODERN:
        shape = {
          polygon: [[cx, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 2, p0: 1, p1: 2 }, { dir: -1, p0: 2, p1: 0 }],
        };
        break;
      case CELL_HULL_CURVE_L:
        shape = {
          polygon: [[cx, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: -1, p0: 3, p1: 0 }],
        };
        break;
      case CELL_HULL_CURVE_R:
        shape = {
          polygon: [[x0, z0], [cx, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: -1, p0: 0, p1: 1 }, { dir: -1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }],
        };
        break;
      default:
        shape = {
          polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
          edges: [{ dir: 0, p0: 0, p1: 1 }, { dir: 1, p0: 1, p1: 2 }, { dir: 2, p0: 2, p1: 3 }, { dir: 3, p0: 3, p1: 0 }],
        };
        break;
    }

    if (rot > 0) {
      var angle = rot * Math.PI / 2;
      var cosA = Math.cos(angle);
      var sinA = Math.sin(angle);
      shape = {
        polygon: shape.polygon.map(function (p) {
          return [
            cx + (p[0] - cx) * cosA - (p[1] - cz) * sinA,
            cz + (p[0] - cx) * sinA + (p[1] - cz) * cosA,
          ];
        }),
        edges: shape.edges.map(function (e) {
          return { dir: e.dir >= 0 ? (e.dir + rot) % 4 : -1, p0: e.p0, p1: e.p1 };
        }),
      };
    }

    return shape;
  }

  function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function attachCanvasTooltip(canvas, hitPolygons) {
    var tooltipEl = document.getElementById("boat-cell-tooltip");
    if (!tooltipEl) return;
    canvas.addEventListener("mousemove", function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var found = null;
      for (var i = 0; i < hitPolygons.length; i++) {
        if (pointInPolygon(mx, my, hitPolygons[i].poly)) { found = hitPolygons[i].cell; break; }
      }
      if (found) {
        var cellName = CELL_NAMES[found.type] || "UNKNOWN";
        var rotNames = ["0°", "90°", "180°", "270°"];
        var rotStr = rotNames[found.rotation % 4] || (found.rotation + "°");
        var html = '<div class="tooltip-title">' + escapeHtml(cellName) + '</div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Type</span><span class="tooltip-value">' + found.type + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Rotation</span><span class="tooltip-value">' + rotStr + ' (' + found.rotation + ')</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid X</span><span class="tooltip-value">' + found.gridX + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid Y</span><span class="tooltip-value">' + found.gridY + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Grid Z</span><span class="tooltip-value">' + found.gridZ + '</span></div>';
        tooltipEl.innerHTML = html;
        tooltipEl.style.display = "block";
        tooltipEl.style.left = (e.clientX + 14) + "px";
        tooltipEl.style.top = (e.clientY + 14) + "px";
      } else {
        tooltipEl.style.display = "none";
      }
    });
    canvas.addEventListener("mouseleave", function () {
      tooltipEl.style.display = "none";
    });
  }

  function fetchBoatLayout() {
    callInspector("getBoatLayout").then(function (res) {
      if (res.err || !res.result) return;
      boatLayoutData = res.result;
      renderBoatLayout();
    });
  }

  function renderBoatLayout() {
    if (!boatLayoutData || !boatLayoutData.boats || boatLayoutData.boats.length === 0) {
      var layersEl = document.getElementById("boat-layers");
      if (layersEl) layersEl.innerHTML = '<p class="empty-state">No boats</p>';
      return;
    }
    var boatSelect = document.getElementById("boat-select");
    if (boatSelect && boatSelect.options.length !== boatLayoutData.boats.length) {
      boatSelect.innerHTML = "";
      for (var i = 0; i < boatLayoutData.boats.length; i++) {
        var opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = "Boat " + i + " (" + boatLayoutData.boats[i].id + ")";
        boatSelect.appendChild(opt);
      }
      boatSelect.value = String(selectedBoatIdx);
      boatSelect.onchange = function () {
        selectedBoatIdx = parseInt(boatSelect.value, 10) || 0;
        renderBoatLayout();
      };
    }
    var boat = boatLayoutData.boats[selectedBoatIdx] || boatLayoutData.boats[0];
    if (!boat) return;

    // Compute bounds
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var ci = 0; ci < boat.cells.length; ci++) {
      var c = boat.cells[ci];
      if (c.gridX < minX) minX = c.gridX;
      if (c.gridX > maxX) maxX = c.gridX;
      if (c.gridZ < minZ) minZ = c.gridZ;
      if (c.gridZ > maxZ) maxZ = c.gridZ;
    }
    if (minX === Infinity) { minX = maxX = minZ = maxZ = 0; }

    // Group cells by layer (gridY)
    var layers = {};
    for (var li = 0; li < boat.cells.length; li++) {
      var cell = boat.cells[li];
      var yk = cell.gridY;
      if (!layers[yk]) layers[yk] = [];
      layers[yk].push(cell);
    }

    var layerKeys = Object.keys(layers).sort(function (a, b) { return parseInt(a) - parseInt(b); });
    var layersEl = document.getElementById("boat-layers");
    if (layersEl) {
      layersEl.innerHTML = "";
      for (var lk = 0; lk < layerKeys.length; lk++) {
        var yk2 = layerKeys[lk];
        var card = document.createElement("div");
        card.className = "boat-layer-card";
        card.innerHTML = "<h4>Layer " + yk2 + "</h4>";
        var canvas = document.createElement("canvas");
        canvas.id = "boat-layer-" + yk2;
        canvas.width = 200;
        canvas.height = 200;
        card.appendChild(canvas);
        layersEl.appendChild(card);

        // Draw layer
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        var w = canvas.width, h = canvas.height;
        var gridW = (maxX - minX + 1) * CELL_SIZE;
        var gridH = (maxZ - minZ + 1) * CELL_SIZE;
        var sc = Math.min((w - 20) / gridW, (h - 20) / gridH);
        var padX = (w - gridW * sc) / 2;
        var padZ = (h - gridH * sc) / 2;

        var hitPolygons = [];

        for (var ci2 = 0; ci2 < layers[yk2].length; ci2++) {
          var cell2 = layers[yk2][ci2];
          var shape = getCellShape2D(cell2.gridX, cell2.gridZ, cell2.type, cell2.rotation);
          ctx.fillStyle = CELL_COLORS_CSS[cell2.type] || "#666";
          ctx.strokeStyle = "#aaa";
          ctx.lineWidth = 1;

          ctx.beginPath();
          var screenPoly = [];
          for (var pi = 0; pi < shape.polygon.length; pi++) {
            var px = padX + (shape.polygon[pi][0] - minX * CELL_SIZE) * sc;
            var pz = padZ + (shape.polygon[pi][1] - minZ * CELL_SIZE) * sc;
            screenPoly.push([px, pz]);
            if (pi === 0) ctx.moveTo(px, pz);
            else ctx.lineTo(px, pz);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          hitPolygons.push({ poly: screenPoly, cell: cell2 });

          var labelX = padX + (cell2.gridX * CELL_SIZE - minX * CELL_SIZE) * sc + CELL_SIZE * sc / 2;
          var labelZ = padZ + (cell2.gridZ * CELL_SIZE - minZ * CELL_SIZE) * sc + CELL_SIZE * sc / 2;
          ctx.fillStyle = "#fff";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.fillText(CELL_NAMES[cell2.type] || "?", labelX, labelZ);
        }

        ctx.fillStyle = "#666";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("Z+ (back)", 4, canvas.height - 4);
        ctx.textAlign = "right";
        ctx.fillText("X+ (right)", canvas.width - 4, canvas.height - 4);

        boatLayerHitData["boat-layer-" + yk2] = hitPolygons;
        attachCanvasTooltip(canvas, hitPolygons);
      }
    }

    drawOrthos(boat.cells, minX, maxX, minZ, maxZ);
  }

  function drawOrthos(cells, minX, maxX, minZ, maxZ) {
    var views = [
      { id: "boat-side", label: "Side (X-Y)", axes: "x", yaxis: "y" },
      { id: "boat-front", label: "Front (Z-Y)", axes: "z", yaxis: "y" },
      { id: "boat-top", label: "Top (X-Z)", axes: "x", yaxis: "z" },
    ];

    for (var vi = 0; vi < views.length; vi++) {
      var canvas = document.getElementById(views[vi].id);
      if (!canvas) continue;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var w = canvas.width, h = canvas.height;
      var gridW = (maxX - minX + 1) * CELL_SIZE;
      var gridH = (maxZ - minZ + 1) * CELL_SIZE + 4;
      var sc = Math.min((w - 20) / gridW, (h - 20) / gridH);
      var padX = (w - gridW * sc) / 2;
      var padY = (h - gridH * sc) / 2;

      for (var ci = 0; ci < cells.length; ci++) {
        var cell = cells[ci];
        var heights = CELL_HEIGHTS[cell.type] || { y0: 0, y1: 0.5 };
        var ax = views[vi].axes === "x" ? cell.gridX * CELL_SIZE : cell.gridZ * CELL_SIZE;
        var ay = views[vi].yaxis === "y" ? cell.gridY * LAYER_HEIGHT : (cell.gridZ * CELL_SIZE);
        var y0 = views[vi].yaxis === "y" ? cell.gridY * LAYER_HEIGHT + heights.y0 : -2;
        var y1 = views[vi].yaxis === "y" ? cell.gridY * LAYER_HEIGHT + heights.y1 : cell.gridZ * CELL_SIZE + CELL_SIZE;

        var px = padX + (ax - minX * CELL_SIZE) * sc;
        var py = padY + h / 2 - (y0 + 2) * sc;
        var pw = CELL_SIZE * sc;
        var ph = (y1 - y0) * sc;

        ctx.fillStyle = CELL_COLORS_CSS[cell.type] || "#666";
        ctx.strokeStyle = "#aaa";
        ctx.lineWidth = 1;
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeRect(px, py, pw, ph);
      }

      ctx.fillStyle = "#666";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("X →, Z ↓", 4, canvas.height - 4);
    }
  }

  return {
    onActivate: function () {
      fetchBoatLayout();
    },
    onRefresh: fetchBoatLayout,
    onDeactivate: function () {},
  };
})
`;

// --- World Panel ---

const worldHtml = `
<div class="panel-header">
  <h3>World Control</h3>
  <button id="btn-refresh-world" class="import-action-btn" title="Refresh world data">Refresh</button>
  <button id="btn-clear-overrides" class="import-action-btn" title="Clear all biome/port/island overrides">Clear Overrides</button>
</div>
<div id="world-player-chunk" class="debug-section">
  <h4>Player Position</h4>
  <div id="world-player-info" class="debug-grid"></div>
</div>
<div class="debug-section">
  <h4>Override Biome at Chunk</h4>
  <div class="world-control-row">
    <label>Chunk X <input type="number" id="world-biome-cx" value="0" step="1"></label>
    <label>Chunk Z <input type="number" id="world-biome-cz" value="0" step="1"></label>
    <select id="world-biome-select"></select>
    <button id="btn-apply-biome" class="import-action-btn">Apply</button>
  </div>
</div>
<div class="debug-section">
  <h4>Force Port at Chunk</h4>
  <div class="world-control-row">
    <label>Chunk X <input type="number" id="world-port-cx" value="0" step="1"></label>
    <label>Chunk Z <input type="number" id="world-port-cz" value="0" step="1"></label>
    <button id="btn-force-port" class="import-action-btn">Force Port</button>
    <button id="btn-remove-port" class="import-action-btn">Remove Port</button>
  </div>
</div>
<div class="debug-section">
  <h4>Force Island at Chunk</h4>
  <div class="world-control-row">
    <label>Chunk X <input type="number" id="world-island-cx" value="0" step="1"></label>
    <label>Chunk Z <input type="number" id="world-island-cz" value="0" step="1"></label>
    <button id="btn-force-island" class="import-action-btn">Force Island</button>
    <button id="btn-remove-island" class="import-action-btn">Remove Island</button>
  </div>
</div>
<div class="debug-section">
  <h4>World Seed</h4>
  <div class="world-control-row">
    <label>Seed <input type="number" id="world-seed-input" value="12345" step="1"></label>
    <button id="btn-set-seed" class="import-action-btn">Set Seed</button>
  </div>
</div>
<div class="debug-section">
  <h4>Weather</h4>
  <div class="world-control-row" id="weather-buttons">
    <button class="import-action-btn weather-btn" data-weather="clear">Clear</button>
    <button class="import-action-btn weather-btn" data-weather="partlycloudy">Partly Cloudy</button>
    <button class="import-action-btn weather-btn" data-weather="overcast">Overcast</button>
    <button class="import-action-btn weather-btn" data-weather="rain">Rain</button>
    <button class="import-action-btn weather-btn" data-weather="storm">Storm</button>
    <button class="import-action-btn weather-btn" data-weather="fog">Fog</button>
    <button class="import-action-btn weather-btn" data-weather="snow">Snow</button>
    <button class="import-action-btn weather-btn" data-weather="eclipse">Eclipse</button>
    <button class="import-action-btn weather-btn" data-weather="fullmoon">Full Moon</button>
    <button class="import-action-btn weather-btn" data-weather="hellstorm">Hell Storm</button>
  </div>
</div>
<div class="debug-section">
  <h4>Time of Day <span id="world-tod-display" style="color:#888;font-weight:normal">12:00</span></h4>
  <div class="world-control-row">
    <input type="range" id="world-tod-slider" min="0" max="24" step="0.1" value="12" style="flex:1">
    <button id="btn-set-tod" class="import-action-btn">Set</button>
  </div>
</div>
<div class="debug-section">
  <h4>Events (stub)</h4>
  <div class="world-control-row" id="event-toggles">
    <label class="overlay-toggle-row"><input type="checkbox" class="event-toggle" data-event="storm"> Storm Event</label>
    <label class="overlay-toggle-row"><input type="checkbox" class="event-toggle" data-event="meteor"> Meteor Shower</label>
    <label class="overlay-toggle-row"><input type="checkbox" class="event-toggle" data-event="whale"> Whale Migration</label>
    <label class="overlay-toggle-row"><input type="checkbox" class="event-toggle" data-event="aurora"> Aurora</label>
  </div>
</div>
<div class="debug-section">
  <h4>Active Ports (<span id="world-port-count">0</span>)</h4>
  <div id="world-port-list" class="world-entity-list"></div>
</div>
<div class="debug-section">
  <h4>Active Islands (<span id="world-island-count">0</span>)</h4>
  <div id="world-island-list" class="world-entity-list"></div>
</div>
`;

const worldCss = `
#world-panel {
  flex: 1;
  overflow-y: auto;
  background: #1e1e1e;
  padding: 12px;
}

#world-panel .debug-section {
  margin-bottom: 16px;
}

#world-panel .debug-section h4 {
  font-size: 11px;
  color: #569cd6;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 6px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid #333;
}

.world-entity-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.weather-btn.active {
  background: #1177bb;
  border-color: #1177bb;
  font-weight: 600;
}

.world-entity-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: #252526;
  border: 1px solid #333;
  border-radius: 3px;
  font-size: 11px;
}

.world-entity-card .entity-info {
  display: flex;
  gap: 12px;
  align-items: center;
}

.world-entity-card .entity-id {
  color: #569cd6;
  font-family: monospace;
}

.world-entity-card .entity-pos {
  color: #dcdcaa;
  font-family: monospace;
}

.world-entity-card .entity-biome {
  color: #4ec9b0;
}

.world-entity-card .entity-chunk {
  color: #888;
  font-family: monospace;
}

#world-player-info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0;
  font-size: 11px;
}
`;

const worldScript = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var escapeHtml = DevToolsPanel.escapeHtml;
  var debugGridHtml = DevToolsPanel.debugGridHtml;

  var biomeNames = [
    "Lake", "Arctic", "Desert", "Boreal Forest", "Tropical", "Sub-Tropical",
    "Freshwater", "Ocean", "Deep Ocean", "Coral Reef", "Kelp Forest",
    "Volcanic", "Garbage Patch", "Hell",
  ];

  var weatherMap = {
    clear: 0, partlycloudy: 1, overcast: 2, rain: 3, storm: 4,
    fog: 5, eclipse: 6, fullmoon: 7, hellstorm: 8, snow: 9,
  };

  function refreshWorldPanel() {
    var playerPos = { worldX: 0, worldZ: 0, chunkX: 0, chunkZ: 0 };

    callInspector("getPlayerChunk").then(function (res) {
      if (res.err || !res.result) return;
      playerPos = res.result;
      var infoEl = document.getElementById("world-player-info");
      if (infoEl) {
        infoEl.innerHTML = debugGridHtml([
          ["World Pos", "(" + playerPos.worldX.toFixed(1) + ", " + playerPos.worldZ.toFixed(1) + ")"],
          ["Chunk", playerPos.chunkX + ", " + playerPos.chunkZ],
        ]);
      }
      var biomeCx = document.getElementById("world-biome-cx");
      var biomeCz = document.getElementById("world-biome-cz");
      if (biomeCx && biomeCz && !biomeCx.dataset.touched) {
        biomeCx.value = playerPos.chunkX;
        biomeCz.value = playerPos.chunkZ;
      }
      var portCx = document.getElementById("world-port-cx");
      var portCz = document.getElementById("world-port-cz");
      if (portCx && portCz && !portCx.dataset.touched) {
        portCx.value = playerPos.chunkX;
        portCz.value = playerPos.chunkZ;
      }
      var islandCx = document.getElementById("world-island-cx");
      var islandCz = document.getElementById("world-island-cz");
      if (islandCx && islandCz && !islandCx.dataset.touched) {
        islandCx.value = playerPos.chunkX;
        islandCz.value = playerPos.chunkZ;
      }

      callInspector("getWorldEntities").then(function (res2) {
        if (res2.err || !res2.result) return;
        var data = res2.result;
        var portListEl = document.getElementById("world-port-list");
        var islandListEl = document.getElementById("world-island-list");
        var portCountEl = document.getElementById("world-port-count");
        var islandCountEl = document.getElementById("world-island-count");

        if (portCountEl) portCountEl.textContent = String(data.ports.length);
        if (islandCountEl) islandCountEl.textContent = String(data.islands.length);

        function renderEntityList(el, entities, typeLabel) {
          if (!el) return;
          if (entities.length === 0) {
            el.innerHTML = '<p class="empty-state" style="padding:4px">None</p>';
            return;
          }
          entities.sort(function (a, b) {
            var da = Math.hypot(a.chunkX - playerPos.chunkX, a.chunkZ - playerPos.chunkZ);
            var db = Math.hypot(b.chunkX - playerPos.chunkX, b.chunkZ - playerPos.chunkZ);
            return da - db;
          });
          var html = "";
          for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            html += '<div class="world-entity-card">';
            html += '<div class="entity-info">';
            html += '<span class="entity-id">' + escapeHtml(e.id) + '</span>';
            html += '<span class="entity-chunk">(' + e.chunkX + ', ' + e.chunkZ + ')</span>';
            if (e.biome !== undefined) {
              html += '<span class="entity-biome">' + escapeHtml(biomeNames[e.biome] || String(e.biome)) + '</span>';
            }
            html += '</div>';
            html += '<span class="entity-pos">' + escapeHtml('(' + e.worldX.toFixed(0) + ', ' + e.worldZ.toFixed(0) + ')') + '</span>';
            html += '</div>';
          }
          el.innerHTML = html;
        }

        renderEntityList(portListEl, data.ports, "Port");
        renderEntityList(islandListEl, data.islands, "Island");
      });
    });
  }

  function setupWorldControls() {
    // Populate biome select
    var worldBiomeSelect = document.getElementById("world-biome-select");
    if (worldBiomeSelect) {
      for (var bi = 0; bi < biomeNames.length; bi++) {
        var opt = document.createElement("option");
        opt.value = String(bi);
        opt.textContent = biomeNames[bi];
        worldBiomeSelect.appendChild(opt);
      }
    }

    // Mark chunk inputs as touched on user edit
    ["world-biome-cx", "world-biome-cz", "world-port-cx", "world-port-cz", "world-island-cx", "world-island-cz"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", function () { el.dataset.touched = "1"; });
    });

    var btnRefreshWorld = document.getElementById("btn-refresh-world");
    if (btnRefreshWorld) btnRefreshWorld.addEventListener("click", refreshWorldPanel);

    var btnApplyBiome = document.getElementById("btn-apply-biome");
    if (btnApplyBiome) {
      btnApplyBiome.addEventListener("click", function () {
        var cx = parseInt(document.getElementById("world-biome-cx").value, 10) || 0;
        var cz = parseInt(document.getElementById("world-biome-cz").value, 10) || 0;
        var biome = parseInt(document.getElementById("world-biome-select").value, 10) || 0;
        callInspector("sendWorldCommand", [{ type: "set_biome", payload: { chunkX: cx, chunkZ: cz, biome: biome } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnForcePort = document.getElementById("btn-force-port");
    if (btnForcePort) {
      btnForcePort.addEventListener("click", function () {
        var cx = parseInt(document.getElementById("world-port-cx").value, 10) || 0;
        var cz = parseInt(document.getElementById("world-port-cz").value, 10) || 0;
        callInspector("sendWorldCommand", [{ type: "force_port", payload: { chunkX: cx, chunkZ: cz } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnRemovePort = document.getElementById("btn-remove-port");
    if (btnRemovePort) {
      btnRemovePort.addEventListener("click", function () {
        var cx = parseInt(document.getElementById("world-port-cx").value, 10) || 0;
        var cz = parseInt(document.getElementById("world-port-cz").value, 10) || 0;
        callInspector("sendWorldCommand", [{ type: "remove_port", payload: { chunkX: cx, chunkZ: cz } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnForceIsland = document.getElementById("btn-force-island");
    if (btnForceIsland) {
      btnForceIsland.addEventListener("click", function () {
        var cx = parseInt(document.getElementById("world-island-cx").value, 10) || 0;
        var cz = parseInt(document.getElementById("world-island-cz").value, 10) || 0;
        callInspector("sendWorldCommand", [{ type: "force_island", payload: { chunkX: cx, chunkZ: cz } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnRemoveIsland = document.getElementById("btn-remove-island");
    if (btnRemoveIsland) {
      btnRemoveIsland.addEventListener("click", function () {
        var cx = parseInt(document.getElementById("world-island-cx").value, 10) || 0;
        var cz = parseInt(document.getElementById("world-island-cz").value, 10) || 0;
        callInspector("sendWorldCommand", [{ type: "remove_island", payload: { chunkX: cx, chunkZ: cz } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnClearOverrides = document.getElementById("btn-clear-overrides");
    if (btnClearOverrides) {
      btnClearOverrides.addEventListener("click", function () {
        callInspector("sendWorldCommand", [{ type: "clear_overrides", payload: {} }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    var btnSetSeed = document.getElementById("btn-set-seed");
    if (btnSetSeed) {
      btnSetSeed.addEventListener("click", function () {
        var seed = parseInt(document.getElementById("world-seed-input").value, 10) || 12345;
        callInspector("sendWorldCommand", [{ type: "set_seed", payload: { seed: seed } }]);
        setTimeout(refreshWorldPanel, 500);
      });
    }

    // Weather buttons
    var weatherButtons = document.querySelectorAll(".weather-btn");
    for (var wbi = 0; wbi < weatherButtons.length; wbi++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var weather = btn.getAttribute("data-weather");
          var weatherType = weatherMap[weather] !== undefined ? weatherMap[weather] : 0;
          callInspector("setWeather", weatherType);
          for (var k = 0; k < weatherButtons.length; k++) weatherButtons[k].classList.remove("active");
          btn.classList.add("active");
        });
      })(weatherButtons[wbi]);
    }

    // Time of Day slider
    var todSlider = document.getElementById("world-tod-slider");
    var todDisplay = document.getElementById("world-tod-display");
    var btnSetTod = document.getElementById("btn-set-tod");

    function formatTod(hours) {
      var h = Math.floor(hours);
      var m = Math.round((hours - h) * 60);
      if (m === 60) { h += 1; m = 0; }
      if (h === 24) h = 0;
      return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
    }

    if (todSlider) {
      todSlider.addEventListener("input", function () {
        var val = parseFloat(todSlider.value);
        if (todDisplay) todDisplay.textContent = formatTod(val);
      });
    }
    if (btnSetTod) {
      btnSetTod.addEventListener("click", function () {
        var val = parseFloat(todSlider.value);
        var fraction = val / 24.0;
        callInspector("setTimeOfDay", fraction);
      });
    }
  }

  return {
    onActivate: function () {
      setupWorldControls();
      refreshWorldPanel();
    },
    onRefresh: refreshWorldPanel,
    onDeactivate: function () {},
  };
})
`;

// --- Overlay Toggle Scripts ---

const chunkGridToggleScript = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var chk = document.getElementById("chk-chunk-grid");
  if (!chk) return;
  // Load saved state
  try {
    var s = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
    if (typeof s.chunkGrid === "boolean") {
      chk.checked = s.chunkGrid;
      callInspector("setShowChunkGrid", s.chunkGrid);
    }
  } catch (e) {}
  chk.addEventListener("change", function () {
    callInspector("setShowChunkGrid", chk.checked);
    try {
      var s2 = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
      s2.chunkGrid = chk.checked;
      localStorage.setItem("devtools-overlays", JSON.stringify(s2));
    } catch (e) {}
  });
})
`;

const velArrowsToggleScript = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var chk = document.getElementById("chk-vel-arrows");
  if (!chk) return;
  try {
    var s = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
    if (typeof s.velArrows === "boolean") {
      chk.checked = s.velArrows;
      callInspector("setShowVelocityArrows", s.velArrows);
    }
  } catch (e) {}
  chk.addEventListener("change", function () {
    callInspector("setShowVelocityArrows", chk.checked);
    try {
      var s2 = JSON.parse(localStorage.getItem("devtools-overlays") || "{}");
      s2.velArrows = chk.checked;
      localStorage.setItem("devtools-overlays", JSON.stringify(s2));
    } catch (e) {}
  });
})
`;

// --- Exported extension definitions ---

export function getPanelExtensions(): IDevToolsPanelExtension[] {
  return [
    {
      id: "debug-info",
      tabLabel: "Debug Info",
      tabTooltip: "Debug info view",
      order: 100,
      requiredMethods: ["getSimState", "getPlayerStats", "getPhysicsStats", "getRendererStats"],
      html: debugInfoHtml,
      css: debugInfoCss,
      script: debugInfoScript,
    },
    {
      id: "boat-layout",
      tabLabel: "Boat Layout",
      tabTooltip: "Boat layout view",
      order: 101,
      requiredMethods: ["getBoatLayout"],
      html: boatLayoutHtml,
      css: boatLayoutCss,
      script: boatLayoutScript,
    },
    {
      id: "world",
      tabLabel: "World",
      tabTooltip: "World map controls",
      order: 102,
      requiredMethods: ["getWorldEntities", "sendWorldCommand"],
      html: worldHtml,
      css: worldCss,
      script: worldScript,
    },
  ];
}

export function getOverlayToggles(): IDevToolsOverlayToggle[] {
  return [
    {
      id: "chunk-grid",
      label: "Chunk Grid",
      requiredMethods: ["setShowChunkGrid", "getShowChunkGrid"],
      script: chunkGridToggleScript,
    },
    {
      id: "vel-arrows",
      label: "Vel Arrows",
      requiredMethods: ["setShowVelocityArrows", "getShowVelocityArrows"],
      script: velArrowsToggleScript,
    },
  ];
}
