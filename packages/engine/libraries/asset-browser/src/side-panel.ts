// ============================================================================
// side-panel.ts — cursor-based control builders for the browser's right-hand
// panel. Extracted from andrews-sandbox's spawn-settings panel: the scene
// manages the panel chrome + y cursor; games compose controls via these
// helpers inside their `sidePanel` config callback.
// ============================================================================

import { Container, Graphics, Text } from "pixi.js";
import type { SidePanelUi } from "./types";

const C_PANEL = 0x141428;
const C_PANEL_BORDER = 0x4e9af1;
const C_ACCENT = 0x4e9af1;
const C_TEXT = 0xe0e0e0;
const C_TEXT_DIM = 0x888888;
const FONT = "Segoe UI, Arial, sans-serif";

// 2× glyph rasterization — matches the scene's text (see mkText there).
const mkText = (opts: any): Text => { opts.resolution ??= 2; return new Text(opts); };

export function createSidePanelUi(panel: Container, x: number, startY: number, width: number): SidePanelUi {
  let y = startY;

  return {
    text(text, opts) {
      const t = mkText({
        text,
        style: {
          fill: opts?.accent ? C_ACCENT : opts?.dim ? C_TEXT_DIM : C_TEXT,
          fontSize: opts?.size ?? 12,
          fontFamily: FONT,
          fontWeight: opts?.bold ? "bold" : "normal",
        },
      });
      t.x = x; t.y = y;
      panel.addChild(t);
      y += (opts?.size ?? 12) + 8;
    },

    button(label, onClick, opts) {
      const btn = mkText({
        text: opts?.accent === false ? label : `[ ${label} ]`,
        style: {
          fill: opts?.danger ? 0xff6666 : opts?.accent === false ? C_TEXT : C_ACCENT,
          fontSize: opts?.size ?? 15,
          fontFamily: FONT,
          fontWeight: "bold",
        },
      });
      btn.x = x; btn.y = y;
      btn.eventMode = "static"; btn.cursor = "pointer";
      btn.onclick = () => onClick();
      panel.addChild(btn);
      y += (opts?.size ?? 15) + 13;
    },

    slider(label, value, min, max, step, onChange) {
      const lbl = mkText({
        text: `${label}: ${value.toFixed(value < 10 ? 2 : 0)}`,
        style: { fill: C_TEXT, fontSize: 12, fontFamily: FONT },
      });
      lbl.x = x; lbl.y = y;
      panel.addChild(lbl);
      y += 16;

      const trackW = width - 20;
      const track = new Graphics();
      track.rect(x, y, trackW, 6);
      track.fill({ color: 0x333355 });
      track.stroke({ color: 0x555577, width: 1 });
      panel.addChild(track);

      const knobX = x + ((value - min) / (max - min)) * trackW;
      const knob = new Graphics();
      knob.circle(knobX, y + 3, 7);
      knob.fill({ color: C_ACCENT });
      knob.eventMode = "static";
      knob.cursor = "pointer";
      let dragging = false;
      const updateKnob = (globalX: number) => {
        const t = Math.max(0, Math.min(1, (globalX - x) / trackW));
        let newVal = min + t * (max - min);
        newVal = Math.round(newVal / step) * step;
        newVal = Math.max(min, Math.min(max, newVal));
        lbl.text = `${label}: ${newVal.toFixed(newVal < 10 ? 2 : 0)}`;
        knob.x = ((newVal - min) / (max - min)) * trackW;
        onChange(newVal);
      };
      knob.on("pointerdown", (e) => { dragging = true; updateKnob(e.global.x); });
      knob.on("pointermove", (e) => { if (dragging) updateKnob(e.global.x); });
      knob.on("pointerup", () => { dragging = false; });
      knob.on("pointerupoutside", () => { dragging = false; });
      panel.addChild(knob);
      y += 22;
    },

    toggle(label, value, onChange) {
      const lbl = mkText({ text: `${label}:`, style: { fill: C_TEXT_DIM, fontSize: 12, fontFamily: FONT } });
      lbl.x = x; lbl.y = y;
      panel.addChild(lbl);
      const btn = mkText({
        text: value ? "[On]" : "Off",
        style: { fill: value ? C_ACCENT : C_TEXT, fontSize: 13, fontFamily: FONT },
      });
      btn.x = x; btn.y = y + 18;
      btn.eventMode = "static"; btn.cursor = "pointer";
      btn.onclick = () => onChange(!value);
      panel.addChild(btn);
      y += 42;
    },

    dropdown(label, current, options, onChange) {
      const lbl = mkText({
        text: `${label}: ${current} ▾`,
        style: { fill: C_TEXT, fontSize: 12, fontFamily: FONT },
      });
      lbl.x = x; lbl.y = y;
      lbl.eventMode = "static"; lbl.cursor = "pointer";
      let open = false;
      let dropdownContainer: Container | null = null;
      const closeDropdown = () => {
        if (dropdownContainer) { dropdownContainer.destroy({ children: true }); dropdownContainer = null; }
        open = false;
      };
      lbl.onclick = () => {
        if (open) { closeDropdown(); return; }
        open = true;
        dropdownContainer = new Container();
        // Opaque backing so the options don't visually collide with the rows
        // rendered beneath the dropdown.
        const optBg = new Graphics();
        optBg.roundRect(x - 4, y + 16, width + 8, options.length * 16 + 6, 4)
          .fill({ color: C_PANEL, alpha: 0.98 })
          .stroke({ color: C_PANEL_BORDER, width: 1 });
        dropdownContainer.addChild(optBg);
        let dy = y + 18;
        for (const opt of options) {
          const isSel = opt === current;
          const optText = mkText({
            text: isSel ? `▸ ${opt}` : `  ${opt}`,
            style: { fill: isSel ? C_ACCENT : C_TEXT, fontSize: 12, fontFamily: FONT },
          });
          optText.x = x; optText.y = dy;
          optText.eventMode = "static"; optText.cursor = "pointer";
          optText.onclick = () => {
            onChange(opt);
            closeDropdown();
          };
          dropdownContainer!.addChild(optText);
          dy += 16;
        }
        panel.addChild(dropdownContainer);
      };
      panel.addChild(lbl);
      y += 22;
    },

    spacer(px) { y += px; },
  };
}
