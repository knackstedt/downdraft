// ============================================================================
// app-module.ts — Redoubt app host.
//
// The window is a thin client for `redoubtd`: all state lives in the daemon
// and arrives over the unix-socket JSON-RPC link (daemon-client.ts). The
// shell is one fit:true Blitz doc with a sidebar + page region; pages
// re-render on store.notify() (subscription → setInnerHtml). closePolicy
// "explicit" hides the window on close — quitting is File→Quit / tray Quit.
// ============================================================================

import { AppRenderer } from "@downdraft/engine";
import { createAppMcp, downdraft, jsonResult, type AppContext, type AppModule } from "@downdraft/engine/app/main";
import type { AppMenuBackend, AppMenuModel } from "@downdraft/engine/app/shared/types";
import { bindKit, kitStyleTag, menuBar, toastStack, type Toast } from "@downdraft/engine/libraries/html-ui-kit";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { AppWindow } from "@downdraft/platform-native";
import { DaemonClient, ensureDaemon } from "./daemon-client";
import { APP_CSS, shellHtml } from "./pages";
import { PAGES, store, type PageId } from "./store";
import type { JobInfo, Plan, Repository, SyncJob, Target } from "./protocol";

// ── menu model ──

const MENU: AppMenuModel = {
  items: [
    {
      type: "submenu", label: "File", items: [
        { id: "file.backupnow", label: "Back Up Now", accelerator: "CmdOrCtrl+B" },
        { type: "separator" },
        { id: "file.close", label: "Hide Window", accelerator: "CmdOrCtrl+W" },
        { id: "file.quit", label: "Quit Redoubt", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      type: "submenu", label: "View", items: [
        { id: "view.overview", label: "Overview", accelerator: "CmdOrCtrl+1" },
        { id: "view.plans", label: "Backup Plans", accelerator: "CmdOrCtrl+2" },
        { id: "view.targets", label: "Targets", accelerator: "CmdOrCtrl+3" },
        { id: "view.snapshots", label: "Snapshots", accelerator: "CmdOrCtrl+4" },
        { id: "view.sync", label: "Sync", accelerator: "CmdOrCtrl+5" },
        { id: "view.settings", label: "Settings", accelerator: "CmdOrCtrl+6" },
        { type: "separator" },
        { id: "view.repaint", label: "Repaint", accelerator: "F5" },
      ],
    },
    {
      type: "submenu", label: "Tools", items: [
        { id: "tools.tray", label: "Toggle Tray Icon" },
        { id: "tools.daemon", label: "Daemon Status" },
        { type: "separator" },
        { id: "tools.notify", label: "Test Notification" },
      ],
    },
  ],
};

let appWindow: AppWindow | undefined;
let menuBackend: AppMenuBackend = "unavailable";
let inWindowBar = false;
const toasts: Toast[] = [];
const client = new DaemonClient();

function toast(text: string, kind: Toast["kind"] = "info"): void {
  toasts.push({ id: `t${Date.now()}-${toasts.length}`, message: text, kind });
  refresh?.();
}

function navTo(page: PageId): void {
  store.page = page;
  downdraft.settings?.set("ui.page", page);
  refresh?.();
}

function handleMenu(id: string): void {
  if (id === "view.repaint") { refresh?.(); return; }
  if (id.startsWith("view.")) {
    const page = id.slice(5) as PageId;
    if (PAGES.some((p) => p.id === page)) navTo(page);
    return;
  }
  switch (id) {
    case "file.close": appWindow?.native.requestClose(); break;
    case "file.quit": void downdraft.quit(); break;
    case "file.backupnow": void runBackupNow(); break;
    case "tools.tray": toggleTray(); break;
    case "tools.daemon": void refreshAll().then(() => toast(store.daemonConnected ? "daemon connected" : "daemon offline", store.daemonConnected ? "good" : "bad")); break;
    case "tools.notify": void downdraft.notify?.({ title: "Redoubt", body: "Notifications work." }); break;
    default: break;
  }
}

let trayCreated = false;
function toggleTray(): boolean {
  const api = downdraft.tray;
  if (!api) { toast("no tray backend (no SNI watcher?)", "warn"); return false; }
  if (trayCreated) { trayCreated = !api.destroy(); refresh?.(); return true; }
  trayCreated = api.create({
    tooltip: "Redoubt",
    menu: {
      items: [
        { id: "show", label: "Show Redoubt" },
        { id: "backupnow", label: "Back Up Now" },
        { type: "separator" },
        { id: "quit", label: "Quit" },
      ],
    },
  });
  refresh?.();
  return trayCreated;
}

async function runBackupNow(): Promise<void> {
  if (!client.connected) { toast("daemon offline", "bad"); return; }
  const plan = store.plans.find((p) => p.enabled);
  if (!plan) { toast("no enabled plan", "warn"); return; }
  try { await client.rpc("plan.runNow", { id: plan.id }); }
  catch (e) { toast(`run failed: ${e}`, "bad"); }
}

// ── daemon refresh ──

async function refreshAll(): Promise<void> {
  if (!client.connected) { store.daemonConnected = false; store.notify(); return; }
  try {
    const [status, plans, repositories, targets, syncs, jobs] = await Promise.all([
      client.status(),
      client.rpc<Plan[]>("plan.list"),
      client.rpc<Repository[]>("repo.list"),
      client.rpc<Target[]>("target.list"),
      client.rpc<SyncJob[]>("sync.list"),
      client.rpc<JobInfo[]>("job.list"),
    ]);
    store.status = status;
    store.plans = plans;
    store.repositories = repositories;
    store.targets = targets;
    store.syncs = syncs;
    store.jobs = jobs;
    store.daemonConnected = true;
    store.lastError = null;
  } catch (e) {
    store.daemonConnected = false;
    store.lastError = String(e);
  }
  store.notify();
}

let refresh: (() => void) | undefined;

export const appModule: AppModule = {
  // 2D, zero viewports, damage-driven — the window idles at ~0 GPU while the
  // daemon does the real work.
  renderer: (canvas) => {
    const r = new AppRenderer(canvas, {
      mode: "2d",
      damageOnly: true,
      clearColor: { r: 0.09, g: 0.09, b: 0.11, a: 1 },
    });
    r.setViewportCount(0);
    return r;
  },

  onReady(ctx: AppContext) {
    appWindow = AppWindow.primary();

    menuBackend = downdraft.setMenu?.(MENU) ?? "unavailable";
    inWindowBar = menuBackend === "inwindow";
    downdraft.onMenuAction?.((id) => handleMenu(id));
    downdraft.tray?.onAction((id) => {
      if (id === "show") appWindow?.setVisible(true);
      else if (id === "backupnow") void runBackupNow();
      else if (id === "quit") void downdraft.quit();
    });

    const saved = downdraft.settings?.get<string>("ui.page", "overview");
    if (PAGES.some((p) => p.id === saved)) store.page = saved as PageId;

    client.onConnection((connected) => {
      store.daemonConnected = connected;
      if (connected) void refreshAll(); else store.notify();
    });
    client.onEvent((method) => {
      if (method.startsWith("job.")) void refreshAll();
    });

    ctx.renderer.useRendererModule?.(
      createHtmlUi({
        build(ui) {
          const doc = ui.mount(
            `<html><head>${kitStyleTag()}<style>${APP_CSS}</style></head><body>
              ${inWindowBar ? menuBar({ model: MENU }) : ""}
              <div id="rd-root">${shellHtml()}</div>
              <div id="rd-toasts">${toastStack(toasts)}</div>
            </body></html>`,
            { id: "app", rect: { x: 0, y: 0, w: 1, h: 1 }, fit: true },
          );

          refresh = () => {
            doc.setInnerHtml("#rd-root", shellHtml());
            doc.setInnerHtml("#rd-toasts", toastStack(toasts));
          };
          store.subscribe(refresh);

          bindKit(doc, {
            onAction(verb, data) {
              if (verb === "menuitem") { handleMenu(data.mid ?? ""); return; }
              if (verb === "dismiss") { /* toast dismiss handled by kit */ return; }
              handleVerb(verb, data);
            },
          });

          ui.onAction("nav", (d) => navTo(d.page as PageId));

          function handleVerb(verb: string, _data: Record<string, string>): void {
            switch (verb) {
              case "daemon:reconnect": void ensureDaemon(client).then(refreshAll); break;
              case "plan:new": toast("plan editor lands in phase 2", "info"); break;
              case "target:new": toast("target wizard lands in phase 3", "info"); break;
              case "sync:new": toast("sync editor lands in phase 6", "info"); break;
              default: break;
            }
          }
        },
      }),
    );

    void ensureDaemon(client).then(refreshAll);
  },

  mcp: (ctx) =>
    createAppMcp({
      appId: "downdraft-redoubt",
      surface: () => ctx.surface,
      getUiState: () => ({
        page: store.page,
        daemonConnected: store.daemonConnected,
        plans: store.plans.length,
        repositories: store.repositories.length,
        targets: store.targets.length,
        syncs: store.syncs.length,
        jobs: store.jobs.length,
        lastError: store.lastError,
      }),
      tools: [
        {
          def: {
            name: "daemon_status",
            description: "Daemon connection + version + binary resolution state.",
            inputSchema: { type: "object", properties: {} },
          },
          handler: () => jsonResult({ connected: store.daemonConnected, status: store.status }),
        },
        {
          def: {
            name: "daemon_rpc",
            description: "Call an arbitrary redoubtd RPC method (test surface).",
            inputSchema: {
              type: "object",
              properties: { method: { type: "string" }, params: {} },
              required: ["method"],
            },
          },
          handler: async (p) => {
            try { return jsonResult({ ok: true, result: await client.rpc(String(p.method), p.params) }); }
            catch (e) { return jsonResult({ ok: false, error: String(e) }); }
          },
        },
        {
          def: {
            name: "ui_nav",
            description: "Navigate to a page (overview|plans|targets|snapshots|sync|settings).",
            inputSchema: {
              type: "object",
              properties: { page: { type: "string" } },
              required: ["page"],
            },
          },
          handler: (p) => {
            navTo(String(p.page) as PageId);
            return jsonResult({ page: store.page });
          },
        },
      ],
    }),
};
