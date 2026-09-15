// ============================================================================
// downdraft doctor — devtools panel for module graph diagnostics
//
// Displays the resolved module graph, resource table, system schedule,
// diagnostics (unresolved requires, version conflicts, leaks), and the
// cross-thread dependency report (sim + renderer).
// ============================================================================

import type { CrossThreadReport, ModuleThreadInfo, PluginInfo } from "@downdraft/core";
import type { IDevToolsPanelExtension } from "./types";

export interface DoctorPanelOptions {
  /** Snapshot provider for sim-side modules. */
  getSimModules?: () => ModuleThreadInfo[];
  /** Snapshot provider for renderer-side modules. */
  getRendererModules?: () => ModuleThreadInfo[];
  /** Snapshot provider for the cross-thread report (pre-built). */
  getReport?: () => CrossThreadReport | null;
  /** Snapshot provider for user-authored plugins (the modding system). */
  getPlugins?: () => PluginInfo[];
}

/** Escape untrusted strings before interpolating into innerHTML — mod
 *  manifests are third-party content and must not be able to inject markup. */
function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function createDoctorPanelExtension(opts: DoctorPanelOptions = {}): IDevToolsPanelExtension {
  return {
    id: "downdraft-doctor",
    tabLabel: "Doctor",
    tabTooltip: "Module graph diagnostics: resolved dependencies, resource table, version conflicts, leak detection",
    order: 5,

    html: `
      <div class="dd-doctor">
        <div class="dd-doctor__header">
          <h2>downdraft doctor</h2>
          <button class="dd-doctor__refresh">Refresh</button>
        </div>
        <div class="dd-doctor__summary"></div>
        <div class="dd-doctor__plugins"></div>
        <div class="dd-doctor__user-plugins"></div>
        <div class="dd-doctor__resources"></div>
        <div class="dd-doctor__issues"></div>
      </div>
    `,

    css: `
      .dd-doctor { padding: 12px; font-family: monospace; font-size: 12px; color: #ccc; }
      .dd-doctor h2 { margin: 0 0 8px; font-size: 16px; color: #4fc3f7; }
      .dd-doctor__header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .dd-doctor__refresh { padding: 4px 12px; background: #333; color: #ccc; border: 1px solid #555; border-radius: 4px; cursor: pointer; }
      .dd-doctor__refresh:hover { background: #444; }
      .dd-doctor__summary { margin-bottom: 16px; padding: 8px; background: #1a1a2e; border-radius: 4px; }
      .dd-doctor__summary div { margin: 2px 0; }
      .dd-doctor__plugins h3, .dd-doctor__resources h3, .dd-doctor__issues h3, .dd-doctor__user-plugins h3 { color: #4fc3f7; margin: 12px 0 4px; font-size: 13px; }
      .dd-doctor__badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-right: 4px; }
      .dd-doctor__badge--format { background: #2a3a4a; color: #64b5f6; }
      .dd-doctor__badge--tier { background: #3a2a4a; color: #ce93d8; }
      .dd-doctor__badge--thread { background: #2a4a3a; color: #81c784; }
      .dd-doctor__badge--perm { background: #4a3a2a; color: #ffb74d; }
      .dd-doctor__status--active { color: #81c784; }
      .dd-doctor__status--error { color: #ef5350; }
      .dd-doctor__status--loading, .dd-doctor__status--pending { color: #ffb74d; }
      .dd-doctor__status--disabled { color: #888; }
      .dd-doctor__table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      .dd-doctor__table th { text-align: left; padding: 4px 8px; background: #1a1a2e; color: #888; font-weight: normal; }
      .dd-doctor__table td { padding: 4px 8px; border-bottom: 1px solid #222; }
      .dd-doctor__table .dd-thread-sim { color: #81c784; }
      .dd-doctor__table .dd-thread-renderer { color: #64b5f6; }
      .dd-doctor__table .dd-thread-shared { color: #ffb74d; }
      .dd-doctor__issue { padding: 6px 8px; margin: 4px 0; border-radius: 4px; }
      .dd-doctor__issue--error { background: #3e1e1e; color: #ef5350; }
      .dd-doctor__issue--warning { background: #3e3a1e; color: #ffb74d; }
      .dd-doctor__issue--ok { background: #1e3e2a; color: #81c784; }
    `,

    script: `(() => {
      const helpers = arguments[0];
      const container = helpers.container;
      const opts = window.__ddDoctorOpts || {};
      let refreshTimer = null;

      function render() {
        const simModules = opts.getSimModules ? opts.getSimModules() : [];
        const rendererModules = opts.getRendererModules ? opts.getRendererModules() : [];
        let report = opts.getReport ? opts.getReport() : null;
        if (!report && (simModules.length || rendererModules.length)) {
          // Build report inline if no pre-built report provider
          const { buildCrossThreadReport } = window.__ddCrossThread || {};
          if (buildCrossThreadReport) {
            report = buildCrossThreadReport(simModules, rendererModules);
          }
        }
        if (!report) {
          report = { modules: [...simModules, ...rendererModules], unresolved: [], shared: [], versionConflicts: [] };
        }

        // Summary
        const summary = container.querySelector('.dd-doctor__summary');
        const simCount = report.modules.filter(p => p.thread === 'sim').length;
        const rendererCount = report.modules.filter(p => p.thread === 'renderer').length;
        const sharedCount = report.shared.length;
        const unresolvedCount = report.unresolved.length;
        const conflictCount = report.versionConflicts.length;
        summary.innerHTML = [
          '<div>Sim modules: <b>' + simCount + '</b></div>',
          '<div>Renderer modules: <b>' + rendererCount + '</b></div>',
          '<div>Shared resources: <b>' + sharedCount + '</b></div>',
          '<div>Unresolved requires: <b style="color:' + (unresolvedCount ? '#ef5350' : '#81c784') + '">' + unresolvedCount + '</b></div>',
          '<div>Version conflicts: <b style="color:' + (conflictCount ? '#ef5350' : '#81c784') + '">' + conflictCount + '</b></div>',
        ].join('');

        // Modules table
        const pluginsDiv = container.querySelector('.dd-doctor__plugins');
        if (report.modules.length === 0) {
          pluginsDiv.innerHTML = '<h3>Modules</h3><p>No modules registered.</p>';
        } else {
          let html = '<h3>Modules (' + report.modules.length + ')</h3>';
          html += '<table class="dd-doctor__table"><thead><tr><th>Name</th><th>Version</th><th>Thread</th><th>Provides</th><th>Requires</th><th>Status</th></tr></thead><tbody>';
          for (const p of report.modules) {
            const threadClass = 'dd-thread-' + esc(p.thread);
            html += '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.version) + '</td><td class="' + threadClass + '">' + esc(p.thread) + '</td><td>' + esc(p.provides.join(', ') || '—') + '</td><td>' + esc(p.requires.join(', ') || '—') + '</td><td>' + (p.active ? '✓ active' : 'inactive') + '</td></tr>';
          }
          html += '</tbody></table>';
          pluginsDiv.innerHTML = html;
        }

        // User-authored plugins (modding system)
        const userPluginsDiv = container.querySelector('.dd-doctor__user-plugins');
        const plugins = opts.getPlugins ? opts.getPlugins() : [];
        if (plugins.length === 0) {
          userPluginsDiv.innerHTML = '';
        } else {
          let phtml = '<h3>Plugins (' + plugins.length + ')</h3>';
          phtml += '<table class="dd-doctor__table"><thead><tr><th>ID</th><th>Version</th><th>Format</th><th>Tier</th><th>Thread</th><th>Permissions</th><th>Status</th></tr></thead><tbody>';
          for (const p of plugins) {
            const fmtBadge = '<span class="dd-doctor__badge dd-doctor__badge--format">' + esc(p.format) + '</span>';
            const tierBadge = '<span class="dd-doctor__badge dd-doctor__badge--tier">' + esc(p.tier) + '</span>';
            const threadBadge = '<span class="dd-doctor__badge dd-doctor__badge--thread">' + esc(p.thread) + '</span>';
            const permBadges = p.permissions.map(function(perm) { return '<span class="dd-doctor__badge dd-doctor__badge--perm">' + esc(perm) + '</span>'; }).join('');
            const statusClass = 'dd-doctor__status--' + esc(p.status);
            const statusText = esc(p.status + (p.error ? ': ' + p.error : ''));
            phtml += '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.version) + '</td><td>' + fmtBadge + '</td><td>' + tierBadge + '</td><td>' + threadBadge + '</td><td>' + (permBadges || '—') + '</td><td class="' + statusClass + '">' + statusText + '</td></tr>';
          }
          phtml += '</tbody></table>';
          userPluginsDiv.innerHTML = phtml;
        }

        // Issues
        const issuesDiv = container.querySelector('.dd-doctor__issues');
        let issuesHtml = '<h3>Diagnostics</h3>';
        if (report.unresolved.length > 0) {
          issuesHtml += '<div class="dd-doctor__issue dd-doctor__issue--error">Unresolved requires: ' + esc(report.unresolved.join(', ')) + '</div>';
        }
        if (report.versionConflicts.length > 0) {
          for (const vc of report.versionConflicts) {
            issuesHtml += '<div class="dd-doctor__issue dd-doctor__issue--error">Version conflict: ' + esc(vc.name) + ' (sim=' + esc(vc.simVersion) + ', renderer=' + esc(vc.rendererVersion) + ')</div>';
          }
        }
        if (report.shared.length > 0) {
          issuesHtml += '<div class="dd-doctor__issue dd-doctor__issue--ok">Shared resources: ' + esc(report.shared.join(', ')) + '</div>';
        }
        if (report.unresolved.length === 0 && report.versionConflicts.length === 0) {
          issuesHtml += '<div class="dd-doctor__issue dd-doctor__issue--ok">✓ No issues detected</div>';
        }
        issuesDiv.innerHTML = issuesHtml;
      }

      container.querySelector('.dd-doctor__refresh').addEventListener('click', render);
      render();

      return {
        onActivate() { refreshTimer = setInterval(render, 2000); },
        onDeactivate() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } },
        onDestroy() { if (refreshTimer) clearInterval(refreshTimer); }
      };
    })`,
  };
}
