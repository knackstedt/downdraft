// ============================================================================
// graphics.ts — Graphics primitives scene.
//
// Exercises PixiJS Graphics across the primitive set that UI components are
// built from: filled rects, rounded rects, circles, ellipses, lines, strokes
// of varying width, polygons, and alpha. These are pure GPU geometry (no
// text rasterization), so the browser and native renderers should match
// very closely.
// ============================================================================

import { Container, Graphics } from "pixi.js";
import { DEFAULT_BACKGROUND, type PixiScene, type SceneContext } from "./types";

export const graphicsScene: PixiScene = {
  id: "graphics",
  name: "Graphics",
  category: "graphics",
  description: "Filled rects, rounded rects, circles, ellipses, lines, strokes, polygons, alpha.",
  build(root: Container, ctx: SceneContext) {
    root.removeChildren();

    const g = new Graphics();
    root.addChild(g);

    // ── Row 1: filled rects in a palette ──
    const palette = [0xff4444, 0xff8844, 0xffdd44, 0x44ff44, 0x44ddff, 0x8844ff];
    const rectW = 64;
    const gap = 8;
    const startX = 16;
    let y = 16;
    for (let i = 0; i < palette.length; i++) {
      g.rect(startX + i * (rectW + gap), y, rectW, rectW).fill({ color: palette[i] });
    }

    // ── Row 2: rounded rects with varying radius ──
    y += rectW + 16;
    const radii = [0, 6, 12, 24, 32];
    for (let i = 0; i < radii.length; i++) {
      g.roundRect(startX + i * (rectW + gap), y, rectW, rectW, radii[i]).fill({ color: 0x4a6a8a });
    }

    // ── Row 3: strokes of varying width ──
    y += rectW + 16;
    const widths = [1, 2, 4, 8, 16];
    for (let i = 0; i < widths.length; i++) {
      g.rect(startX + i * (rectW + gap), y, rectW, rectW)
        .stroke({ width: widths[i], color: 0xffdd44 });
    }

    // ── Row 4: filled + stroked circles ──
    y += rectW + 16;
    const r = rectW / 2;
    for (let i = 0; i < palette.length; i++) {
      const cx = startX + i * (rectW + gap) + r;
      const cy = y + r;
      g.circle(cx, cy, r - 2).fill({ color: palette[i] });
      g.circle(cx, cy, r - 2).stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
    }

    // ── Row 5: ellipses ──
    y += rectW + 16;
    for (let i = 0; i < palette.length; i++) {
      const cx = startX + i * (rectW + gap) + r;
      const cy = y + r;
      g.ellipse(cx, cy, r - 4, (r - 4) * 0.6).fill({ color: palette[i], alpha: 0.85 });
    }

    // ── Row 6: lines (moveTo/lineTo) ──
    y += rectW + 16;
    const lineColors = [0xffffff, 0x88aaff, 0x00ffaa, 0xff4444];
    for (let i = 0; i < lineColors.length; i++) {
      const x0 = startX + i * (rectW + gap);
      g.moveTo(x0, y).lineTo(x0 + rectW, y + rectW).stroke({ width: 3, color: lineColors[i] });
      g.moveTo(x0 + rectW, y).lineTo(x0, y + rectW).stroke({ width: 3, color: lineColors[i] });
    }

    // ── Bottom-right: a polygon (star) ──
    const starCx = ctx.width - 70;
    const starCy = ctx.height - 70;
    const starR = 48;
    const points: number[] = [];
    const spikes = 5;
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (Math.PI / spikes) * i - Math.PI / 2;
      const rr = i % 2 === 0 ? starR : starR * 0.45;
      points.push(starCx + Math.cos(ang) * rr, starCy + Math.sin(ang) * rr);
    }
    g.poly(points).fill({ color: 0xffdd44 }).stroke({ width: 2, color: 0x884400 });

    // ── Alpha overlay: a semi-transparent panel ──
    g.roundRect(16, ctx.height - 90, 200, 70, 8).fill({ color: 0x000000, alpha: 0.5 });
    g.roundRect(16, ctx.height - 90, 200, 70, 8).stroke({ width: 1, color: 0xffffff, alpha: 0.3 });
  },
  background: DEFAULT_BACKGROUND,
};
