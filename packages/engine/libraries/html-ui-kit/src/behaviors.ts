// ============================================================================
// behaviors.ts — bindKit(): standard interaction wiring for kit widgets.
//
// One handle.onEvent subscription routes every DOM event through the verb
// table below. State changes are single setAttr mutations (CSS keys off the
// data-* attrs); delegate callbacks let the app observe or veto behavior.
//
//   kit:toggle  checkbox/switch flip          → onChange(id, "toggle", on)
//   kit:radio   radio option select           → onChange(group, "radio", i)
//   kit:select  segmented/tab/list/table row  → onChange(id, "select", i)
//   kit:drag    slider press+drag (self-measured via getRect)
//                                             → onChange(id, "slider", v)
//   kit:inc/dec number steppers               → onChange(id, "number", v)
//   kit:open    dropdown/modal/ctx open       → onChange(id, "open", true)
//   kit:close   backdrop/dismiss open=false   → onChange(id, "open", false)
//   kit:choice  dropdown item pick            → onChange(id, "choice", value)
//   kit:ctxitem context menu pick             → onAction("ctx", { value, id })
//   kit:dismiss toast close                   → onAction("dismiss", { id })
//   kit:node    tree expander toggle          → onAction("node", { i, open })
//   kit:pick    tree row select               → onChange(id, "pick", path)
//   kit:acc     accordion header toggle       → onAction("acc", { i, open })
//   kit:press   buttons (data-verb renames)   → onAction(verb, d, ev)
//
// Non-action events pass through: input → onChange(id,"input",v),
// scroll → onChange(id,"scroll",{top,left}), focus/blur/key/click/etc → onEvent.
// ============================================================================

import type { UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { OsrDomEvent, DocMutation } from "@downdraft/engine/modules/html-ui";

export interface KitDelegate {
  /** State-changing widgets: toggles, selects, sliders, inputs, scrolls. */
  onChange?(id: string, kind: string, value: unknown, ev: OsrDomEvent): void;
  /** Command verbs: button presses, menu picks, dismissals. */
  onAction?(verb: string, data: Record<string, string>, ev: OsrDomEvent): void;
  /** Everything else (focus/blur/keys/clicks off kit elements). */
  onEvent?(ev: OsrDomEvent): void;
}

export interface KitBinding {
  dispose(): void;
  setToggle(id: string, on: boolean): void;
  /** Select index `i` inside a segmented/tabs/list widget (count = option n). */
  setSelect(id: string, i: number, count: number): void;
  setSliderValue(id: string, v: number): void;
  setProgress(id: string, pct: number): void;
  setOpen(id: string, open: boolean): void;
  setInvalid(id: string, invalid: boolean): void;
  setInputValue(id: string, v: string): void;
  /** Show a context menu widget at doc coords; hides via kit:close. */
  showContextMenu(id: string, x: number, y: number): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function bindKit(handle: UiPanelHandle, delegate: KitDelegate = {}): KitBinding {
  // One active slider drag at a time; rect measured on press (ev coords are
  // doc-space CSS px, matching getRect).
  let drag: { id: string; min: number; max: number; x0: number; w: number } | null = null;
  // Tree row selection is a single (tree → path) map — no queryAll needed.
  const treeSel = new Map<string, string>();

  const setOn = (sel: string, on: boolean): DocMutation =>
    ({ op: "attr", sel, name: "data-on", value: on ? "true" : "false" });

  function sliderApply(d: { id: string; min: number; max: number; x0: number; w: number }, x: number) {
    const pct = d.w > 0 ? clamp((x - d.x0) / d.w, 0, 1) : 0;
    const v = Math.round(d.min + pct * (d.max - d.min));
    handle.mutate([
      { op: "attr", sel: `#${d.id}`, name: "data-value", value: String(v) },
      { op: "style", sel: `#${d.id} [data-part="fill"]`, prop: "width", value: `${pct * 100}%` },
      { op: "style", sel: `#${d.id} [data-part="thumb"]`, prop: "left", value: `${pct * 100}%` },
      { op: "text", sel: `#${d.id} [data-part="value"]`, text: String(v) },
    ]);
    delegate.onChange?.(d.id, "slider", v, { t: "input" } as OsrDomEvent);
  }

  function route(ev: OsrDomEvent): void {
    const d = ev.d ?? {};
    const verb = d.action ?? "";
    const id = d.id ?? ev.id ?? "";

    // ── slider drag lifecycle ──
    if (drag && ev.t === "pointermove") { sliderApply(drag, ev.x ?? 0); return; }
    if (ev.t === "mouseup" && drag) { drag = null; return; }
    if (ev.t === "mousedown" && verb === "kit:drag") {
      const min = Number(d.min ?? 0), max = Number(d.max ?? 100);
      handle.getRect(`#${id} [data-part="track"]`).then((r) => {
        if (!r || !r.w) return;
        drag = { id, min, max, x0: r.x, w: r.w };
        sliderApply(drag, ev.x ?? r.x); // press-to-jump
      });
      return;
    }

    if (ev.t === "click") {
      switch (verb) {
        case "kit:toggle": {
          const next = d.on !== "true";
          handle.setAttr(`#${id}`, "data-on", next ? "true" : "false");
          delegate.onChange?.(id, "toggle", next, ev);
          return;
        }
        case "kit:radio": {
          const i = Number(d.i ?? 0), n = Number(d.count ?? 0), g = d.group ?? id;
          const ops: DocMutation[] = [setOn(`#${g} [data-part="opt"][data-i="${i}"]`, true)];
          for (let k = 0; k < n; k++) {
            if (k !== i) ops.push(setOn(`#${g} [data-part="opt"][data-i="${k}"]`, false));
          }
          handle.mutate(ops);
          delegate.onChange?.(g, "radio", i, ev);
          return;
        }
        case "kit:select": {
          const i = Number(d.i ?? 0), n = Number(d.count ?? 0);
          const ops: DocMutation[] = [setOn(`#${id} [data-i="${i}"]`, true)];
          for (let k = 0; k < n; k++) {
            if (k !== i) ops.push(setOn(`#${id} [data-i="${k}"]`, false));
          }
          handle.mutate(ops);
          delegate.onChange?.(id, "select", i, ev);
          return;
        }
        case "kit:inc": case "kit:dec": {
          const step = Number(d.step ?? 1) * (verb === "kit:inc" ? 1 : -1);
          handle.getAttr(`#${id}`, "value").then((raw) => {
            const lo = d.min === "" || d.min === undefined ? -Infinity : Number(d.min);
            const hi = d.max === "" || d.max === undefined ? Infinity : Number(d.max);
            const v = clamp((Number(raw ?? 0) || 0) + step, lo, hi);
            handle.setAttr(`#${id}`, "value", String(v));
            delegate.onChange?.(id, "number", v, ev);
          });
          return;
        }
        case "kit:open":
          handle.setAttr(`#${id}`, "data-open", d.open === "true" ? "false" : "true");
          delegate.onChange?.(id, "open", d.open !== "true", ev);
          return;
        case "kit:close":
          handle.setAttr(`#${id}`, "data-open", "false");
          delegate.onChange?.(id, "open", false, ev);
          return;
        case "kit:choice": {
          const v = d.value ?? "";
          handle.mutate([
            { op: "attr", sel: `#${id}`, name: "data-value", value: v },
            { op: "attr", sel: `#${id}`, name: "data-open", value: "false" },
            { op: "text", sel: `#${id} [data-part="label"]`, text: v },
          ]);
          delegate.onChange?.(id, "choice", v, ev);
          return;
        }
        case "kit:ctxitem":
          handle.setAttr(`#${id}`, "data-open", "false");
          delegate.onAction?.("ctx", { id, value: d.value ?? "" }, ev);
          return;
        case "kit:dismiss":
          handle.setStyle(`#${id}`, "display", "none");
          delegate.onAction?.("dismiss", { id }, ev);
          return;
        case "kit:node": {
          const p = d.i ?? "";
          const open = d.open === "true" ? "false" : "true";
          handle.mutate([
            { op: "attr", sel: `#${id} .dd-trow[data-i="${p}"]`, name: "data-open", value: open },
            { op: "text", sel: `#${id} .dd-trow[data-i="${p}"] .dd-caret`, text: open === "true" ? "▼" : "▶" },
          ]);
          delegate.onAction?.("node", { id, i: p, open }, ev);
          return;
        }
        case "kit:pick": {
          const p = d.i ?? "";
          const prev = treeSel.get(id);
          const ops: DocMutation[] = [setOn(`#${id} .dd-trow[data-i="${p}"]`, true)];
          if (prev !== undefined && prev !== p) ops.push(setOn(`#${id} .dd-trow[data-i="${prev}"]`, false));
          treeSel.set(id, p);
          handle.mutate(ops);
          delegate.onChange?.(id, "pick", p, ev);
          return;
        }
        case "kit:acc": {
          const i = d.i ?? "";
          const open = d.open === "true" ? "false" : "true";
          handle.mutate([
            { op: "attr", sel: `#${id} .dd-as[data-i="${i}"]`, name: "data-open", value: open },
            { op: "text", sel: `#${id} .dd-as[data-i="${i}"] .dd-caret`, text: open === "true" ? "▾" : "▸" },
          ]);
          delegate.onAction?.("acc", { id, i, open }, ev);
          return;
        }
        case "kit:press":
          delegate.onAction?.(d.verb ?? "press", d, ev);
          return;
        default:
          break;
      }
    }

    // ── value/event passthroughs ──
    if (ev.t === "input") { delegate.onChange?.(id, "input", ev.v ?? "", ev); return; }
    if (ev.t === "scroll") {
      delegate.onChange?.(id, "scroll", { top: ev.st ?? 0, left: ev.sl ?? 0 }, ev);
      return;
    }
    if (ev.t === "contextmenu") { delegate.onAction?.("contextmenu", d, ev); return; }
    delegate.onEvent?.(ev);
  }

  const off = handle.onEvent(route);

  return {
    dispose: off,
    setToggle: (id, onV) => { handle.setAttr(`#${id}`, "data-on", onV ? "true" : "false"); },
    setSelect(id, i, count) {
      const ops: DocMutation[] = [setOn(`#${id} [data-i="${i}"]`, true)];
      for (let k = 0; k < count; k++) {
        if (k !== i) ops.push(setOn(`#${id} [data-i="${k}"]`, false));
      }
      handle.mutate(ops);
    },
    setSliderValue(id, v) {
      handle.getAttr(`#${id}`, "data-min").then((raw) => {
        const min = Number(raw ?? 0);
        handle.getAttr(`#${id}`, "data-max").then((rawMax) => {
          const max = Number(rawMax ?? 100);
          const pct = max > min ? clamp((v - min) / (max - min), 0, 1) : 0;
          handle.mutate([
            { op: "attr", sel: `#${id}`, name: "data-value", value: String(v) },
            { op: "style", sel: `#${id} [data-part="fill"]`, prop: "width", value: `${pct * 100}%` },
            { op: "style", sel: `#${id} [data-part="thumb"]`, prop: "left", value: `${pct * 100}%` },
            { op: "text", sel: `#${id} [data-part="value"]`, text: String(v) },
          ]);
        });
      });
    },
    setProgress: (id, pct) => {
      handle.setStyle(`#${id} [data-part="fill"]`, "width", `${clamp(pct, 0, 100)}%`);
    },
    setOpen: (id, open) => { handle.setAttr(`#${id}`, "data-open", open ? "true" : "false"); },
    setInvalid: (id, invalid) => { handle.setAttr(`#${id}`, "data-invalid", invalid ? "true" : "false"); },
    setInputValue: (id, v) => { handle.setAttr(`#${id}`, "value", v); },
    showContextMenu(id, x, y) {
      handle.mutate([
        { op: "attr", sel: `#${id}`, name: "data-open", value: "true" },
        { op: "style", sel: `#${id}`, prop: "left", value: `${x}px` },
        { op: "style", sel: `#${id}`, prop: "top", value: `${y}px` },
      ]);
    },
  };
}
