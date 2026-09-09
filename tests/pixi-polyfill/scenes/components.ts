// ============================================================================
// components.ts — Remaining basic UI components scene.
//
// Renders checkboxes (checked/unchecked/indeterminate/disabled), radio
// button groups (with a selected option), progress bars (determinate +
// indeterminate), tooltips (with arrow), and panels (titled + bordered).
// These cover the rest of the common UI primitive set.
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import { DEFAULT_BACKGROUND, FONT_FAMILY, type PixiScene, type SceneContext } from "./types";

// ── Checkbox ──
function drawCheckbox(
  parent: Container,
  x: number,
  y: number,
  state: "unchecked" | "checked" | "indeterminate" | "disabled",
  label: string,
): void {
  const c = new Container();
  c.x = x;
  c.y = y;
  const size = 20;
  const disabled = state === "disabled";
  const boxColor = disabled ? 0x333344 : 0x2a2a44;
  const borderColor = disabled ? 0x44445a : 0x6a6a9a;
  const checkColor = disabled ? 0x666677 : 0x44ff88;

  const box = new Graphics();
  box.roundRect(0, 0, size, size, 4).fill({ color: boxColor }).stroke({ width: 2, color: borderColor });
  c.addChild(box);

  if (state === "checked") {
    const ck = new Graphics();
    ck.moveTo(4, 11).lineTo(8, 15).lineTo(16, 5).stroke({ width: 2.5, color: checkColor });
    c.addChild(ck);
  } else if (state === "indeterminate") {
    const dash = new Graphics();
    dash.roundRect(4, 8, 12, 4, 2).fill({ color: checkColor });
    c.addChild(dash);
  }

  const t = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: disabled ? 0x666677 : 0xcccccc },
  });
  t.x = size + 8;
  t.y = 2;
  c.addChild(t);

  parent.addChild(c);
}

// ── Radio button ──
function drawRadio(
  parent: Container,
  x: number,
  y: number,
  selected: boolean,
  label: string,
): void {
  const c = new Container();
  c.x = x;
  c.y = y;
  const r = 9;
  const outer = new Graphics();
  outer.circle(r, r, r).fill({ color: 0x2a2a44 }).stroke({ width: 2, color: 0x6a6a9a });
  c.addChild(outer);
  if (selected) {
    const dot = new Graphics();
    dot.circle(r, r, 4).fill({ color: 0x3a8aff });
    c.addChild(dot);
  }
  const t = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0xcccccc },
  });
  t.x = r * 2 + 8;
  t.y = 1;
  c.addChild(t);
  parent.addChild(c);
}

// ── Progress bar ──
function drawProgress(
  parent: Container,
  x: number,
  y: number,
  w: number,
  ratio: number,
  indeterminate = false,
): void {
  const c = new Container();
  c.x = x;
  c.y = y;
  const h = 14;
  const track = new Graphics();
  track.roundRect(0, 0, w, h, 7).fill({ color: 0x2a2a44 }).stroke({ width: 1, color: 0x4a4a6a });
  c.addChild(track);
  if (indeterminate) {
    const indet = new Graphics();
    const segW = w * 0.3;
    indet.roundRect(w * 0.1, 0, segW, h, 7).fill({ color: 0x3a8aff });
    c.addChild(indet);
  } else {
    const fillW = Math.max(0, Math.min(1, ratio)) * w;
    if (fillW > 0) {
      const fill = new Graphics();
      fill.roundRect(0, 0, fillW, h, 7).fill({ color: 0x3a8aff });
      c.addChild(fill);
    }
  }
  parent.addChild(c);
}

// ── Tooltip ──
function drawTooltip(parent: Container, x: number, y: number, text: string): void {
  const c = new Container();
  c.x = x;
  c.y = y;
  const padX = 8;
  const padY = 5;
  const t = new Text({
    text,
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xffffff },
  });
  const w = Math.ceil(t.width) + padX * 2;
  const h = Math.ceil(t.height) + padY * 2;
  const bg = new Graphics();
  bg.roundRect(0, 0, w, h, 4).fill({ color: 0x111122, alpha: 0.92 }).stroke({ width: 1, color: 0x4a4a6a });
  c.addChild(bg);
  t.x = padX;
  t.y = padY;
  c.addChild(t);
  // Arrow pointing down
  const arrow = new Graphics();
  arrow.moveTo(w / 2 - 5, h).lineTo(w / 2, h + 6).lineTo(w / 2 + 5, h).fill({ color: 0x111122 });
  c.addChild(arrow);
  parent.addChild(c);
}

// ── Panel ──
function drawPanel(
  parent: Container,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const bg = new Graphics();
  bg.roundRect(0, 0, w, h, 8).fill({ color: 0x1e1e30, alpha: 0.9 }).stroke({ width: 1, color: 0x4a4a6a });
  c.addChild(bg);
  const header = new Graphics();
  header.roundRect(0, 0, w, 28, 8).fill({ color: 0x2a2a44 });
  // Square off the bottom of the header so it meets the body cleanly.
  header.rect(0, 20, w, 8).fill({ color: 0x2a2a44 });
  c.addChild(header);
  const t = new Text({
    text: title,
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
  });
  t.x = 12;
  t.y = 6;
  c.addChild(t);
  parent.addChild(c);
  return c;
}

export const componentsScene: PixiScene = {
  id: "components",
  name: "Components",
  category: "components",
  description: "Checkboxes, radio groups, progress bars, tooltips, and panels.",
  build(root: Container, ctx: SceneContext) {
    root.removeChildren();

    const title = new Text({
      text: "Components",
      style: { fontFamily: FONT_FAMILY, fontSize: 24, fill: 0x88aaff },
    });
    title.x = 16;
    title.y = 12;
    root.addChild(title);

    // ── Checkboxes ──
    const cbLabel = new Text({
      text: "Checkboxes",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
    });
    cbLabel.x = 16;
    cbLabel.y = 50;
    root.addChild(cbLabel);
    const cbStates = ["unchecked", "checked", "indeterminate", "disabled"] as const;
    const cbLabels = ["Enable audio", "Enable video", "Mixed", "Locked"];
    for (let i = 0; i < cbStates.length; i++) {
      drawCheckbox(root, 16, 72 + i * 30, cbStates[i], cbLabels[i]);
    }

    // ── Radio group ──
    const rbLabel = new Text({
      text: "Radio",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
    });
    rbLabel.x = 200;
    rbLabel.y = 50;
    root.addChild(rbLabel);
    const radioOpts = ["Low", "Medium", "High", "Ultra"];
    for (let i = 0; i < radioOpts.length; i++) {
      drawRadio(root, 200, 72 + i * 28, i === 1, radioOpts[i]);
    }

    // ── Progress bars ──
    const pbLabel = new Text({
      text: "Progress",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
    });
    pbLabel.x = 320;
    pbLabel.y = 50;
    root.addChild(pbLabel);
    const ratios = [0.2, 0.6, 1];
    for (let i = 0; i < ratios.length; i++) {
      drawProgress(root, 320, 72 + i * 26, 176, ratios[i]);
    }
    drawProgress(root, 320, 72 + 3 * 26, 176, 0, true);
    const indetT = new Text({
      text: "indeterminate",
      style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0x666677 },
    });
    indetT.x = 320;
    indetT.y = 72 + 3 * 26 + 16;
    root.addChild(indetT);

    // ── Tooltip (over the radio column) ──
    drawTooltip(root, 210, 200, "Quality preset");

    // ── Panel at the bottom ──
    const panel = drawPanel(root, 16, 240, 480, 120, "Settings");
    const panelText = new Text({
      text: "A titled panel with a header bar and bordered body.",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0xcccccc },
    });
    panelText.x = 28;
    panelText.y = 44;
    panel.addChild(panelText);
    // A couple of controls inside the panel
    drawCheckbox(panel, 28, 70, "checked", "Apply on save");
    drawProgress(panel, 200, 74, 260, 0.45);

    // ── A second, smaller panel ──
    drawPanel(root, 16, 376, 230, 120, "Status");
    const statusLines = ["FPS: 60", "Ping: 24ms", "Server: online"];
    for (let i = 0; i < statusLines.length; i++) {
      const t = new Text({
        text: statusLines[i],
        style: { fontFamily: FONT_FAMILY, fontSize: 13, fill: 0xcccccc },
      });
      t.x = 28;
      t.y = 40 + i * 22;
      // addChild to the last-added panel; find it via root children
      const panels = root.children.filter((ch) => ch.x === 16 && ch.y === 376);
      (panels[0] as Container).addChild(t);
    }
  },
  background: DEFAULT_BACKGROUND,
};
