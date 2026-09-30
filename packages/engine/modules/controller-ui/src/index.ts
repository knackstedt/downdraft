// ============================================================================
// controller-ui — engine-provided controller settings screen.
//
//   renderer.useRendererModule(createHtmlUi({ build(ui) { ... } }));
//   renderer.useRendererModule(createControllerUi());
//   // game code: ui.open() from a menu action, or bind to START+SELECT, etc.
//
// A full "Controllers" settings panel built on html-ui + html-ui-kit:
// device list (name, pad type, battery), a live button/axis test diagram,
// and per-device rumble test. Because it mounts through HtmlUiContext.mount,
// controller nav + OSK + focus zones come free — this module is also the
// dogfood proof for the nav stack.
// ============================================================================

import { createLogger, resourceToken, type RendererModule } from "@downdraft/engine";
import { GamepadHubTok, type GamepadDevice } from "@downdraft/engine/libraries/gamepad";
import { esc, kitStyleTag, tvCss } from "@downdraft/engine/libraries/html-ui-kit";
import { HtmlUiTok, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { GP_AXIS, GP_BTN } from "@downdraft/engine/sab/gamepad-devices";

const log = createLogger("info");

export interface ControllerUi {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  readonly panel: UiPanelHandle | null;
}
export const ControllerUiTok = resourceToken<ControllerUi>("controller-ui");

const BTN_LABELS: Array<[bit: number, label: string]> = [
  [GP_BTN.SOUTH, "A"], [GP_BTN.EAST, "B"], [GP_BTN.WEST, "X"], [GP_BTN.NORTH, "Y"],
  [GP_BTN.LEFT_SHOULDER, "LB"], [GP_BTN.RIGHT_SHOULDER, "RB"],
  [GP_BTN.LEFT_TRIGGER_BTN, "LT"], [GP_BTN.RIGHT_TRIGGER_BTN, "RT"],
  [GP_BTN.SELECT, "SEL"], [GP_BTN.START, "STR"], [GP_BTN.HOME, "HOME"],
  [GP_BTN.LEFT_STICK, "L3"], [GP_BTN.RIGHT_STICK, "R3"],
  [GP_BTN.DPAD_UP, "▲"], [GP_BTN.DPAD_DOWN, "▼"], [GP_BTN.DPAD_LEFT, "◀"], [GP_BTN.DPAD_RIGHT, "▶"],
];
const AXIS_LABELS = ["LX", "LY", "RX", "RY", "LT", "RT", "DX", "DY"];

function screenMarkup(): string {
  const btns = BTN_LABELS.map(([bit, lbl]) =>
    `<div class="dd-btn ctl-btn" id="ctl-btn-${bit}" data-nav data-i="${bit}">${lbl}</div>`).join("");
  const axes = AXIS_LABELS.map((lbl, i) =>
    `<div class="ctl-axis"><div class="dd-label">${lbl}</div>` +
    `<div class="dd-progress" style="flex:1"><div class="dd-pfill" id="ctl-ax-${i}" data-part="fill" style="width:0%"></div></div>` +
    `<div class="dd-label" id="ctl-av-${i}" style="width:44px;text-align:right">0.00</div></div>`).join("");
  return `
<div style="height:100%;display:flex;flex-direction:column;background:var(--dd-bg)">
  <div class="dd-row" style="padding:18px 22px 10px">
    <div style="font-size:22px;flex:1">Controllers</div>
    <div class="dd-btn" data-nav data-action="ctlui:close">Close</div>
  </div>
  <div id="ctl-devs" class="dd-col" style="padding:0 22px 12px;gap:6px"></div>
  <div class="dd-panel" style="margin:0 22px 12px;flex:0 0 auto">
    <div class="dd-section">BUTTON TEST</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${btns}</div>
  </div>
  <div class="dd-panel" style="margin:0 22px 12px;flex:1;display:flex;flex-direction:column;gap:8px">
    <div class="dd-row"><div class="dd-section" style="flex:1">AXES</div>
      <div class="dd-btn" data-nav data-action="ctlui:rumble">Rumble test</div></div>
    ${axes}
  </div>
</div>`;
}

const CSS = `
.ctl-dev-row { display:flex; align-items:center; gap:12px; padding:10px 12px;
  border:1px solid var(--dd-line); border-radius:6px; background:var(--dd-panel); }
.ctl-dev-row[data-nav-focus="1"] { border-color:var(--dd-accent); background:var(--dd-panel2); }
.ctl-dev-name { flex:1; font-size:15px; }
.ctl-axis { display:flex; align-items:center; gap:10px; }
.ctl-btn[data-on="true"] { background:var(--dd-accent-bg); color:var(--dd-accent); border-color:var(--dd-accent); }
`;

export function createControllerUi(): RendererModule {
  return {
    name: "controller-ui",
    version: "1.0.0",
    requires: [HtmlUiTok],
    provides: [ControllerUiTok],
    register(ctx) {
      const ui = ctx.inject(HtmlUiTok);
      const hub = ctx.injectOptional(GamepadHubTok);
      let panel: UiPanelHandle | null = null;
      const api: ControllerUi = {
        get panel() { return panel; },
        get isOpen() { return panel !== null; },
        open() {
          if (panel) return;
          const w = ctx.getSurface().clientWidth, h = ctx.getSurface().clientHeight;
          const pw = Math.min(720, w - 80), ph = Math.min(760, h - 80);
          panel = ui.mount(`${kitStyleTag()}<style>${tvCss()}${CSS}</style>${screenMarkup()}`, {
            id: "controller-ui",
            rect: { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph },
            z: 50,
          });
          refreshDevices();
          ui.onAction("ctlui:close", () => api.close());
          ui.onAction("ctlui:rumble", () => {
            const dev = selected();
            if (dev) dev.rumble(32768, 65535, 300);
          });
        },
        close() {
          panel?.dispose();
          panel = null;
        },
      };

      let sel = 0;
      function selected(): GamepadDevice | null {
        const devs = hub?.list() ?? [];
        return devs[Math.min(sel, Math.max(0, devs.length - 1))] ?? null;
      }
      function refreshDevices() {
        if (!panel) return;
        const devs = hub?.list() ?? [];
        const rows = devs.length
          ? devs.map((d, i) => {
              const bat = d.batteryPercent;
              const meta = [
                d.info.padType ?? "gamepad",
                bat !== null ? `${bat}%${d.charging ? " ⚡" : ""}` : "wired",
              ].join(" · ");
              return `<div class="ctl-dev-row" data-nav data-action="ctlui:sel" data-i="${i}">` +
                `<div class="ctl-dev-name">${esc(d.info.name)}</div>` +
                `<div class="dd-label">${esc(meta)}</div></div>`;
            }).join("")
          : `<div class="dd-label" style="padding:8px 4px">No controllers connected</div>`;
        panel.mutate([{ op: "innerHtml", sel: "#ctl-devs", html: rows }]);
        ui.nav?.invalidate(panel);
      }
      ui.onAction?.("ctlui:sel", (d) => { sel = Number(d.i ?? 0); });

      ui.onUpdate(() => {
        const p = panel;
        const dev = selected();
        if (!p || !dev) return;
        const ops = [];
        for (const [bit] of BTN_LABELS) {
          ops.push({ op: "attr", sel: `#ctl-btn-${bit}`, name: "data-on",
            value: dev.pressed(bit) ? "true" : "false" } as const);
        }
        const ax = dev.axes();
        for (let i = 0; i < AXIS_LABELS.length; i++) {
          const v = ax[i] ?? 0;
          const isTrigger = i === GP_AXIS.LEFT_TRIGGER || i === GP_AXIS.RIGHT_TRIGGER;
          const pct = Math.round((isTrigger ? v : (v + 1) / 2) * 100);
          ops.push({ op: "style", sel: `#ctl-ax-${i}`, prop: "width", value: `${pct}%` } as const);
          ops.push({ op: "text", sel: `#ctl-av-${i}`, text: v.toFixed(2) } as const);
        }
        p.mutate(ops);
      });

      hub?.on("connect", refreshDevices);
      hub?.on("disconnect", refreshDevices);

      ctx.provide(ControllerUiTok, api);
      ctx.onDispose(() => api.close());
      log.info("controller-ui", hub ? "ready" : "ready (no gamepad source — screen will show 'No controllers')");
    },
  };
}
