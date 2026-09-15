// ============================================================================
// sliders.ts — Slider component scene.
//
// Renders horizontal sliders: a track, a filled portion, a draggable handle,
// and tick marks. Includes sliders at different fill ratios, a disabled
// slider, and a vertical slider. Exercises Graphics (rounded rects, circles,
// lines) + Text labels + Container transforms.
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import { DEFAULT_BACKGROUND, FONT_FAMILY, type PixiScene, type SceneContext } from "./types";

const TRACK_W = 240;
const TRACK_H = 6;
const HANDLE_R = 10;

function drawSlider(
  parent: Container,
  x: number,
  y: number,
  ratio: number,
  label: string,
  disabled = false,
): void {
  const c = new Container();
  c.x = x;
  c.y = y;

  const labelT = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: disabled ? 0x666677 : 0xcccccc },
  });
  labelT.x = 0;
  labelT.y = -22;
  c.addChild(labelT);

  const trackColor = disabled ? 0x333344 : 0x3a3a4a;
  const fillColor = disabled ? 0x555566 : 0x3a8aff;
  const handleColor = disabled ? 0x666677 : 0xffffff;
  const handleBorder = disabled ? 0x444455 : 0x3a8aff;

  // Track
  const track = new Graphics();
  track.roundRect(0, 0, TRACK_W, TRACK_H, 3).fill({ color: trackColor });
  c.addChild(track);

  // Fill
  const fillW = Math.max(0, Math.min(1, ratio)) * TRACK_W;
  if (fillW > 0) {
    const fill = new Graphics();
    fill.roundRect(0, 0, fillW, TRACK_H, 3).fill({ color: fillColor });
    c.addChild(fill);
  }

  // Handle
  const handle = new Graphics();
  const hx = fillW;
  const hy = TRACK_H / 2;
  handle.circle(hx, hy, HANDLE_R).fill({ color: handleColor }).stroke({ width: 2, color: handleBorder });
  c.addChild(handle);

  // Value label to the right
  const valT = new Text({
    text: `${Math.round(ratio * 100)}%`,
    style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: disabled ? 0x666677 : 0x88aaff },
  });
  valT.x = TRACK_W + 12;
  valT.y = -4;
  c.addChild(valT);

  parent.addChild(c);
}

export const slidersScene: PixiScene = {
  id: "sliders",
  name: "Sliders",
  category: "components",
  description: "Horizontal sliders (track, fill, handle, ticks), disabled, and vertical.",
  build(root: Container, ctx: SceneContext) {
    root.removeChildren();

    const title = new Text({
      text: "Sliders",
      style: { fontFamily: FONT_FAMILY, fontSize: 24, fill: 0x88aaff },
    });
    title.x = 16;
    title.y = 12;
    root.addChild(title);

    // ── Horizontal sliders at various ratios ──
    const ratios = [0, 0.25, 0.5, 0.75, 1];
    let y = 56;
    for (let i = 0; i < ratios.length; i++) {
      drawSlider(root, 24, y, ratios[i], `Volume ${i + 1}`);
      y += 44;
    }

    // ── Disabled slider ──
    drawSlider(root, 24, y, 0.4, "Disabled", true);
    y += 56;

    // ── Slider with tick marks ──
    const tickC = new Container();
    tickC.x = 24;
    tickC.y = y;
    const tickLabel = new Text({
      text: "Equalizer",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0xcccccc },
    });
    tickLabel.y = -22;
    tickC.addChild(tickLabel);

    const tickTrack = new Graphics();
    tickTrack.roundRect(0, 0, TRACK_W, TRACK_H, 3).fill({ color: 0x3a3a4a });
    tickC.addChild(tickTrack);
    const tickFill = new Graphics();
    tickFill.roundRect(0, 0, TRACK_W * 0.6, TRACK_H, 3).fill({ color: 0x3a8aff });
    tickC.addChild(tickFill);
    const ticks = new Graphics();
    const tickCount = 9;
    for (let i = 0; i < tickCount; i++) {
      const tx = (i / (tickCount - 1)) * TRACK_W;
      ticks.moveTo(tx, TRACK_H + 4).lineTo(tx, TRACK_H + 12).stroke({ width: 1, color: 0x6a6a8a });
    }
    tickC.addChild(ticks);
    const tickHandle = new Graphics();
    tickHandle.circle(TRACK_W * 0.6, TRACK_H / 2, HANDLE_R).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x3a8aff });
    tickC.addChild(tickHandle);
    root.addChild(tickC);

    // ── Vertical slider (bottom-right) ──
    const vC = new Container();
    vC.x = ctx.width - 60;
    vC.y = 60;
    const vH = 200;
    const vTrack = new Graphics();
    vTrack.roundRect(0, 0, TRACK_H, vH, 3).fill({ color: 0x3a3a4a });
    vC.addChild(vTrack);
    const vFill = new Graphics();
    vFill.roundRect(0, vH * 0.3, TRACK_H, vH * 0.7, 3).fill({ color: 0x3a8aff });
    vC.addChild(vFill);
    const vHandle = new Graphics();
    vHandle.circle(TRACK_H / 2, vH * 0.3, HANDLE_R).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x3a8aff });
    vC.addChild(vHandle);
    const vLabel = new Text({
      text: "Gain",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0xcccccc },
    });
    vLabel.anchor.x = 0.5;
    vLabel.x = TRACK_H / 2;
    vLabel.y = vH + 8;
    vC.addChild(vLabel);
    root.addChild(vC);
  },
  background: DEFAULT_BACKGROUND,
};
