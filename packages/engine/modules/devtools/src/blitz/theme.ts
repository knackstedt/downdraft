// ============================================================================
// theme.ts — devtools dock stylesheet (Chrome-DevTools-flavored dark theme,
// adapted from packages/devtools-web/style.css).
// ============================================================================

export const DEVTOOLS_CSS = `
:root {
  --bg: #16181d;
  --bg2: #1d2026;
  --bg3: #242832;
  --line: #30363f;
  --fg: #d6dbe2;
  --fg-dim: #8b94a1;
  --accent: #4da3ff;
  --warn: #e0b341;
  --err: #e5534b;
  --ok: #57ab5a;
  --mono: "SF Mono", "Cascadia Mono", Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--fg);
  font: 12px/1.45 system-ui, sans-serif;
  overflow: hidden;
  height: 100%;
}
#dt-root { display: flex; flex-direction: column; height: 100%; }
#dt-grip {
  height: 5px; cursor: ns-resize; flex-shrink: 0;
  background: var(--bg2); border-top: 1px solid var(--line);
}
#dt-grip:hover, #dt-grip.drag { background: var(--accent); }
#dt-chrome { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

/* ── Tab bar ── */
#dt-tabs {
  display: flex; align-items: center; gap: 2px;
  background: var(--bg2); border-bottom: 1px solid var(--line);
  padding: 0 8px; height: 30px; flex-shrink: 0;
}
#dt-tabs .brand { color: var(--accent); font-weight: 600; margin-right: 12px; }
#dt-tabs .spacer { flex: 1; }
#dt-tabs .hint { font-size: 11px; color: var(--fg-dim); }
.tab {
  background: none; border: none; color: var(--fg-dim);
  padding: 6px 10px; cursor: pointer; font: inherit;
  border-bottom: 2px solid transparent; white-space: nowrap;
}
.tab:hover { color: var(--fg); }
.tab.active { color: var(--fg); border-bottom-color: var(--accent); }
#dt-close { color: var(--fg-dim); padding: 4px 8px; cursor: pointer; }
#dt-close:hover { color: var(--err); }

/* ── Panel regions ── */
#dt-top { flex-shrink: 0; }
#dt-body { flex: 1; overflow: auto; padding: 8px; }
#dt-bottom { flex-shrink: 0; }
#dt-status {
  display: flex; justify-content: space-between;
  background: var(--bg2); border-top: 1px solid var(--line);
  padding: 3px 8px; font-size: 11px; color: var(--fg-dim); flex-shrink: 0;
}

/* ── Shared panel chrome ── */
.panel-toolbar {
  display: flex; gap: 8px; align-items: center;
  padding: 4px 8px; background: var(--bg);
  border-bottom: 1px solid var(--line);
}
.panel-toolbar .spacer { flex: 1; }
.panel-toolbar .count { font-size: 11px; color: var(--fg-dim); }
.dbtn {
  background: var(--bg3); border: 1px solid var(--line); color: var(--fg);
  padding: 3px 10px; border-radius: 3px; cursor: pointer;
  font: inherit; font-size: 11px;
}
.dbtn:hover { border-color: var(--accent); }
.dbtn.on { background: #2d4a72; border-color: var(--accent); }
.dbtn.warn { color: var(--warn); }
.status-banner { padding: 10px; color: var(--fg-dim); font-style: italic; }
.status-banner.error { color: var(--err); font-style: normal; }
.empty-note { color: var(--fg-dim); font-style: italic; padding: 12px; }

/* ── Console ── */
.console-log { font-family: var(--mono); font-size: 11.5px; }
.crow { padding: 1px 4px; border-bottom: 1px solid #ffffff08; white-space: pre-wrap; }
.crow .th { color: var(--fg-dim); margin-right: 6px; }
.crow.sev-2 { color: var(--warn); }
.crow.sev-3 { color: var(--err); background: #e5534b14; }
.crow.sev-4, .crow.sev-5 { color: var(--fg-dim); }
.crow.repl-in { color: var(--accent); }
.console-filter {
  background: var(--bg3); border: 1px solid var(--line); color: var(--fg);
  font-family: var(--mono); font-size: 11px; padding: 2px 6px; border-radius: 3px;
}
.console-repl {
  display: flex; gap: 6px; align-items: center;
  padding: 4px 8px; border-top: 1px solid var(--line); background: var(--bg);
}
.console-repl .thr {
  background: var(--bg3); border: 1px solid var(--line); color: var(--fg-dim);
  font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 3px;
  cursor: pointer;
}
.console-repl .thr.on { color: var(--fg); border-color: var(--accent); }
.console-repl input {
  flex: 1; background: var(--bg3); border: 1px solid var(--line); color: var(--fg);
  font-family: var(--mono); font-size: 12px; padding: 4px 6px; border-radius: 3px;
}
.console-repl input:focus { border-color: var(--accent); }
.console-repl .prompt { color: var(--accent); font-family: var(--mono); }

/* ── Tree (scene/dom/ecs) ── */
.tree { font-family: var(--mono); font-size: 11.5px; }
.trow { padding: 1px 4px; white-space: nowrap; }
.trow:hover { background: var(--bg3); }
.trow.sel { background: #2d4a72; }
.trow .detail { color: var(--fg-dim); margin-left: 8px; }
.trow .kids { color: var(--fg-dim); }

/* ── KV / tables / snapshot panels ── */
.snap-section { margin-bottom: 14px; }
.snap-section > h3 {
  font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--fg-dim); border-bottom: 1px solid var(--line);
  padding-bottom: 3px; margin-bottom: 4px;
}
.kv { display: flex; flex-direction: column; }
.kvrow { display: flex; border-bottom: 1px solid #ffffff08; }
.kvrow > .k { flex: 0 0 30%; min-width: 140px; padding: 2px 6px; color: var(--fg-dim); }
.kvrow > .v { flex: 1; padding: 2px 6px; font-family: var(--mono); font-size: 11.5px; }
.kvrow.hdr > .k { color: var(--accent); font-weight: 600; padding-top: 8px; }
.fl-warn { color: var(--warn); }
.fl-err { color: var(--err); }
table.dt { border-collapse: collapse; width: 100%; font-size: 11.5px; }
table.dt th { text-align: left; color: var(--fg-dim); font-weight: 600; padding: 3px 8px 3px 6px; border-bottom: 1px solid var(--line); }
table.dt td { padding: 2px 8px 2px 6px; border-bottom: 1px solid #ffffff08; font-family: var(--mono); }
.lines { font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; }
.controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.controls label { display: flex; align-items: center; gap: 6px; }
.controls .val { color: var(--fg-dim); font-family: var(--mono); min-width: 42px; }

/* ── Bar-strip chart (no canvas/SVG in Blitz — columns of divs) ── */
.chart {
  display: flex; align-items: flex-end; gap: 0;
  width: 100%; height: 90px; background: var(--bg2);
  border: 1px solid var(--line); border-radius: 3px;
  padding: 2px; overflow: hidden; margin-bottom: 8px;
}
.chart .col { flex: 1; min-width: 1px; }
.chart.cap { height: 60px; }
.chart-label { font-size: 10px; color: var(--fg-dim); margin-bottom: 2px; }
`;
