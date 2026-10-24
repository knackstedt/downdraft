// ============================================================================
// theme.ts — shared color tokens + chrome CSS for platinum-devtools.
// Dark-first; light later. RGBA tuples are for GpuTextPass quads, CSS is for
// the html-ui chrome panels.
// ============================================================================

export type Rgba = [number, number, number, number];

export interface ThemeTokens {
  bg: string; bgPanel: string; bgRaised: string; bgHover: string; bgSunken: string;
  border: string; borderSoft: string;
  text: string; textDim: string; textFaint: string;
  accent: string; accentSoft: string; accent2: string;
  sevError: string; sevWarn: string; sevInfo: string; sevDebug: string; sevTrace: string;
  ok: string; warn: string; err: string; error: string;
  link: string; caret: string;
  synKeyword: string; synString: string; synComment: string; synNumber: string;
  synType: string; synBuiltin: string; synOperator: string; synPlain: string; synProperty: string;
  mono: string;
}

export function tokens(_theme: "dark" | "light" = "dark"): ThemeTokens {
  return {
    bg: "#141619",
    bgPanel: "#1a1d21",
    bgRaised: "#21252a",
    bgHover: "#2a2f36",
    border: "#343a42",
    borderSoft: "#262b31",
    text: "#dde3ea",
    textDim: "#9aa4b0",
    textFaint: "#626c78",
    accent: "#4f9cf9",
    accentSoft: "#253b52",
    sevError: "#f47067",
    sevWarn: "#e8b04b",
    sevInfo: "#7ab3f0",
    sevDebug: "#9a8cf0",
    sevTrace: "#6b7280",
    ok: "#5ec98a",
    warn: "#e8b04b",
    err: "#f47067",
    error: "#f47067",
    link: "#7ab3f0",
    caret: "#4f9cf9",
    bgSunken: "#101215",
    accent2: "#9a8cf0",
    synKeyword: "#c586d6",
    synString: "#9ece6a",
    synComment: "#5c6673",
    synNumber: "#e8b04b",
    synType: "#4fd6be",
    synBuiltin: "#e5c07b",
    synOperator: "#c0c8d3",
    synPlain: "#dde3ea",
    synProperty: "#7ab3f0",
    mono: "'JetBrains Mono', monospace",
  };
}

/** hex css → premultiplied-ish Rgba for quad drawing. */
export function hex(hexColor: string, a = 1): Rgba {
  const n = parseInt(hexColor.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

/** A theme color at a custom alpha. */
export function chroma(hexColor: string, a: number): Rgba {
  return hex(hexColor, a);
}

// ── Severity → token ──
export function sevColor(t: ThemeTokens, sev: number): string {
  switch (sev) {
    case 3: return t.sevError;
    case 2: return t.sevWarn;
    case 1: return t.sevInfo;
    case 4: return t.sevDebug;
    case 5: return t.sevTrace;
    default: return t.text;
  }
}

export function chromeCss(t: ThemeTokens): string {
  return `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Inter, 'Inter Medium', 'Inter SemiBold', 'Inter Bold', sans-serif; color: ${t.text}; background: transparent; }
.pt-panel { background: ${t.bgPanel}; width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.pt-col { display: flex; flex-direction: column; }
.pt-row { display: flex; flex-direction: row; align-items: center; }

.pt-title { font-size: 12px; font-weight: 600; color: ${t.textDim}; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px 10px; }

/* ── target sidebar ── */
.target { padding: 7px 10px; border-bottom: 1px solid ${t.borderSoft}; cursor: pointer; position: relative; }
.target .tctl { color: ${t.warn}; }
.target .tctl:hover { color: ${t.err}; border-color: ${t.err}; }
.target:hover { background: ${t.bgHover}; }
.target.active { background: ${t.accentSoft}; border-left: 2px solid ${t.accent}; }
.target.lost { opacity: 0.45; }
.target.lost .tname { text-decoration: line-through; }
.target .tname { font-size: 13px; color: ${t.text}; }
.target .tsub { font-size: 11px; color: ${t.textFaint}; margin-top: 2px; }
.target .tbadges { margin-top: 3px; display: flex; gap: 4px; flex-wrap: wrap; }
.badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: ${t.bgRaised}; color: ${t.textDim}; border: 1px solid ${t.borderSoft}; }
.badge.on { color: ${t.ok}; border-color: ${t.ok}; }
.badge.warn { color: ${t.warn}; }

/* ── tab strip ── */
.tabs { display: flex; flex-direction: row; align-items: center; height: 30px; background: ${t.bg}; border-bottom: 1px solid ${t.borderSoft}; overflow: hidden; }
.tab { font-size: 12px; color: ${t.textDim}; padding: 0 12px; height: 30px; display: flex; align-items: center; cursor: pointer; border-bottom: 2px solid transparent; }
.tab:hover { color: ${t.text}; background: ${t.bgHover}; }
.tab.on { color: ${t.text}; border-bottom-color: ${t.accent}; }
.tab .x { margin-left: 6px; color: ${t.textFaint}; }
.tab .x:hover { color: ${t.err}; }
.tabspacer { flex: 1; }

/* ── buttons/chips ── */
.dbtn { font-size: 11px; color: ${t.textDim}; padding: 3px 8px; border: 1px solid ${t.borderSoft}; border-radius: 4px; background: ${t.bgRaised}; cursor: pointer; margin-right: 6px; }
.dbtn:hover { color: ${t.text}; background: ${t.bgHover}; }
.dbtn.on { color: ${t.accent}; border-color: ${t.accent}; }
.attach-in { width: 100%; box-sizing: border-box; font-size: 11px; font-family: "JetBrains Mono", monospace; color: ${t.text}; background: ${t.bgSunken}; border: 1px solid ${t.border}; border-radius: 4px; padding: 4px 6px; }
.attach-in:focus { border-color: ${t.accent}; outline: none; }
.attach-hint { font-size: 10px; color: ${t.textFaint}; margin-bottom: 5px; }
.chip { font-size: 10px; color: ${t.textDim}; padding: 1px 6px; border-radius: 8px; background: ${t.bgRaised}; margin-right: 4px; cursor: pointer; }
.chip.on { color: ${t.accent}; }
.mono { font-family: 'JetBrains Mono', monospace; }

/* ── dock grips ── */
.grip { height: 4px; background: ${t.borderSoft}; cursor: ns-resize; }
.grip:hover { background: ${t.accent}; }
.grip-v { width: 4px; height: 100%; cursor: ew-resize; }

/* ── generic scroll container ── */
.scroll { overflow-y: auto; }
.empty { color: ${t.textFaint}; font-size: 12px; padding: 20px; text-align: center; }

/* ── status line ── */
.statusbar { display: flex; align-items: center; height: 22px; font-size: 11px; color: ${t.textFaint}; padding: 0 10px; border-top: 1px solid ${t.borderSoft}; gap: 12px; }
`;
}
