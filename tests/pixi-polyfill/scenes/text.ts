// ============================================================================
// text.ts — Text rendering scene.
//
// Exercises PixiJS Text across:
//   - multiple font sizes (12, 16, 24, 36, 48)
//   - multiple fill colors (white, accent, green, red, yellow)
//   - alignment (left, center, right)
//   - multi-line text with word wrap
//   - a title + body + label layout
//
// Uses the shared DejaVu Sans font so the browser reference and native
// FreeType rasterizer render the same glyphs.
// ============================================================================

import { Container, Text } from "pixi.js";
import { DEFAULT_BACKGROUND, FONT_FAMILY, type PixiScene, type SceneContext } from "./types";

export const textScene: PixiScene = {
  id: "text",
  name: "Text",
  category: "text",
  description: "Multiple font sizes, colors, alignments, and word-wrapped multi-line text.",
  // Browser text shaping vs native FreeType rasterization diverge on glyph
  // outlines/AA even with the same TTF — allow a wider mean-diff band.
  maxMeanPerChannel: 16.0,
  build(root: Container, ctx: SceneContext) {
    root.removeChildren();

    // ── Title (large, accent) ──
    const title = new Text({
      text: "PixiJS Text Rendering",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 32,
        fill: 0x88aaff,
        align: "left",
      },
    });
    title.x = 24;
    title.y = 20;
    root.addChild(title);

    // ── Subtitle (medium, white) ──
    const subtitle = new Text({
      text: "browser WebGPU vs native wgpu-native polyfill",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 16,
        fill: 0xcccccc,
        align: "left",
      },
    });
    subtitle.x = 24;
    subtitle.y = 60;
    root.addChild(subtitle);

    // ── Size ladder ──
    const sizes = [12, 16, 24, 36, 48];
    const colors = [0xffffff, 0x00ffaa, 0xff4444, 0xffdd44, 0x88aaff];
    let y = 96;
    for (let i = 0; i < sizes.length; i++) {
      const t = new Text({
        text: `Size ${sizes[i]} — The quick brown fox jumps`,
        style: {
          fontFamily: FONT_FAMILY,
          fontSize: sizes[i],
          fill: colors[i],
          align: "left",
        },
      });
      t.x = 24;
      t.y = y;
      root.addChild(t);
      y += sizes[i] + 10;
    }

    // ── Alignment examples (right-aligned block on the right half) ──
    const alignX = ctx.width / 2 + 16;
    const alignW = ctx.width / 2 - 40;

    const left = new Text({
      text: "Left aligned",
      style: { fontFamily: FONT_FAMILY, fontSize: 18, fill: 0xffffff, align: "left" },
    });
    left.x = alignX;
    left.y = 96;
    root.addChild(left);

    const center = new Text({
      text: "Center aligned",
      style: { fontFamily: FONT_FAMILY, fontSize: 18, fill: 0xffffff, align: "center" },
    });
    center.anchor.x = 0.5;
    center.x = alignX + alignW / 2;
    center.y = 124;
    root.addChild(center);

    const right = new Text({
      text: "Right aligned",
      style: { fontFamily: FONT_FAMILY, fontSize: 18, fill: 0xffffff, align: "right" },
    });
    right.anchor.x = 1;
    right.x = alignX + alignW;
    right.y = 152;
    root.addChild(right);

    // ── Word-wrapped multi-line paragraph ──
    const para = new Text({
      text: "This is a multi-line paragraph that wraps within a fixed width. It exercises the word-wrap layout and line-spacing of the text rasterizer so we can compare glyph positions across backends.",
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 16,
        fill: 0xdddddd,
        align: "left",
        wordWrap: true,
        wordWrapWidth: alignW,
        lineHeight: 22,
      },
    });
    para.x = alignX;
    para.y = 190;
    root.addChild(para);

    // ── Numeric / symbol row ──
    const numeric = new Text({
      text: "0123456789  +-*/=  !@#$%^&*()",
      style: { fontFamily: FONT_FAMILY, fontSize: 20, fill: 0xffdd44, align: "left" },
    });
    numeric.x = 24;
    numeric.y = ctx.height - 40;
    root.addChild(numeric);
  },
  background: DEFAULT_BACKGROUND,
};
