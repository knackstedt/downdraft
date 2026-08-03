// ============================================================================
// Atlas HTML Template — generates the HTML page loaded into OSR BrowserWindows
// ============================================================================

import type { AtlasPanelRect } from "../types.ts";

/**
 * Generates the base HTML for an atlas OSR window.
 * Includes CSS reset, a container div, and a panel management script.
 * The script exposes `__osrAddPanel`, `__osrRemovePanel`, `__osrUpdatePanel`,
 * and `__osrUpdateData` for IPC-driven panel management.
 */
export function generateAtlasHTML(atlasWidth: number, atlasHeight: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${atlasWidth}px;
    height: ${atlasHeight}px;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #atlas-container {
    position: relative;
    width: ${atlasWidth}px;
    height: ${atlasHeight}px;
    overflow: hidden;
  }
  .osr-panel {
    position: absolute;
    overflow: hidden;
  }
</style>
</head>
<body>
<div id="atlas-container"></div>
<script>
(function() {
  const container = document.getElementById('atlas-container');

  window.__osrAddPanel = function(panelId, x, y, w, h, html) {
    let panel = document.getElementById('osr-panel-' + panelId);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'osr-panel-' + panelId;
      panel.className = 'osr-panel';
      container.appendChild(panel);
    }
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.innerHTML = html;
  };

  window.__osrRemovePanel = function(panelId) {
    const panel = document.getElementById('osr-panel-' + panelId);
    if (panel) panel.remove();
  };

  window.__osrUpdatePanel = function(panelId, html) {
    const panel = document.getElementById('osr-panel-' + panelId);
    if (panel) panel.innerHTML = html;
  };

  window.__osrUpdateData = function(panelId, values) {
    const panel = document.getElementById('osr-panel-' + panelId);
    if (!panel) return;
    for (const [key, value] of Object.entries(values)) {
      const elements = panel.querySelectorAll('[data-osr-key="' + key + '"]');
      elements.forEach(function(el) {
        if (typeof value === 'boolean') {
          if (value) {
            el.setAttribute('data-osr-active', 'true');
          } else {
            el.removeAttribute('data-osr-active');
          }
        } else if (typeof value === 'number') {
          el.textContent = String(value);
        } else {
          el.textContent = value;
        }
      });
    }
  };
})();
</script>
</body>
</html>`;
}

/**
 * Generates the HTML for a dedicated OSR window.
 * Includes the same `__osrUpdateData` function for data-only updates.
 */
export function generateDedicatedHTML(width: number, height: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #osr-content { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="osr-content"></div>
<script>
(function() {
  window.__osrSetContent = function(html) {
    document.getElementById('osr-content').innerHTML = html;
  };

  window.__osrUpdateData = function(panelId, values) {
    const panel = document.getElementById('osr-content');
    if (!panel) return;
    for (const [key, value] of Object.entries(values)) {
      const elements = panel.querySelectorAll('[data-osr-key="' + key + '"]');
      elements.forEach(function(el) {
        if (typeof value === 'boolean') {
          if (value) {
            el.setAttribute('data-osr-active', 'true');
          } else {
            el.removeAttribute('data-osr-active');
          }
        } else if (typeof value === 'number') {
          el.textContent = String(value);
        } else {
          el.textContent = value;
        }
      });
    }
  };
})();
</script>
</body>
</html>`;
}

/** Escapes a string for safe inclusion in a JS string literal. */
export function escapeJSString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** Builds a JS expression string that calls __osrAddPanel. */
export function buildAddPanelCall(panelId: string, rect: AtlasPanelRect, html: string): string {
  return `window.__osrAddPanel('${escapeJSString(panelId)}', ${rect.x}, ${rect.y}, ${rect.w}, ${rect.h}, '${escapeJSString(html)}');`;
}

/** Builds a JS expression string that calls __osrRemovePanel. */
export function buildRemovePanelCall(panelId: string): string {
  return `window.__osrRemovePanel('${escapeJSString(panelId)}');`;
}

/** Builds a JS expression string that calls __osrUpdatePanel. */
export function buildUpdatePanelCall(panelId: string, html: string): string {
  return `window.__osrUpdatePanel('${escapeJSString(panelId)}', '${escapeJSString(html)}');`;
}

/** Builds a JS expression string that calls __osrUpdateData. */
export function buildUpdateDataCall(panelId: string, values: Record<string, string | number | boolean>): string {
  const json = JSON.stringify(values);
  return `window.__osrUpdateData('${escapeJSString(panelId)}', ${json});`;
}

/** Builds a JS expression string that calls __osrSetContent (dedicated mode). */
export function buildSetContentCall(html: string): string {
  return `window.__osrSetContent('${escapeJSString(html)}');`;
}
