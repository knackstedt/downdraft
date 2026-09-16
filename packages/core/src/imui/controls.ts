// ============================================================================
// controls — composite imui controls built from the base widgets.
//
// These are the recurring "widget kit" pieces games previously hand-rolled in
// pixi scenes (labeled slider rows, segmented selectors, checkboxes, styled
// buttons, dim/bold text). Game code composes them inside `createGameUi`'s
// `build(ui)` hook.
// ============================================================================

import { UIButton, UIElement, UIPanel, UIText, type UIColor } from "./element";
import { UISlider, UIToggle } from "./widgets";

// ── Shared palette ──

export const UI_COLORS = {
  bg: [0, 0, 0, 0.8] as UIColor,
  panel: [0.1, 0.1, 0.12, 0.95] as UIColor,
  text: [1, 1, 1, 1] as UIColor,
  textDim: [0.6, 0.6, 0.6, 1] as UIColor,
  accent: [0.31, 0.76, 0.97, 1] as UIColor,
  danger: [0.96, 0.26, 0.21, 1] as UIColor,
  border: [0.2, 0.2, 0.2, 0.6] as UIColor,
  btnIdle: [0.13, 0.13, 0.13, 0.9] as UIColor,
  btnActive: [0.2, 0.2, 0.2, 1] as UIColor,
  btnAccentIdle: [0.16, 0.35, 0.48, 0.3] as UIColor,
  btnAccentActive: [0.31, 0.76, 0.97, 0.5] as UIColor,
  btnDangerIdle: [0.53, 0.13, 0.13, 0.2] as UIColor,
};

// ── Text ──

export interface UITextOpts {
  dim?: boolean;
  size?: number;
  bold?: boolean;
  color?: UIColor;
  family?: string;
}

export function uiText(text: string, x = 0, y = 0, opts: UITextOpts = {}): UIText {
  const t = new UIText(text);
  t.x = x;
  t.y = y;
  t.pointerThrough = true;
  t.style.fontSize = opts.size ?? 14;
  t.style.fontFamily = opts.family ?? "monospace";
  t.style.fontWeight = opts.bold ? "bold" : "normal";
  t.style.textColor = [...(opts.color ?? (opts.dim ? UI_COLORS.textDim : UI_COLORS.text))] as UIColor;
  return t;
}

// ── Button ──

export interface UIButtonOpts {
  accent?: boolean;
  danger?: boolean;
  fontSize?: number;
}

export function uiButton(label: string, w: number, h: number, onClick: () => void, opts: UIButtonOpts = {}): UIButton {
  const btn = new UIButton(label, w, h);
  btn.style.fontSize = opts.fontSize ?? 14;
  btn.style.fontFamily = "monospace";
  btn.style.textColor = [...UI_COLORS.text] as UIColor;
  btn.style.borderRadius = 4;
  btn.style.borderWidth = 1;
  if (opts.accent) {
    btn.style.borderColor = [...UI_COLORS.accent] as UIColor;
    btn.style.backgroundColor = [...UI_COLORS.btnAccentIdle] as UIColor;
  } else if (opts.danger) {
    btn.style.borderColor = [...UI_COLORS.danger] as UIColor;
    btn.style.backgroundColor = [...UI_COLORS.btnDangerIdle] as UIColor;
  } else {
    btn.style.borderColor = [...UI_COLORS.border] as UIColor;
    btn.style.backgroundColor = [...UI_COLORS.btnIdle] as UIColor;
  }
  btn.callbacks.onClick = () => onClick();
  return btn;
}

/** Toggle a button's "active" visual state (segmented controls, toggles). */
export function uiButtonActive(btn: UIButton, active: boolean, accent = false): void {
  btn.style.backgroundColor = active
    ? [...(accent ? UI_COLORS.btnAccentActive : UI_COLORS.btnActive)] as UIColor
    : [...(accent ? UI_COLORS.btnAccentIdle : UI_COLORS.btnIdle)] as UIColor;
}

// ── Panel ──

export function uiPanel(w: number, h: number, opts: { transparent?: boolean } = {}): UIPanel {
  const p = new UIPanel(w, h);
  p.pointerThrough = true;
  if (opts.transparent) {
    p.style.backgroundColor = [0, 0, 0, 0];
    p.style.borderWidth = 0;
  } else {
    p.style.backgroundColor = [...UI_COLORS.bg] as UIColor;
    p.style.borderColor = [...UI_COLORS.border] as UIColor;
    p.style.borderWidth = 1;
    p.style.borderRadius = 4;
  }
  return p;
}

// ── Labeled slider row ──

export interface UISliderRow {
  row: UIPanel;
  slider: UISlider;
  label: UIText;
  valueText: UIText;
}

export function uiSliderRow(
  labelText: string,
  min: number,
  max: number,
  value: number,
  trackW: number,
  onChange: (v: number) => void,
): UISliderRow {
  const row = uiPanel(trackW, 40, { transparent: true });
  const label = uiText(labelText, 0, 0, { dim: true, size: 12 });
  const valueText = uiText(fmtSliderValue(value, min, max), trackW - 30, 0, { size: 12 });
  const slider = new UISlider(trackW, 16);
  slider.x = 0;
  slider.y = 18;
  slider.minValue = min;
  slider.maxValue = max;
  slider.setValue(value);
  slider.onValueChange = (v) => {
    valueText.setText(fmtSliderValue(v, min, max));
    onChange(v);
  };
  row.addChild(label);
  row.addChild(valueText);
  row.addChild(slider);
  return { row, slider, label, valueText };
}

function fmtSliderValue(v: number, min: number, max: number): string {
  return (max - min) / 100 < 1 ? v.toFixed(2) : Math.round(v).toString();
}

// ── Segmented control ──

export interface UISegmented {
  el: UIPanel;
  buttons: UIButton[];
  setValue(v: string): void;
}

export function uiSegmented(
  labelText: string,
  options: readonly string[],
  labels: Record<string, string>,
  value: string,
  onChange: (v: string) => void,
  opts: { btnW?: number } = {},
): UISegmented {
  const btnW = opts.btnW ?? 70;
  const el = uiPanel(options.length * (btnW + 4), labelText ? 40 : 24, { transparent: true });
  if (labelText) el.addChild(uiText(labelText, 0, 0, { dim: true, size: 12 }));

  const buttons: UIButton[] = [];
  let current = value;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const btn = uiButton(labels[opt] ?? opt, btnW, 22, () => {
      current = opt;
      refresh();
      onChange(opt);
    }, { accent: true, fontSize: 12 });
    btn.x = i * (btnW + 4);
    btn.y = labelText ? 16 : 0;
    buttons.push(btn);
    el.addChild(btn);
  }
  const refresh = () => {
    for (let i = 0; i < options.length; i++) uiButtonActive(buttons[i], options[i] === current, true);
  };
  refresh();
  return {
    el,
    buttons,
    setValue(v: string) { current = v; refresh(); },
  };
}

// ── Checkbox ──

export interface UICheckbox {
  el: UIPanel;
  toggle: UIToggle;
  setChecked(v: boolean): void;
}

export function uiCheckbox(labelText: string, checked: boolean, onChange: (v: boolean) => void): UICheckbox {
  const el = uiPanel(240, 24, { transparent: true });
  el.pointerThrough = false; // whole row is clickable, not just the knob
  const toggle = new UIToggle(34, 18);
  toggle.x = 0;
  toggle.y = 0;
  toggle.checked = checked;
  const label = uiText(labelText, 42, 2, { size: 12 });
  el.addChild(toggle);
  el.addChild(label);
  toggle.onToggle = (v) => onChange(v);
  // Clicking the row (label area) behaves like clicking the knob.
  el.callbacks.onClick = (hit) => { if (hit !== toggle) toggle.toggle(); };
  return {
    el,
    toggle,
    setChecked(v: boolean) { toggle.setChecked(v); },
  };
}

/** Enable/disable an element subtree (greys out + blocks interaction). */
export function uiSetEnabled(el: UIElement, enabled: boolean): void {
  el.enabled = enabled;
  el.style.opacity = enabled ? 1 : 0.4;
}
