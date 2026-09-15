// ============================================================================
// dropdowns.ts — Dropdown component scene.
//
// Renders a dropdown in its closed state (trigger button + chevron) and its
// open state (trigger + expanded list with a highlighted/hovered option and
// a selected check). Exercises Graphics (rounded rects, strokes, chevron
// via lines), Text labels, and Container transforms.
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import { DEFAULT_BACKGROUND, FONT_FAMILY, type PixiScene, type SceneContext } from "./types";

const DD_W = 200;
const DD_H = 36;
const ITEM_H = 30;

function drawChevron(g: Graphics, cx: number, cy: number, size: number, color: number): void {
  g.moveTo(cx - size, cy - size).lineTo(cx, cy + size).lineTo(cx + size, cy - size).stroke({ width: 2, color });
}

function drawDropdown(
  parent: Container,
  x: number,
  y: number,
  open: boolean,
  selected: string,
  options: string[],
  hoveredIndex: number,
): void {
  const c = new Container();
  c.x = x;
  c.y = y;

  // Trigger
  const trigger = new Graphics();
  trigger.roundRect(0, 0, DD_W, DD_H, 6).fill({ color: 0x2a2a44 }).stroke({ width: 2, color: 0x6a6a9a });
  c.addChild(trigger);
  const trigText = new Text({
    text: selected,
    style: { fontFamily: FONT_FAMILY, fontSize: 16, fill: 0xffffff },
  });
  trigText.x = 12;
  trigText.y = (DD_H - 16) / 2;
  c.addChild(trigText);
  const chev = new Graphics();
  drawChevron(chev, DD_W - 18, DD_H / 2, 5, open ? 0x88aaff : 0xaaaaaa);
  c.addChild(chev);

  if (open) {
    // Panel behind the list
    const list = new Graphics();
    const listH = options.length * ITEM_H + 8;
    list.roundRect(0, DD_H + 4, DD_W, listH, 6).fill({ color: 0x1e1e30 }).stroke({ width: 1, color: 0x4a4a6a });
    c.addChild(list);

    for (let i = 0; i < options.length; i++) {
      const iy = DD_H + 4 + 4 + i * ITEM_H;
      const isHover = i === hoveredIndex;
      const isSelected = options[i] === selected;
      if (isHover) {
        const hl = new Graphics();
        hl.roundRect(4, iy, DD_W - 8, ITEM_H - 2, 4).fill({ color: 0x3a6aff, alpha: 0.5 });
        c.addChild(hl);
      }
      const t = new Text({
        text: options[i],
        style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: isHover ? 0xffffff : 0xcccccc },
      });
      t.x = 14;
      t.y = iy + 4;
      c.addChild(t);
      if (isSelected) {
        const check = new Graphics();
        const ckx = DD_W - 18;
        const cky = iy + ITEM_H / 2 - 2;
        check.moveTo(ckx - 6, cky).lineTo(ckx - 2, cky + 4).lineTo(ckx + 6, cky - 4).stroke({ width: 2, color: 0x44ff88 });
        c.addChild(check);
      }
    }
  }

  parent.addChild(c);
}

export const dropdownsScene: PixiScene = {
  id: "dropdowns",
  name: "Dropdowns",
  category: "components",
  description: "Dropdown closed and open states with hover/selected options.",
  build(root: Container, _ctx: SceneContext) {
    root.removeChildren();

    const title = new Text({
      text: "Dropdowns",
      style: { fontFamily: FONT_FAMILY, fontSize: 24, fill: 0x88aaff },
    });
    title.x = 16;
    title.y = 12;
    root.addChild(title);

    const options = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];

    // Closed
    const closedLabel = new Text({
      text: "Closed",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
    });
    closedLabel.x = 16;
    closedLabel.y = 56;
    root.addChild(closedLabel);
    drawDropdown(root, 16, 76, false, "Cherry", options, -1);

    // Open
    const openLabel = new Text({
      text: "Open",
      style: { fontFamily: FONT_FAMILY, fontSize: 14, fill: 0x88aaff },
    });
    openLabel.x = 280;
    openLabel.y = 56;
    root.addChild(openLabel);
    drawDropdown(root, 280, 76, true, "Cherry", options, 1);
  },
  background: DEFAULT_BACKGROUND,
};
