// ============================================================================
// theme.ts — Downdraft kit stylesheet. Dark-first tokens; every state that JS
// can change lives in a `data-*` attribute so DOM mutations are single-attr
// writes (setAttr), and hover/active/focus stay in CSS where Blitz can
// repaint them without a host round-trip.
//
// IMPORTANT: state colors must come from stylesheets, not inline styles —
// inline styles beat :hover rules in the cascade and mask state painting.
// ============================================================================

export const KIT_FONT_FAMILY = "sans-serif";

export const KIT_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
:root {
  --dd-bg: #10141a;      --dd-panel: #161b23;   --dd-panel2: #1c222c;
  --dd-sink: #0f1319;    --dd-line: #2a313c;    --dd-line2: #3a4553;
  --dd-text: #e8ecf1;    --dd-dim: #8a94a3;     --dd-faint: #5d6775;
  --dd-accent: #4fc2f7;  --dd-accent-bg: #1d3547;
  --dd-good: #6fbf73;    --dd-warn: #f0a04b;    --dd-bad: #e5534b;
  --dd-radius: 5px;
}
body { background: var(--dd-bg); color: var(--dd-text); font-family: ${KIT_FONT_FAMILY}; font-size: 13px; overflow: hidden; }

/* ── primitives ── */
.dd-btn { display:inline-block; padding:7px 14px; border-radius:var(--dd-radius);
  border:1px solid var(--dd-line2); background:var(--dd-panel2); color:var(--dd-text);
  font-size:12px; }
.dd-btn:hover { background:#26303d; border-color:#4a5568; }
.dd-btn:active { background:#31404f; }
.dd-btn[data-kind="accent"] { background:var(--dd-accent-bg); color:var(--dd-accent); border-color:var(--dd-accent); }
.dd-btn[data-kind="accent"]:hover { background:#27455c; }
.dd-btn[data-kind="danger"] { background:#3a1d1d; color:#f28b82; border-color:var(--dd-bad); }
.dd-btn[data-kind="danger"]:hover { background:#4a2525; }
.dd-btn[data-kind="ghost"] { background:transparent; border-color:transparent; color:var(--dd-dim); }
.dd-btn[data-kind="ghost"]:hover { background:var(--dd-panel2); color:var(--dd-text); }
.dd-btn[data-disabled="true"] { opacity:.45; }
.dd-btn[data-on="true"] { background:var(--dd-accent-bg); color:var(--dd-accent); border-color:var(--dd-accent); }

/* NavController focus ring — applied via data-nav-focus on any focusable. */
[data-nav-focus="1"] { border-color:var(--dd-accent); }
.dd-btn[data-nav-focus="1"], .dd-input[data-nav-focus="1"] { background:#26303d; border-color:var(--dd-accent); }

.dd-badge { display:inline-block; padding:1px 8px; border-radius:8px; font-size:10px;
  background:var(--dd-panel2); color:var(--dd-dim); border:1px solid var(--dd-line); }
.dd-badge[data-kind="accent"] { color:var(--dd-accent); border-color:var(--dd-accent); }
.dd-badge[data-kind="good"] { color:var(--dd-good); border-color:var(--dd-good); }
.dd-badge[data-kind="warn"] { color:var(--dd-warn); border-color:var(--dd-warn); }
.dd-badge[data-kind="bad"] { color:var(--dd-bad); border-color:var(--dd-bad); }

.dd-label { font-size:11px; color:var(--dd-dim); }
.dd-section { font-size:11px; color:var(--dd-dim); letter-spacing:1px; margin-bottom:10px; }
.dd-divider { height:1px; background:var(--dd-line); margin:8px 0; }

.dd-panel { background:var(--dd-panel); border:1px solid var(--dd-line); border-radius:6px; padding:14px; }
.dd-row { display:flex; align-items:center; gap:8px; }
.dd-col { display:flex; flex-direction:column; gap:8px; }
.dd-grow { flex:1; }

/* ── checkbox / switch / radio ── */
.dd-check { display:flex; align-items:center; gap:8px; padding:3px 0; }
.dd-check .dd-box { width:16px; height:16px; border:1px solid var(--dd-line2);
  border-radius:3px; background:var(--dd-sink); color:#10141a; font-size:11px;
  font-weight:bold; text-align:center; line-height:14px; }
.dd-check:hover .dd-box { border-color:var(--dd-accent); }
.dd-check[data-on="true"] .dd-box { background:var(--dd-accent); }
.dd-check[data-disabled="true"] { opacity:.45; }
.dd-check .dd-lbl { font-size:12px; }

.dd-switch { display:flex; align-items:center; gap:8px; padding:3px 0; }
.dd-switch .dd-rail { width:32px; height:16px; border-radius:8px; background:var(--dd-panel2);
  border:1px solid var(--dd-line2); position:relative; }
.dd-switch .dd-knob { position:absolute; top:1px; left:1px; width:12px; height:12px;
  border-radius:6px; background:var(--dd-dim); }
.dd-switch:hover .dd-rail { border-color:var(--dd-accent); }
.dd-switch[data-on="true"] .dd-rail { background:var(--dd-accent-bg); border-color:var(--dd-accent); }
.dd-switch[data-on="true"] .dd-knob { left:17px; background:var(--dd-accent); }
.dd-switch .dd-lbl { font-size:12px; }

.dd-radio .dd-opt { display:flex; align-items:center; gap:8px; padding:3px 0; }
.dd-radio .dd-dot { width:14px; height:14px; border-radius:7px; border:1px solid var(--dd-line2);
  background:var(--dd-sink); }
.dd-radio .dd-opt:hover .dd-dot { border-color:var(--dd-accent); }
.dd-radio .dd-opt[data-on="true"] .dd-dot { border-color:var(--dd-accent); background:var(--dd-accent); }
.dd-radio .dd-lbl { font-size:12px; }

/* ── text inputs ── */
.dd-field { display:flex; flex-direction:column; gap:4px; }
.dd-field .dd-lbl { font-size:11px; color:var(--dd-dim); }
.dd-input { width:200px; padding:7px 10px; background:var(--dd-sink);
  border:1px solid var(--dd-line2); border-radius:4px; font-size:13px; color:var(--dd-text); }
.dd-input:focus { border-color:var(--dd-accent); }
.dd-input[data-invalid="true"] { border-color:var(--dd-bad); }
.dd-input[data-disabled="true"] { opacity:.45; }
.dd-textarea { width:280px; min-height:64px; padding:7px 10px; background:var(--dd-sink);
  border:1px solid var(--dd-line2); border-radius:4px; font-size:12px; color:var(--dd-text); }
.dd-textarea:focus { border-color:var(--dd-accent); }
.dd-num { display:flex; align-items:stretch; gap:4px; }
.dd-num .dd-input { width:110px; }
.dd-num .dd-step { padding:0 10px; font-size:13px; display:flex; align-items:center; }

/* ── slider / progress / spinner ── */
.dd-slider { display:flex; flex-direction:column; gap:4px; }
.dd-slider .dd-srow { display:flex; justify-content:space-between; font-size:11px; color:var(--dd-dim); }
.dd-slider .dd-track { height:14px; background:var(--dd-panel2); border-radius:7px;
  border:1px solid var(--dd-line); position:relative; }
.dd-slider .dd-fill { position:absolute; top:0; left:0; height:100%; background:var(--dd-accent); border-radius:7px; }
.dd-slider .dd-thumb { position:absolute; top:-3px; width:8px; height:20px; margin-left:-4px;
  background:var(--dd-text); border-radius:4px; border:1px solid var(--dd-line2); }
.dd-slider .dd-track:hover { border-color:var(--dd-accent); }
.dd-slider[data-disabled="true"] { opacity:.45; }

.dd-progress { height:10px; background:var(--dd-panel2); border-radius:5px; overflow:hidden; }
.dd-progress .dd-pfill { height:10px; background:var(--dd-good); border-radius:5px; }
.dd-progress[data-kind="accent"] .dd-pfill { background:var(--dd-accent); }
.dd-progress[data-kind="warn"] .dd-pfill { background:var(--dd-warn); }
.dd-progress[data-kind="bad"] .dd-pfill { background:var(--dd-bad); }

.dd-spinner { width:18px; height:18px; border-radius:10px; border:2px solid var(--dd-line2);
  border-top-color:var(--dd-accent); animation:dd-spin .8s linear infinite; }
@keyframes dd-spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }

/* ── segmented / tabs ── */
.dd-seg { display:flex; gap:4px; background:var(--dd-sink); border-radius:5px;
  padding:3px; width:fit-content; }
.dd-seg .dd-o { padding:5px 16px; border-radius:4px; font-size:11px; color:var(--dd-dim); }
.dd-seg .dd-o:hover { color:var(--dd-text); }
.dd-seg .dd-o[data-on="true"] { background:#2e4361; color:var(--dd-accent); }

.dd-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dd-line); }
.dd-tabs .dd-t { padding:8px 16px; font-size:12px; color:var(--dd-dim);
  border-bottom:2px solid transparent; }
.dd-tabs .dd-t:hover { color:var(--dd-text); }
.dd-tabs .dd-t[data-on="true"] { color:var(--dd-accent); border-bottom-color:var(--dd-accent); }

/* ── dropdown / menus ── */
.dd-dd { position:relative; width:200px; }
.dd-dd .dd-ddbtn { display:flex; justify-content:space-between; align-items:center;
  padding:7px 10px; background:var(--dd-sink); border:1px solid var(--dd-line2);
  border-radius:4px; font-size:12px; }
.dd-dd:hover .dd-ddbtn { border-color:var(--dd-accent); }
.dd-dd .dd-caret { color:var(--dd-dim); font-size:10px; }
.dd-dd .dd-menu { display:none; position:absolute; top:100%; left:0; right:0;
  margin-top:2px; background:var(--dd-panel); border:1px solid var(--dd-line2);
  border-radius:4px; overflow:hidden; }
.dd-dd[data-open="true"] .dd-menu { display:block; }
.dd-menu .dd-mi { padding:7px 10px; font-size:12px; color:var(--dd-text); }
.dd-menu .dd-mi:hover { background:var(--dd-panel2); }
.dd-menu .dd-mi[data-on="true"] { color:var(--dd-accent); }
.dd-menu .dd-msep { height:1px; background:var(--dd-line); }

/* ── list / scroll / table / tree ── */
.dd-list { background:var(--dd-sink); border:1px solid var(--dd-line); border-radius:4px;
  overflow-y:auto; }
.dd-list .dd-li { padding:5px 10px; font-size:12px; color:#c8d0db;
  border-bottom:1px solid var(--dd-panel2); }
.dd-list .dd-li:hover { background:var(--dd-panel2); }
.dd-list .dd-li[data-on="true"] { background:#2e4361; color:var(--dd-accent); }

.dd-scroll { overflow-y:auto; border:1px solid var(--dd-line); border-radius:4px;
  background:var(--dd-sink); padding:8px; }

.dd-table { width:100%; font-size:12px; border-collapse:collapse; }
.dd-table th { text-align:left; padding:6px 8px; color:var(--dd-dim); font-size:11px;
  border-bottom:1px solid var(--dd-line2); }
.dd-table td { padding:6px 8px; border-bottom:1px solid var(--dd-panel2); }
.dd-table tr[data-on="true"] td { background:#2e4361; color:var(--dd-accent); }
.dd-table tr:hover td { background:var(--dd-panel2); }

.dd-tree { font-size:12px; }
.dd-tree .dd-trow { display:flex; align-items:center; gap:6px; padding:3px 6px;
  border-radius:3px; }
.dd-tree .dd-trow:hover { background:var(--dd-panel2); }
.dd-tree .dd-trow[data-on="true"] { background:#2e4361; color:var(--dd-accent); }
.dd-tree .dd-caret { width:12px; color:var(--dd-dim); font-size:9px; text-align:center; }
.dd-tree .dd-kids { margin-left:16px; }
.dd-tree .dd-trow[data-open="false"] + .dd-kids { display:none; }

.dd-acc .dd-ah { display:flex; justify-content:space-between; padding:7px 10px;
  font-size:12px; background:var(--dd-panel2); border:1px solid var(--dd-line);
  border-radius:4px; }
.dd-acc .dd-ah:hover { border-color:var(--dd-line2); }
.dd-acc .dd-ab { padding:8px 10px; font-size:12px; color:#c8d0db;
  border:1px solid var(--dd-line); border-top:none; }
.dd-acc .dd-as[data-open="false"] .dd-ab { display:none; }

/* ── overlays: modal / tooltip / context menu / toast ── */
/* Positive z-index on positioned elements breaks hit-testing in the pinned
   Blitz rev (element leaves the hit tree). Overlays stack by DOM order —
   render modal/ctx/toasts markup LAST in the body. */
.dd-modal { display:none; position:absolute; top:0; left:0; right:0; bottom:0; }
.dd-modal[data-open="true"] { display:block; }
.dd-modal .dd-backdrop { position:absolute; top:0; left:0; right:0; bottom:0;
  background:rgba(4,6,9,.62); }
.dd-modal .dd-dlg { position:absolute; left:50%; top:18%; width:340px; margin-left:-170px;
  background:var(--dd-panel); border:1px solid var(--dd-line2); border-radius:8px;
  padding:16px; }
.dd-modal .dd-dtitle { font-size:14px; font-weight:bold; margin-bottom:10px; }
.dd-modal .dd-dbtns { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }

.dd-tipwrap { position:relative; width:fit-content; }
/* bottom: anchoring resolves wrong in Blitz — tips render BELOW the target
   (top:100%) instead of above it. */
.dd-tipwrap .dd-tip { display:none; position:absolute; top:100%; left:0;
  margin-top:5px; width:140px; padding:5px 8px;
  background:#0b0e13; border:1px solid var(--dd-line2); border-radius:4px;
  font-size:10px; color:var(--dd-dim); }
.dd-tipwrap:hover .dd-tip { display:block; }

.dd-ctx { display:none; position:absolute; min-width:150px;
  background:var(--dd-panel); border:1px solid var(--dd-line2); border-radius:5px;
  overflow:hidden; }
.dd-ctx[data-open="true"] { display:block; }

.dd-toasts { position:absolute; right:14px; top:14px; display:flex;
  flex-direction:column; gap:8px; }
.dd-toast { display:flex; gap:10px; align-items:center; min-width:220px;
  padding:10px 12px; border-radius:6px; font-size:11px;
  background:#1d2a1d; border:1px solid #4a7a4a; color:#9fd89f; }
.dd-toast[data-kind="warn"] { background:#2a2517; border-color:#8a6d3b; color:#e8c88a; }
.dd-toast[data-kind="bad"] { background:#2f1a1a; border-color:#8a4a4a; color:#f0a8a0; }
.dd-toast[data-kind="info"] { background:#182430; border-color:#3d6d94; color:#9fcdf0; }
.dd-toast .dd-x { margin-left:auto; color:var(--dd-dim); padding:0 4px; }
.dd-toast .dd-x:hover { color:var(--dd-text); }

/* ── misc ── */
.dd-toolbar { display:flex; align-items:center; gap:8px; padding:8px 12px;
  background:var(--dd-panel); border:1px solid var(--dd-line); border-radius:6px; }
.dd-kv { display:flex; font-size:12px; }
.dd-kv .dd-k { width:120px; color:var(--dd-dim); font-size:11px; }
.dd-kv .dd-v { color:var(--dd-text); }
.dd-err { font-size:10px; color:var(--dd-bad); min-height:12px; }
`;

/** Full `<style>` tag containing the kit theme — drop into a doc <head>. */
export function kitStyleTag(): string {
  return `<style>${KIT_CSS}</style>`;
}
