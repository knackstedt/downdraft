// ============================================================================
// svg-object-fit.spec.ts — component test page for the vendored blitz-paint
// patch (draw_svg honors preserveAspectRatio / object-fit instead of pinning
// ObjectFit::Contain — see vendor/blitz-paint + root Cargo.toml [patch]).
//
// Functional coverage, one absolutely-positioned card per case:
//   - preserveAspectRatio="none" fills the element box (was letterboxed)
//   - absent / "meet" / "defer … meet" / empty / malformed → Contain
//   - "slice" → Cover (incl. xMidYMin vs xMidYMax crop direction)
//   - xMin/xMax alignment inside the contained band
//   - CSS object-fit beats the attribute when non-initial (cover/contain)
//   - explicit width/height <svg> (usvg-internal path) is unchanged
//   - html5ever-lowered `preserveaspectratio` still matches
//   - setAttr re-fits both ways: preserveAspectRatio is read live at paint,
//     and geometry attrs (viewBox) re-fit via construct-damage reparse
//
// Perf battery (numbers logged, bounds kept generous — this runs against a
// vello_cpu rasterizer on whatever machine has the cdylib built):
//   first-frame cost of the full page, per-tick chart innerHTML churn,
//   resize sweep, and sparkline-count paint scaling.
//
// Skips when the cdylib isn't built — same as the other osr specs.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { OsrDoc } from "./native-osr-ffi";

// OsrDoc resolves via crateDir candidates (dist/<plat> → dist → target) —
// gate on whichever actually exists so the spec still skips in CI.
const LIB_CANDIDATES = [
  "../native-osr/dist/linux-x64/libdowndraft_blitz_osr.so",
  "../native-osr/dist/darwin-arm64/libdowndraft_blitz_osr.dylib",
  "../native-osr/dist/libdowndraft_blitz_osr.so",
  "../native-osr/target/release/libdowndraft_blitz_osr.so",
];
const haveLib =
  !!process.env.DOWNDRAFT_OSR_LIB ||
  LIB_CANDIDATES.some((p) => existsSync(resolve(import.meta.dir, p)));

const W = 1280;
const H = 960;

// ── Component page ─────────────────────────────────────────────────────────
// Cards are 400×140 on a 20/440/860 column grid (rows every 160px). Every
// <svg> spans its card edge-to-edge; the letterbox band lands inside the
// svg's own content box, so card-local sampling = page-local offsets.
//
// Ink: full-bleed rects/polylines in #ff0000 (split cards use #00ff00 for
// the bottom half). Background: #0a0e14 body.

const RECT = `<rect x="0" y="0" width="100" height="100" fill="#ff0000"/>`;
const SPLIT = `<rect x="0" y="0" width="100" height="50" fill="#ff0000"/>` +
  `<rect x="0" y="50" width="100" height="50" fill="#00ff00"/>`;

const svg = (par: string, css = "", inner = RECT) =>
  `<svg style="display:block;width:400px;height:140px;${css}" ` +
  `viewBox="0 0 100 100" ${par}>${inner}</svg>`;

// Anableps-chart shape: area fill + stroked line, non-uniform stretch.
const chartSvg = (w: number, seed: number) => {
  const pts: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const x = ((i / 80) * w).toFixed(1);
    const y = (55 - (Math.sin(seed + i * 0.37) * 0.5 + 0.5) * 48).toFixed(1);
    pts.push(`${x},${y}`);
  }
  return (
    `<svg style="display:block;width:${w}px;height:120px" viewBox="0 0 ${w} 60" preserveAspectRatio="none">` +
    `<polygon points="0,60 ${pts.join(" ")} ${w},60" fill="#4fc3f7" fill-opacity="0.25" stroke="none"/>` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="#4fc3f7" stroke-width="2"/>` +
    `</svg>`
  );
};

// Sparkline swarm — many small par="none" svgs, the steady-state load shape.
const sparklines = (n: number, cellW: number, cellH: number, cols: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * cellW;
    const cy = Math.floor(i / cols) * cellH;
    const pts = Array.from({ length: 8 }, (_, k) => {
      const x = ((k / 7) * (cellW - 4)).toFixed(1);
      const y = ((cellH - 4) * (0.2 + 0.6 * Math.abs(Math.sin(i * 3 + k)))).toFixed(1);
      return `${x},${y}`;
    }).join(" ");
    out.push(
      `<svg style="position:absolute;left:${cx}px;top:${cy}px;width:${cellW - 4}px;height:${cellH - 4}px" ` +
        `viewBox="0 0 ${cellW - 4} ${cellH - 4}" preserveAspectRatio="none">` +
        `<polyline points="${pts}" fill="none" stroke="#81c784" stroke-width="1.5"/></svg>`,
    );
  }
  return out.join("");
};

const PAGE = `<html><body style="margin:0;background:#0a0e14">
  <div id="chart-host" style="position:absolute;left:20px;top:820px;width:820px;height:120px;background:#0d1420">${chartSvg(820, 1)}</div>
  <div id="swarm" style="position:absolute;left:860px;top:820px;width:400px;height:120px">${sparklines(12, 66, 40, 6)}</div>
  ${svg('preserveAspectRatio="none"', "position:absolute;left:20px;top:20px")}
  ${svg("", "position:absolute;left:440px;top:20px")}
  ${svg('preserveAspectRatio="xMidYMid slice"', "position:absolute;left:860px;top:20px")}
  ${svg('preserveAspectRatio="xMinYMin meet"', "position:absolute;left:20px;top:180px")}
  ${svg('preserveAspectRatio="xMaxYMax meet"', "position:absolute;left:440px;top:180px")}
  ${svg('preserveAspectRatio="xMidYMin slice"', "position:absolute;left:860px;top:180px", SPLIT)}
  ${svg('preserveAspectRatio="xMidYMax slice"', "position:absolute;left:20px;top:340px", SPLIT)}
  ${svg('preserveAspectRatio="xMidYMid meet"', "position:absolute;left:440px;top:340px;object-fit:cover")}
  ${svg('preserveAspectRatio="none"', "position:absolute;left:860px;top:340px;object-fit:contain")}
  ${svg('preserveAspectRatio="xMidYMid meet"', "position:absolute;left:20px;top:500px;object-fit:none")}
  ${`<svg id="meet-svg" style="display:block;position:absolute;left:440px;top:500px;width:400px;height:140px" ` +
    `viewBox="0 0 100 100">${RECT}</svg>`}
  ${svg('preserveAspectRatio="bogus tokens here"', "position:absolute;left:860px;top:500px")}
  ${svg('preserveAspectRatio=""', "position:absolute;left:20px;top:660px")}
  ${svg('preserveaspectratio="none"', "position:absolute;left:440px;top:660px")}
  ${svg('preserveAspectRatio="defer xMidYMid meet"', "position:absolute;left:860px;top:660px")}
</body></html>`;

// The wh-attrs card goes through usvg's internal viewBox→size transform
// (tree.size() == element box) — separate doc so its fixed 400×140 element
// size can't be confused with the CSS-sized cards.
const WH_PAGE = `<html><body style="margin:0;background:#0a0e14">
  <svg width="400" height="140" style="display:block;position:absolute;left:20px;top:20px" viewBox="0 0 100 100" preserveAspectRatio="none">${RECT}</svg>
  <svg width="400" height="140" style="display:block;position:absolute;left:440px;top:20px" viewBox="0 0 100 100">${RECT}</svg>
</body></html>`;

// ── Pixel helpers ──────────────────────────────────────────────────────────

type Px = [number, number, number, number];
const px = (buf: Uint8Array, x: number, y: number): Px => {
  const i = (y * W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
};
const isRed = ([r, g, b]: Px) => r > 200 && g < 70 && b < 70;
const isGreen = ([r, g, b]: Px) => g > 200 && r < 70 && b < 70;
const isBg = ([r, g, b]: Px) => r < 0x30 && g < 0x30 && b < 0x40;
const isInk = ([r, g, b]: Px) => !isBg([r, g, b, 255]);

function openPage(html = PAGE) {
  const doc = OsrDoc.create(W, H, 1, html);
  if (!doc) throw new Error("OsrDoc.create failed");
  const buf = doc.frame();
  if (!buf) throw new Error("first frame returned null");
  return { doc, buf };
}

const fmt = (s: ReturnType<OsrDoc["lastStats"]>) =>
  s ? `resolve=${s.resolveMs.toFixed(1)}ms paint=${s.paintMs.toFixed(1)}ms diff=${s.diffMs.toFixed(1)}ms` : "n/a";

// ── Functional: fit semantics per component ────────────────────────────────

describe.skipIf(!haveLib)("svg object-fit component page (vendored blitz-paint)", () => {
  // Card sample points (page coords): right edge / center / left of each
  // 400×140 card. With a 100×100 viewBox:
  //   Fill/Cover → whole card ink
  //   Contain    → 140×140 band; xMin→[0,140], xMid→[130,270], xMax→[260,400]

  it('preserveAspectRatio="none" stretches to fill the element box', () => {
    const { doc, buf } = openPage();
    expect(isRed(px(buf, 410, 90))).toBe(true);   // right edge — was letterboxed
    expect(isRed(px(buf, 30, 90))).toBe(true);    // left edge
    expect(isRed(px(buf, 220, 90))).toBe(true);   // center
    doc.destroy();
  });

  it("absent attribute keeps the spec default (meet → contained band)", () => {
    const { doc, buf } = openPage();
    expect(isRed(px(buf, 600, 90))).toBe(true);   // inside 130..270 band (440+160)
    expect(isBg(px(buf, 450, 90))).toBe(true);    // letterbox left of band
    expect(isBg(px(buf, 820, 90))).toBe(true);    // letterbox right of band
    doc.destroy();
  });

  it('"xMidYMid slice" covers the box and crops overflow', () => {
    const { doc, buf } = openPage();
    expect(isRed(px(buf, 870, 90))).toBe(true);   // left edge
    expect(isRed(px(buf, 1250, 90))).toBe(true);  // right edge
    doc.destroy();
  });

  it("meet alignment pins the contained band (xMin left, xMax right)", () => {
    const { doc, buf } = openPage();
    // xMinYMin card at x=20 → band x∈[20,160]
    expect(isRed(px(buf, 30, 250))).toBe(true);
    expect(isBg(px(buf, 300, 250))).toBe(true);
    // xMaxYMax card at x=440 → band x∈[700,840]
    expect(isRed(px(buf, 830, 250))).toBe(true);
    expect(isBg(px(buf, 500, 250))).toBe(true);
    doc.destroy();
  });

  it("slice crop direction honors the align axis", () => {
    const { doc, buf } = openPage();
    // xMidYMin keeps the top of the over-scaled rect visible → all red
    expect(isRed(px(buf, 1060, 250))).toBe(true);
    expect(isGreen(px(buf, 1060, 310))).toBe(false);
    // xMidYMax keeps the bottom visible → all green
    expect(isGreen(px(buf, 220, 410))).toBe(true);
    expect(isRed(px(buf, 220, 350))).toBe(false);
    doc.destroy();
  });

  it("explicit CSS object-fit beats the attribute when non-initial", () => {
    const { doc, buf } = openPage();
    // meet attr + object-fit:cover → covers (red at edges)
    expect(isRed(px(buf, 450, 410))).toBe(true);
    expect(isRed(px(buf, 830, 410))).toBe(true);
    // none attr + object-fit:contain → letterboxed (bg at edges)
    expect(isBg(px(buf, 870, 410))).toBe(true);
    expect(isRed(px(buf, 1060, 410))).toBe(true);
    doc.destroy();
  });

  it("object-fit:none renders at intrinsic size, centered", () => {
    const { doc, buf } = openPage();
    // Card x∈[20,420]; intrinsic 100×100 centered → band x∈[170,270]
    expect(isBg(px(buf, 40, 570))).toBe(true);
    expect(isRed(px(buf, 220, 570))).toBe(true);
    expect(isBg(px(buf, 400, 570))).toBe(true);
    doc.destroy();
  });

  it("malformed and empty attribute values fall back to Contain", () => {
    const { doc, buf } = openPage();
    // bogus → Contain: bg edges, ink center
    expect(isBg(px(buf, 870, 570))).toBe(true);
    expect(isRed(px(buf, 1060, 570))).toBe(true);
    // empty → Contain
    expect(isBg(px(buf, 30, 730))).toBe(true);
    expect(isRed(px(buf, 220, 730))).toBe(true);
    doc.destroy();
  });

  it('lowercase "preserveaspectratio" is honored (html5ever lowercases names)', () => {
    const { doc, buf } = openPage();
    expect(isRed(px(buf, 830, 730))).toBe(true);
    expect(isRed(px(buf, 450, 730))).toBe(true);
    doc.destroy();
  });

  it('"defer … meet" parses through the align/mode tokens', () => {
    const { doc, buf } = openPage();
    expect(isBg(px(buf, 870, 730))).toBe(true);
    expect(isRed(px(buf, 1060, 730))).toBe(true);
    doc.destroy();
  });

  it("sparkline swarm svgs each fill their cell", () => {
    const { doc, buf } = openPage();
    // Cells are 66×40 starting at (860,820). A letterboxed (Contain) cell
    // would ink only the center ~40px; par=none must reach the cell's
    // horizontal extremes. Count ink in the outer 8px strips of cell (0,0).
    const inkInStrip = (x0: number, x1: number, y0: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y += 2)
        for (let x = x0; x < x1; x += 2) if (isInk(px(buf, x, y))) n++;
      return n;
    };
    expect(inkInStrip(862, 870, 822, 856)).toBeGreaterThan(0); // left strip
    expect(inkInStrip(914, 922, 822, 856)).toBeGreaterThan(0); // right strip (cell w 62)
    doc.destroy();
  });

  it("chart card: par=none polyline spans the host edge-to-edge", () => {
    const { doc, buf } = openPage();
    const r = doc.query("#chart-host");
    const rect = doc.nodeRect(r)!;
    expect(Math.round(rect.w)).toBe(820);
    // Area fill (25% #4fc3f7 over dark card) must reach the host's right
    // edge — scan a vertical strip just inside it.
    let ink = 0;
    for (let y = 826; y < 936; y += 2) if (isInk(px(buf, 834, y))) ink++;
    expect(ink).toBeGreaterThan(0);
    doc.destroy();
  });
});

// ── Functional: intrinsic-size path and live mutation ──────────────────────

describe.skipIf(!haveLib)("svg object-fit — intrinsic size + mutation", () => {
  it('explicit width/height <svg> still honors par="none" via usvg internals', () => {
    const { doc, buf } = openPage(WH_PAGE);
    // par=none → stretches 1:1 viewBox to 4:1 element
    expect(isRed(px(buf, 410, 90))).toBe(true);
    expect(isRed(px(buf, 30, 90))).toBe(true);
    // no attr → usvg meet → contained band (140 wide centered in 400)
    expect(isRed(px(buf, 640, 90))).toBe(true);
    expect(isBg(px(buf, 450, 90))).toBe(true);
    doc.destroy();
  });

  it("setAttr on preserveAspectRatio re-fits on the next frame", () => {
    const { doc, buf } = openPage();
    const n = doc.query("#meet-svg");
    expect(n).not.toBe(0);
    // Initial: meet → letterboxed
    expect(isBg(px(buf, 450, 570))).toBe(true);

    expect(doc.setAttr(n, "preserveAspectRatio", "none")).toBe(true);
    expect(doc.pending()).toBe(true);
    const buf2 = doc.frame()!;
    expect(buf2).not.toBeNull();
    expect(isRed(px(buf2, 450, 570))).toBe(true);
    expect(isRed(px(buf2, 830, 570))).toBe(true);

    // Toggle back — attrs are read at paint, not baked.
    expect(doc.setAttr(n, "preserveAspectRatio", "xMidYMid meet")).toBe(true);
    const buf3 = doc.frame()!;
    expect(isBg(px(buf3, 450, 570))).toBe(true);
    expect(isRed(px(buf3, 640, 570))).toBe(true);
    doc.destroy();
  });

  it("viewBox mutation re-fits — attribute damage rebuilds the usvg tree", () => {
    // Contract test for the incremental-DOM API: set_attribute marks
    // ALL_DAMAGE, and layout/construct.rs re-serializes the svg's outer_html
    // through usvg whenever the node has construct damage — so geometry
    // attributes are mutable. preserveAspectRatio is additionally read live
    // at paint time by our patch.
    const { doc, buf } = openPage();
    const n = doc.query("#meet-svg");
    expect(isRed(px(buf, 700, 570))).toBe(true); // initial 1:1 band is 570..710

    // Widen the viewBox 2:1 — contain paints 280×140 centered (500..780),
    // and the 100-wide rect covers only the viewBox's left half → 500..640.
    expect(doc.setAttr(n, "viewBox", "0 0 200 100")).toBe(true);
    const buf2 = doc.frame()!;
    expect(buf2).not.toBeNull();
    expect(isRed(px(buf2, 560, 570))).toBe(true);
    expect(isBg(px(buf2, 700, 570))).toBe(true); // was red under the 1:1 fit
    expect(isBg(px(buf2, 790, 570))).toBe(true);
    doc.destroy();
  });
});

// ── Performance battery ────────────────────────────────────────────────────

describe.skipIf(!haveLib)("svg object-fit — perf battery", () => {
  it("first-frame cost of the full component page", () => {
    const t0 = performance.now();
    const { doc } = openPage();
    const wallMs = performance.now() - t0;
    const s = doc.lastStats();
    console.log(`    full page (${W}x${H}, 16 svg components): ${fmt(s)} wall=${wallMs.toFixed(0)}ms`);
    expect(s!.paintMs).toBeGreaterThan(0);
    expect(wallMs).toBeLessThan(5000); // vello_cpu on any sane dev box
    doc.destroy();
  });

  it("chart-tick churn: setInnerHtml + frame stays in tick budget", () => {
    const { doc } = openPage();
    const host = doc.query("#chart-host");
    expect(host).not.toBe(0);
    const N = 60; // ~1min of a 1s metrics tick
    let paint = 0;
    let resolve = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      expect(doc.setInnerHtml(host, chartSvg(820, i * 0.13))).toBe(true);
      expect(doc.frame()).not.toBeNull();
      const s = doc.lastStats()!;
      paint += s.paintMs;
      resolve += s.resolveMs;
    }
    const wallMs = performance.now() - t0;
    console.log(
      `    ${N} chart redraws (820x120 par=none): avg paint=${(paint / N).toFixed(2)}ms ` +
        `resolve=${(resolve / N).toFixed(2)}ms wall=${(wallMs / N).toFixed(2)}ms`,
    );
    // A 1Hz tick with this much headroom should never be close.
    expect(wallMs / N).toBeLessThan(250);
    doc.destroy();
  });

  it("attr-only toggle churn avoids reparse and stays cheap", () => {
    const { doc } = openPage();
    const n = doc.query("#meet-svg");
    const N = 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      doc.setAttr(n, "preserveAspectRatio", i % 2 ? "none" : "xMidYMid meet");
      doc.frame();
    }
    const wallMs = performance.now() - t0;
    console.log(`    ${N} attr toggles: avg wall=${(wallMs / N).toFixed(2)}ms`);
    expect(wallMs / N).toBeLessThan(150);
    doc.destroy();
  });

  it("resize sweep (window-drag shape) stays responsive", () => {
    const { doc } = openPage();
    // Start above the initial 1280 — a same-size resize is a no-op and
    // frame() correctly returns null for a clean document.
    const widths = [1400, 1600, 1920, 1600, 1400, 1280];
    const t0 = performance.now();
    for (let _i = 0, _it = widths, _n = _it.length; _i < _n; _i++) { const w = _it[_i];
      doc.resize(w, H, 1);
      expect(doc.frame()).not.toBeNull();
    }
    const wallMs = performance.now() - t0;
    const s = doc.lastStats()!;
    console.log(`    ${widths.length} resizes ≤1920 wide: total wall=${wallMs.toFixed(0)}ms last-frame ${fmt(s)}`);
    expect(wallMs / widths.length).toBeLessThan(1500);
    doc.destroy();
  });

  it("paint cost scales sub-linearly-ish with sparkline count", () => {
    const swarmPage = (n: number) => `<html><body style="margin:0;background:#0a0e14">
      <div id="swarm" style="position:absolute;left:0;top:0;width:1200px;height:900px">${sparklines(n, 80, 50, 15)}</div>
    </body></html>`;
    const time = (n: number) => {
      const d = OsrDoc.create(W, H, 1, swarmPage(n))!;
      d.frame();
      const s = d.lastStats()!;
      d.destroy();
      return s.paintMs;
    };
    const p12 = time(12);
    const p96 = time(96);
    console.log(`    sparklines: 12→${p12.toFixed(1)}ms paint, 96→${p96.toFixed(1)}ms paint (${(p96 / p12).toFixed(1)}x for 8x)`);
    // 8x components should be well under 8x paint (fixed scene overhead amortizes);
    // keep the bound loose — this guards catastrophic regressions, not scaling shape.
    expect(p96).toBeLessThan(Math.max(p12 * 8, 100));
  });
});
