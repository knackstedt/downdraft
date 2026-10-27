import { AppRenderer } from "@downdraft/engine";
import { createAppMcp, downdraft, jsonResult, type AppContext, type AppModule } from "@downdraft/engine/app/main";
import type { AppMenuBackend, AppMenuModel } from "@downdraft/engine/app/shared/types";
import { bindKit, kitStyleTag, menuBar } from "@downdraft/engine/libraries/html-ui-kit";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { AppWindow } from "@downdraft/platform-native";

// Desktop Demo — the reference desktop-app fixture. Exercises the whole
// desktop surface in one window: menu model (native or in-window kit
// fallback), tray toggle, dialogs (DD_DIALOGS_MOCK-aware), notifications,
// theme readout, close veto, second-instance record, settings roundtrip,
// and a damage-driven render loop with pump counters the e2e spec uses to
// assert idle CPU stays near zero.
//
// The e2e spec (tests/e2e/desktop-demo-smoke.spec.ts) reads state through
// the MCP tools declared below — every demo mutation lands in `demoState`
// so the spec can assert without synthetic input plumbing.

const MENU: AppMenuModel = {
  items: [
    {
      type: "submenu",
      label: "App",
      items: [
        { id: "app.about", label: "About Desktop Demo" },
        { type: "separator" },
        { id: "app.close", label: "Close Window", accelerator: "CmdOrCtrl+W" },
      ],
    },
    {
      type: "submenu",
      label: "View",
      items: [
        { type: "check", id: "view.veto", label: "Simulate Unsaved Changes", checked: false },
        { type: "separator" },
        { id: "view.repaint", label: "Repaint", accelerator: "F5" },
      ],
    },
    {
      type: "submenu",
      label: "Tools",
      items: [
        { id: "tools.tray", label: "Toggle Tray Icon" },
        { id: "tools.open", label: "Open File Dialog" },
        { id: "tools.notify", label: "Send Notification" },
      ],
    },
  ],
};

let appWindow: AppWindow | undefined;
let menuBackend: AppMenuBackend = "unavailable";
let theme = "unknown";
let inWindowBar = false;

const secondInstanceLog: { argv: string[]; cwd: string }[] = [];
const demoState = {
  vetoArmed: false,
  trayCreated: false,
  settingsWrites: 0,
  lastDialog: null as unknown,
  lastNotification: null as string | null,
  lastMenuAction: null as string | null,
};

// The native entry's onCloseRequest consults this flag — armed means the
// app pretends to hold unsaved changes and vetoes the close.
(globalThis as any).__demoVetoArmed = false;

function setVeto(armed: boolean): void {
  demoState.vetoArmed = armed;
  (globalThis as any).__demoVetoArmed = armed;
  downdraft.setMenuItemChecked?.("view.veto", armed);
}

function toggleTray(): boolean {
  const api = downdraft.tray;
  if (!api) return false;
  if (demoState.trayCreated) {
    demoState.trayCreated = !api.destroy();
    return true;
  }
  demoState.trayCreated = api.create({
    tooltip: "Desktop Demo",
    menu: {
      items: [
        { id: "hello", label: "Tray hello" },
        { id: "show", label: "Show window" },
      ],
    },
  });
  return demoState.trayCreated;
}

function handleMenu(id: string): void {
  demoState.lastMenuAction = id;
  switch (id) {
    case "app.close":
      appWindow?.native.requestClose();
      break;
    case "view.veto":
      setVeto(!demoState.vetoArmed);
      break;
    case "tools.tray":
      toggleTray();
      break;
    case "tools.open":
      void downdraft.showOpenDialog?.({ title: "Open" }).then((paths) => {
        demoState.lastDialog = { kind: "open", paths };
      });
      break;
    case "tools.notify":
      void downdraft.notify?.({ title: "Desktop Demo", body: "Hello from the menu" }).then((ok) => {
        demoState.lastNotification = ok ? "sent" : "unavailable";
      });
      break;
    default:
      break;
  }
}

function page(): string {
  return `<html><head>${kitStyleTag()}</head><body>
    ${inWindowBar ? menuBar({ model: MENU }) : ""}
    <main class="app-main">
      <h1>Desktop Demo</h1>
      <p class="muted">menu backend: <b id="backend">${menuBackend}</b></p>
      <p class="muted">theme: <b id="theme">${theme}</b></p>
      <p class="muted">veto armed: <b id="veto">${demoState.vetoArmed}</b></p>
      <p class="muted">tray: <b id="tray">${demoState.trayCreated}</b></p>
      <p class="muted">instances seen: <b id="instances">1</b></p>
      <p class="muted">demo.count = <b id="count">${downdraft.settings?.get<number>("demo.count", 0) ?? 0}</b></p>
      <p class="muted">last dialog: <b id="dialog">-</b></p>
      <p class="muted">last action: <b id="action">-</b></p>
      <div>
        <button data-action="open">Open…</button>
        <button data-action="save">Save As…</button>
        <button data-action="notify">Notify</button>
        <button data-action="tray">Tray</button>
        <button data-action="veto">Toggle veto</button>
        <button data-action="count">Count++</button>
        <button data-action="close">Close window</button>
      </div>
    </main>
  </body></html>`;
}

export const appModule: AppModule = {
  // 2D, zero viewports, damage-driven — the renderer idles at ~0 GPU when
  // nothing on screen changes.
  renderer: (canvas) => {
    const r = new AppRenderer(canvas, {
      mode: "2d",
      damageOnly: true,
      clearColor: { r: 0.12, g: 0.12, b: 0.14, a: 1 },
    });
    r.setViewportCount(0);
    return r;
  },

  onReady(ctx: AppContext) {
    appWindow = AppWindow.primary();
    theme = downdraft.getTheme?.() ?? "unknown";

    // App menu — native where the OS supports it (Windows/macOS), the
    // html-ui kit MenuBar in-window elsewhere (Linux). The return tells us
    // which backend is live; item picks arrive through onMenuAction either
    // way.
    menuBackend = downdraft.setMenu?.(MENU) ?? "unavailable";
    inWindowBar = menuBackend === "inwindow";
    downdraft.onMenuAction?.((id) => {
      handleMenu(id);
      refresh?.();
    });
    downdraft.tray?.onAction((id) => {
      demoState.lastMenuAction = `tray:${id}`;
      if (id === "show") appWindow?.setVisible(true);
    });
    downdraft.onThemeChanged?.((t) => {
      theme = t;
    });
    downdraft.onSecondInstance?.(({ argv, cwd }) => {
      secondInstanceLog.push({ argv: argv.slice(), cwd });
      refresh?.();
    });

    let refresh: (() => void) | undefined;

    ctx.renderer.useRendererModule?.(
      createHtmlUi({
        build(ui) {
          const doc = ui.mount(page(), {
            id: "demo",
            rect: { x: 0, y: 0, w: 1, h: 1 }, // fit:true tracks the surface
            fit: true,
          });
          refresh = () => {
            doc.setText("#backend", menuBackend);
            doc.setText("#theme", theme);
            doc.setText("#veto", String(demoState.vetoArmed));
            doc.setText("#tray", String(demoState.trayCreated));
            doc.setText("#instances", String(1 + secondInstanceLog.length));
            doc.setText("#count", String(downdraft.settings?.get<number>("demo.count", 0) ?? 0));
            doc.setText("#dialog", JSON.stringify(demoState.lastDialog) ?? "-");
            doc.setText("#action", demoState.lastMenuAction ?? "-");
          };

          bindKit(doc, {
            onAction(verb, data) {
              if (verb === "menuitem") {
                handleMenu(data.mid ?? "");
                refresh?.();
              }
            },
          });

          ui.onAction("open", async () => {
            const paths = await downdraft.showOpenDialog?.({ title: "Open" });
            demoState.lastDialog = { kind: "open", paths };
            refresh?.();
          });
          ui.onAction("save", async () => {
            const path = await downdraft.showSaveDialog?.({ title: "Save As", defaultName: "demo.txt" });
            demoState.lastDialog = { kind: "save", path };
            refresh?.();
          });
          ui.onAction("notify", () => {
            void downdraft.notify?.({ title: "Desktop Demo", body: "Hello" }).then((ok) => {
              demoState.lastNotification = ok ? "sent" : "unavailable";
              refresh?.();
            });
          });
          ui.onAction("tray", () => { toggleTray(); refresh?.(); });
          ui.onAction("veto", () => { setVeto(!demoState.vetoArmed); refresh?.(); });
          ui.onAction("count", () => {
            downdraft.settings?.set("demo.count", (downdraft.settings.get<number>("demo.count", 0) ?? 0) + 1);
            demoState.settingsWrites++;
            refresh?.();
          });
          ui.onAction("close", () => appWindow?.native.requestClose());
        },
      }),
    );
  },

  mcp: (ctx) =>
    createAppMcp({
      appId: "downdraft-desktop-demo",
      surface: () => ctx.surface,
      getUiState: () => demoState,
      tools: [
        {
          def: {
            name: "demo_state",
            description: "Snapshot of the desktop demo's observable state.",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () =>
            jsonResult({
              ...demoState,
              secondInstanceLog: secondInstanceLog.map((s) => ({ ...s })),
              menuBackend,
              theme,
              windowClosed: appWindow?.closed ?? true,
              pumpStats: appWindow?.native.getPumpStats() ?? null,
            }),
        },
        {
          def: {
            name: "demo_request_close",
            description: "Run the vetoable close path (as the OS close button would).",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () => {
            appWindow?.native.requestClose();
            return jsonResult({ closed: appWindow?.closed ?? true });
          },
        },
        {
          def: {
            name: "demo_set_veto",
            description: "Arm or disarm the close veto.",
            inputSchema: {
              type: "object",
              properties: { armed: { type: "boolean" } },
              required: ["armed"],
            },
          },
          handler: (p) => {
            setVeto(p.armed === true);
            return jsonResult({ armed: demoState.vetoArmed });
          },
        },
        {
          def: {
            name: "demo_tray",
            description: "Toggle the tray icon. Returns whether it exists.",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () => jsonResult({ trayCreated: toggleTray(), trayBackend: !!downdraft.tray }),
        },
        {
          def: {
            name: "demo_pump_stats",
            description: "Native event-pump counters for idle-CPU assertions.",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () => jsonResult(appWindow?.native.getPumpStats() ?? null),
        },
        {
          def: {
            name: "demo_dialog",
            description:
              "Invoke a file dialog (kind=open|save) — DD_DIALOGS_MOCK-aware, " +
              "returns the recorded result.",
            inputSchema: {
              type: "object",
              properties: { kind: { type: "string", enum: ["open", "save"] } },
              required: ["kind"],
            },
          },
          handler: async (p) => {
            if (p.kind === "save") {
              const path = await downdraft.showSaveDialog?.({ title: "Save As", defaultName: "demo.txt" });
              demoState.lastDialog = { kind: "save", path };
            } else {
              const paths = await downdraft.showOpenDialog?.({ title: "Open" });
              demoState.lastDialog = { kind: "open", paths };
            }
            return jsonResult(demoState.lastDialog);
          },
        },
        {
          def: {
            name: "demo_settings",
            description: "Settings write/read roundtrip — sets a key and reads it back.",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string" }, value: {} },
              required: ["key", "value"],
            },
          },
          handler: (p) => {
            downdraft.settings?.set(String(p.key), p.value);
            demoState.settingsWrites++;
            const read = downdraft.settings?.get(p.key as string);
            return jsonResult({ written: p.value, read, match: read === p.value });
          },
        },
      ],
    }),
};
