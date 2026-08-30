// ============================================================================
// createMaterialStatsPanelExtension — reusable DevTools "Materials" tab for
// any game using the unified material system.
//
// Shows:
//   - Registered material count, material types breakdown
//   - Variant cache size, LRU hits/misses
//   - Shader graph node count, compiled WGSL size
//   - GPU texture count/bytes (from GPUResourceTracker)
//
// Gated by requiredMethods: ["getMaterialStats"]. The framework auto-provides
// getMaterialStats() from the renderer's MaterialLibrary / variant cache
// (feature-detected in createDevToolsRendererAdapter or registered via
// devtools.registerDataFeed).
// ============================================================================

import type { IDevToolsPanelExtension } from "./types";

export interface MaterialStatsPanelOptions {
  tabLabel?: string;
  tabTooltip?: string;
  order?: number;
  /** Optional callback to append custom rows to the stats grid. */
  extraRows?: (stats: any) => [string, string][];
}

export function createMaterialStatsPanelExtension(
  opts: MaterialStatsPanelOptions = {},
): IDevToolsPanelExtension {
  const tabLabel = opts.tabLabel ?? "Materials";
  const tabTooltip = opts.tabTooltip ?? "Material system stats (library, variants, GPU textures)";
  const order = opts.order ?? 25;
  const hasExtra = typeof opts.extraRows === "function";
  const extraRowsSrc = hasExtra ? opts.extraRows!.toString() : "null";

  const html = `
<div class="panel-header">
  <h3>Materials</h3>
  <span id="mat-status-badge" class="perf-status">Waiting for data...</span>
</div>
<div id="mat-stats-panel">
  <div class="debug-section">
    <h4>Library</h4>
    <div id="mat-library-grid" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>Variants</h4>
    <div id="mat-variants-grid" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>GPU Textures</h4>
    <div id="mat-textures-grid" class="debug-grid"></div>
  </div>
  <div class="debug-section">
    <h4>Shader Graph</h4>
    <div id="mat-graph-grid" class="debug-grid"></div>
  </div>
</div>
`;

  const css = `
#mat-stats-panel {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}
#mat-stats-panel .debug-section {
  margin-bottom: 12px;
}
#mat-stats-panel .debug-section h4 {
  font-size: 12px;
  color: #569cd6;
  margin: 8px 0 4px 0;
  border-bottom: 1px solid #333;
  padding-bottom: 2px;
}
#mat-status-badge.running { color: #98c379; }
#mat-status-badge.empty { color: #e5c07b; }
`;

  const script = `
(function(DevToolsPanel) {
  var callInspector = DevToolsPanel.callInspector;
  var evalInPage = DevToolsPanel.evalInPage;
  var escapeHtml = DevToolsPanel.escapeHtml;
  var fmtVal = DevToolsPanel.fmtVal;
  var debugGridHtml = DevToolsPanel.debugGridHtml;

  var extraRowsFn = ${extraRowsSrc};

  function refreshMatStats() {
    var libEl = document.getElementById("mat-library-grid");
    var varEl = document.getElementById("mat-variants-grid");
    var texEl = document.getElementById("mat-textures-grid");
    var graphEl = document.getElementById("mat-graph-grid");
    var statusEl = document.getElementById("mat-status-badge");

    evalInPage(
      "window.__sceneInspector ? JSON.stringify(window.__sceneInspector.getMaterialStats()) : null",
      function (result, err) {
        if (err || !result) {
          if (libEl) libEl.innerHTML = '<div class="debug-label">Not available</div>';
          if (statusEl) { statusEl.textContent = "Not available"; statusEl.className = "perf-status"; }
          return;
        }
        try {
          var s = JSON.parse(result);
          if (!s) {
            if (libEl) libEl.innerHTML = '<div class="debug-label">Not available</div>';
            return;
          }

          // Library stats
          var libRows = [
            ["Registered", s.library?.count ?? 0],
            ["Types", s.library?.types?.join(", ") ?? "—"],
          ];
          if (libEl) libEl.innerHTML = debugGridHtml(libRows);

          // Variant stats
          var varRows = [
            ["Cached Pipelines", s.variants?.cachedPipelines ?? 0],
            ["Max Pipelines", s.variants?.maxPipelines ?? 0],
            ["LRU Hits", s.variants?.lruHits ?? 0],
            ["LRU Misses", s.variants?.lruMisses ?? 0],
            ["Permutation Count", s.variants?.permutationCount ?? 0],
          ];
          if (varEl) varEl.innerHTML = debugGridHtml(varRows);

          // GPU textures
          var texRows = [
            ["Texture Count", s.textures?.count ?? 0],
            ["Texture Memory", fmtVal((s.textures?.bytes ?? 0) / 1048576, 1) + " MB"],
            ["Bindless Entries", s.textures?.bindlessEntries ?? 0],
          ];
          if (texEl) texEl.innerHTML = debugGridHtml(texRows);

          // Shader graph
          var graphRows = [
            ["Graph Materials", s.graph?.materialCount ?? 0],
            ["Total Nodes", s.graph?.totalNodes ?? 0],
            ["Total Connections", s.graph?.totalConnections ?? 0],
            ["Compiled WGSL Size", fmtVal((s.graph?.compiledWgslBytes ?? 0) / 1024, 1) + " KB"],
          ];
          if (graphEl) graphEl.innerHTML = debugGridHtml(graphRows);

          // Extra rows
          if (extraRowsFn && s) {
            try {
              var extra = extraRowsFn(s);
              if (extra && extra.length) {
                var extraHtml = debugGridHtml(extra);
                if (graphEl) graphEl.innerHTML += extraHtml;
              }
            } catch (e) { /* ignore */ }
          }

          if (statusEl) {
            var count = s.library?.count ?? 0;
            statusEl.textContent = count > 0 ? count + " materials" : "No materials";
            statusEl.className = "perf-status " + (count > 0 ? "running" : "empty");
          }
        } catch (e) {
          if (libEl) libEl.innerHTML = '<div class="debug-label">Error: ' + escapeHtml(String(e)) + '</div>';
        }
      }
    );
  }

  return {
    onActivate: function () { refreshMatStats(); },
    onRefresh: refreshMatStats,
    onDeactivate: function () {},
  };
})
`;

  return {
    id: "material-stats",
    tabLabel,
    tabTooltip,
    order,
    requiredMethods: ["getMaterialStats"],
    html,
    css,
    script,
  };
}
