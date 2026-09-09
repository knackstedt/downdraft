// ============================================================================
// buttons.ts — Button component scene.
//
// Renders buttons in the four standard states (idle, hover, pressed,
// disabled) plus variants (primary, secondary, danger) and sizes (small,
// medium, large). Exercises Graphics (rounded rects + strokes), Text
// labels, and Container transforms (nested button groups).
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import { DEFAULT_BACKGROUND, FONT_FAMILY, type PixiScene, type SceneContext } from "./types";

interface ButtonStyle {
  bg: number;
  bgAlpha: number;
  border: number;
  borderWidth: number;
  text: number;
}

const STYLES: Record<string, ButtonStyle> = {
  idle: { bg: 0x2a2a44, bgAlpha: 1, border: 0x6a6a9a, borderWidth: 2, text: 0xffffff },
  hover: { bg: 0x3a3a5a, bgAlpha: 1, border: 0x8a8acc, borderWidth: 2, text: 0xffffff },
  pressed: { bg: 0x1a1a30, bgAlpha: 1, border: 0x6a6a9a, borderWidth: 2, text: 0xccccff },
  disabled: { bg: 0x222230, bgAlpha: 1, border: 0x44445a, borderWidth: 1, text: 0x666677 },
};

const VARIANTS: Record<string, ButtonStyle> = {
  primary: { bg: 0x3a6aff, bgAlpha: 1, border: 0x6a8aff, borderWidth: 2, text: 0xffffff },
  secondary: { bg: 0x2a2a44, bgAlpha: 1, border: 0x6a6a9a, borderWidth: 2, text: 0xffffff },
  danger: { bg: 0xaa3333, bgAlpha: 1, border: 0xcc5555, borderWidth: 2, text: 0xffffff },
};

function drawButton(
  parent: Container,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  style: ButtonStyle,
  fontSize: number,
): Container {
  const c = new Container();
  c.x = x;
  c.y = y;

  const bg = new Graphics();
  bg.roundRect(0, 0, w, h, 6).fill({ color: style.bg, alpha: style.bgAlpha });
  bg.roundRect(0, 0, w, h, 6).stroke({ width: style.borderWidth, color: style.border });
  c.addChild(bg);

  const t = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize, fill: style.text, align: "center" },
  });
  t.anchor.set(0.5);
  t.x = w / 2;
  t.y = h / 2;
  c.addChild(t);

  parent.addChild(c);
  return c;
}

export const buttonsScene: PixiScene = {
  id: "buttons",
  name: "Buttons",
  category: "components",
  description: "Button states (idle/hover/pressed/disabled), variants, and sizes.",
  build(root: Container, _ctx: SceneContext) {
    root.removeChildren();

    // ── Section title ──
    const title = new Text({
      text: "Buttons",
      style: { fontFamily: FONT_FAMILY, fontSize: 24, fill: 0x88aaff },
    });
    title.x = 16;
    title.y = 12;
    root.addChild(title);

    // ── States row ──
    const states = ["idle", "hover", "pressed", "disabled"] as const;
    const bw = 104;
    const bh = 36;
    const gap = 12;
    let x = 16;
    let y = 56;
    for (const s of states) {
      drawButton(root, x, y, bw, bh, s.charAt(0).toUpperCase() + s.slice(1), STYLES[s], 16);
      x += bw + gap;
    }

    // ── Variants row ──
    x = 16;
    y += bh + 20;
    const variants = ["primary", "secondary", "danger"] as const;
    for (const v of variants) {
      drawButton(root, x, y, bw, bh, v.charAt(0).toUpperCase() + v.slice(1), VARIANTS[v], 16);
      x += bw + gap;
    }

    // ── Sizes row ──
    x = 16;
    y += bh + 20;
    const sizes: Array<{ w: number; h: number; fs: number; label: string }> = [
      { w: 72, h: 26, fs: 12, label: "Small" },
      { w: 104, h: 36, fs: 16, label: "Medium" },
      { w: 140, h: 48, fs: 20, label: "Large" },
    ];
    for (const s of sizes) {
      drawButton(root, x, y, s.w, s.h, s.label, STYLES.idle, s.fs);
      x += s.w + gap;
    }

    // ── Icon-ish buttons (square + glyph) ──
    x = 16;
    y += 60;
    const iconColors = [0x44ddff, 0xff8844, 0x44ff44];
    for (let i = 0; i < iconColors.length; i++) {
      const c = new Container();
      c.x = x + i * 44;
      c.y = y;
      const bg = new Graphics();
      bg.roundRect(0, 0, 36, 36, 8).fill({ color: 0x2a2a44 }).stroke({ width: 2, color: iconColors[i] });
      c.addChild(bg);
      // A simple "+" / "-" / "x" glyph drawn with Graphics lines.
      const gx = new Graphics();
      const ccx = 18, ccy = 18;
      if (i === 0) {
        gx.moveTo(ccx - 8, ccy).lineTo(ccx + 8, ccy).stroke({ width: 3, color: iconColors[i] });
        gx.moveTo(ccx, ccy - 8).lineTo(ccx, ccy + 8).stroke({ width: 3, color: iconColors[i] });
      } else if (i === 1) {
        gx.moveTo(ccx - 8, ccy).lineTo(ccx + 8, ccy).stroke({ width: 3, color: iconColors[i] });
      } else {
        gx.moveTo(ccx - 7, ccy - 7).lineTo(ccx + 7, ccy + 7).stroke({ width: 3, color: iconColors[i] });
        gx.moveTo(ccx + 7, ccy - 7).lineTo(ccx - 7, ccy + 7).stroke({ width: 3, color: iconColors[i] });
      }
      c.addChild(gx);
      root.addChild(c);
    }

    // ── Full-width button at the bottom ──
    drawButton(root, 16, 200, 480, 44, "Continue", STYLES.idle, 18);
  },
  background: DEFAULT_BACKGROUND,
};
