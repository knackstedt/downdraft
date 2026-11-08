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
    client.onEvent((method, params) => {
      if (method.startsWith("job.")) void refreshAll();
      if (method === "job.done") {
        const j = (params as { job?: { state?: string; kind?: string } } | undefined)?.job;
        if (j?.kind === "backup") toast(j.state === "done" ? "backup finished" : `backup ${j.state}`, j.state === "done" ? "good" : "bad");
      }
      if (method === "storage.warning") {
        store.storageWarn = String((params as { reason?: string })?.reason ?? "storage running low");
        toast(`storage warning: ${store.storageWarn}`, "warn");
      }
      if (method === "password.due") {
        const id = String((params as { repositoryId?: string })?.repositoryId ?? "");
        if (id && !store.passwordDue.includes(id)) store.passwordDue.push(id);
        toast("repository password check due", "warn");
      }
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
              if (verb === "dismiss") return;
              handleVerb(verb, data);
            },
            onChange(id, kind, value) {
              if (kind === "input" || kind === "number") store.form[id] = String(value);
              else if (kind === "choice") {
                if (id === "plan-repo") store.form["plan-repo-i"] = String(store.repositories.findIndex((r) => r.name === value));
                if (id === "plan-sched") store.form["plan-sched-i"] = String(["manual", "hourly", "daily", "every N minutes"].indexOf(String(value)));
                if (id === "snap-plan") {
                  const p = store.plans.find((x) => x.name === value);
                  if (p) { store.snapshotsPlanId = p.id; void loadSnapshots(); }
                }
                if (id === "remote-type") {
                  store.form["remote-type-i"] = String(store.remoteTypes.findIndex((t) => t.label === value));
                  store.authState = null;
                  refresh?.();
                }
                if (id === "repo-prov") { store.form["repo-prov"] = String(value); refresh?.(); }
                if (id === "repo-remote") {
                  const remotes = store.targets.filter((t) => t.kind === "rclone");
                  store.form["repo-remote-i"] = String(remotes.findIndex((t) => t.name === value));
                }
              } else if (kind === "select") {
                if (id === "snap-table") store.selectedSnapIdx = Number(value);
              }
            },
          });

          ui.onAction("nav", (d) => navTo(d.page as PageId));

          async function loadSnapshots(): Promise<void> {
            if (!store.snapshotsPlanId) return;
            store.snapshotsLoading = true; refresh?.();
            try {
              store.snapshots = await client.rpc("snapshot.list", { planId: store.snapshotsPlanId }) as typeof store.snapshots;
            } catch (e) { store.snapshots = []; toast(`snapshot list: ${e}`, "warn"); }
            store.snapshotsLoading = false; store.notify();
          }

          function openModal(kind: typeof store.modal, payload: Record<string, string> = {}): void {
            store.modal = kind; store.modalPayload = payload; store.form = {}; store.formError = null; refresh?.();
          }
          function closeModal(): void { store.modal = null; store.busy = false; refresh?.(); }
          function formErr(msg: string): void { store.formError = msg; refresh?.(); }

          async function pickInto(field: string): Promise<void> {
            const p = await downdraft.pickFolder?.({});
            if (p?.[0]) { store.form[field] = p[0]; refresh?.(); }
          }

          async function submitModal(): Promise<void> {
            const f = store.form;
            try {
              if (store.modal === "new-repo") {
                if (!f["repo-name"]) return formErr("name required");
                let location: Record<string, unknown>;
                if ((f["repo-prov"] ?? "filesystem") === "rclone") {
                  const remotes = store.targets.filter((t) => t.kind === "rclone");
                  const remote = remotes[Number(f["repo-remote-i"] ?? 0)];
                  if (!remote) return formErr("pick an rclone remote (add one below)");
                  location = { provider: "rclone", remote: remote.name, path: f["repo-rpath"] || "redoubt" };
                } else {
                  if (!f["repo-path"]) return formErr("folder required");
                  location = { provider: "filesystem", path: f["repo-path"] };
                }
                if (!f["repo-pw"]) return formErr("passphrase required");
                if (f["repo-pw"] !== f["repo-pw2"]) return formErr("passphrases don't match");
                store.busy = true; refresh?.();
                await client.rpc("repo.create", { name: f["repo-name"], passphrase: f["repo-pw"], location });
                toast("repository created", "good"); closeModal(); await refreshAll();
              } else if (store.modal === "new-remote") {
                if (!f["remote-name"]) return formErr("name required");
                const sel = store.remoteTypes[Number(f["remote-type-i"] ?? 0)];
                if (!sel) return formErr("pick a type");
                store.busy = true; refresh?.();
                if (sel.oauth) {
                  if (store.authState?.state !== "done" || !store.authState.token) {
                    store.busy = false;
                    return formErr("finish browser authorization first");
                  }
                  await client.rpc("target.authorizeFinish", { name: f["remote-name"], type: sel.type, token: store.authState.token });
                } else {
                  const params: Record<string, string> = {};
                  sel.params.forEach((p) => { const v = f[`rp-${p.key}`]; if (v) params[p.key] = v; });
                  await client.rpc("target.addRemote", { name: f["remote-name"], type: sel.type, params });
                }
                toast(`remote ${f["remote-name"]} added`, "good"); closeModal(); await refreshAll();
              } else if (store.modal === "new-plan") {
                if (!f["plan-name"]) return formErr("name required");
                if (!f["plan-src"]) return formErr("source folder required");
                const repo = store.repositories[Number(f["plan-repo-i"] ?? 0)];
                if (!repo) return formErr("create a repository first (Targets page)");
                const schedIdx = Number(f["plan-sched-i"] ?? 0);
                const schedRule = schedIdx === 1 ? { kind: "hourly" }
                  : schedIdx === 2 ? { kind: "daily", hour: 2, minute: 0 }
                  : schedIdx === 3 ? { kind: "interval", everyMinutes: Number(f["plan-sched-min"]) || 60 }
                  : null;
                const schedule = schedRule ? { rule: schedRule, onTargetAvailable: false, onAcOnly: false } : null;
                store.busy = true; refresh?.();
                await client.rpc("plan.create", { id: "", name: f["plan-name"], sources: [{ path: f["plan-src"], excludeProfileId: "default", extraExcludes: [] }], repositoryId: repo.id, retention: { minCount: Number(f["plan-min"] ?? 3) || 3, maxAgeDays: Number(f["plan-maxage"]) || null }, enabled: true, schedule });
                toast("plan created", "good"); closeModal(); await refreshAll();
              } else if (store.modal === "restore") {
                const dir = f["restore-dir"];
                if (!dir) return formErr("choose a target folder");
                store.busy = true; refresh?.();
                const repo = store.repositories.find((r) => r.id === store.modalPayload.repositoryId);
                await client.rpc("snapshot.restore", { repositoryId: repo?.id, snapshotId: store.modalPayload.snapshotId, targetDir: dir });
                toast(`restore started → ${dir}`, "good"); closeModal();
              } else if (store.modal === "unlock-repo") {
                store.busy = true; refresh?.();
                if (store.modalPayload.verify === "1") {
                  const r = await client.rpc<{ ok: boolean }>("repo.passwordVerify", { id: store.modalPayload.id, passphrase: f["unlock-pw"] });
                  if (!r.ok) { store.busy = false; return formErr("wrong passphrase"); }
                  store.passwordDue = store.passwordDue.filter((x) => x !== store.modalPayload.id);
                  toast("passphrase confirmed", "good"); closeModal(); await refreshAll();
                } else {
                  await client.rpc("repo.unlock", { id: store.modalPayload.id, passphrase: f["unlock-pw"] });
                  toast("repository unlocked", "good"); closeModal(); await refreshAll();
                }
              }
            } catch (e) {
              store.busy = false;
              formErr(String(e));
            }
          }

          function handleVerb(verb: string, _data: Record<string, string>): void {
            switch (verb) {
              case "daemon:reconnect": void ensureDaemon(client).then(refreshAll); break;
              case "repo:new": openModal("new-repo"); break;
              case "plan:new": openModal("new-plan"); break;
              case "target:new":
                void (async () => {
                  if (!store.remoteTypes.length) {
                    try { store.remoteTypes = await client.rpc("target.types") as typeof store.remoteTypes; } catch { /* daemon old */ }
                  }
                  openModal("new-remote");
                })();
                break;
              case "target:import":
                void client.rpc("target.importConf").then((r) => {
                  const n = (r as { imported?: string[] }).imported?.length ?? 0;
                  toast(n ? `imported ${n} remote(s)` : "nothing new to import", n ? "good" : "info");
                  void refreshAll();
                }).catch((e) => toast(`import: ${e}`, "bad"));
                break;
              case "target:about":
                void (async () => {
                  for (const t of store.targets) {
                    const remote = t.kind === "rclone" ? t.ref : `local:${t.ref}`;
                    try { store.about[t.ref] = await client.rpc("target.about", { remote }) as never; }
                    catch { store.about[t.ref] = "error"; }
                  }
                  store.notify();
                })();
                break;
              case "target:authorize":
                void (async () => {
                  try {
                    const sel = store.remoteTypes[Number(store.form["remote-type-i"] ?? 0)];
                    if (!sel) return;
                    const r = await client.rpc<{ flowId: number }>("target.authorizeStart", { type: sel.type });
                    store.authState = { flowId: r.flowId, state: "waiting" }; refresh?.();
                    for (let i = 0; i < 150; i++) {
                      await new Promise((res) => setTimeout(res, 2000));
                      const p = await client.rpc<{ state: string; token?: string }>("target.authorizePoll", { flowId: r.flowId });
                      if (p.state === "done") {
                        store.authState = { flowId: r.flowId, state: "done", token: p.token };
                        refresh?.(); return;
                      }
                    }
                  } catch (e) { store.authState = null; formErr(`authorize: ${e}`); }
                })();
                break;
              case "sync:new": toast("sync editor lands in phase 6", "info"); break;
              case "snap:refresh": void loadSnapshots(); break;
              case "snap:restore": {
                const s = store.snapshots[store.selectedSnapIdx ?? 0];
                if (!s) { toast("select a snapshot row first", "warn"); break; }
                const plan = store.plans.find((p) => p.id === store.snapshotsPlanId);
                openModal("restore", { snapshotId: s.id, source: s.source, repositoryId: plan?.repositoryId ?? "" });
                break;
              }
              case "repo:browse": void pickInto("repo-path"); break;
              case "src:browse": void pickInto("plan-src"); break;
              case "restore:browse": void pickInto("restore-dir"); break;
              case "modal:ok": void submitModal(); break;
              case "modal:cancel": closeModal(); break;
              default:
                if (verb.startsWith("pw:verify:")) {
                  const id = verb.slice("pw:verify:".length);
                  const repo = store.repositories.find((r) => r.id === id);
                  if (repo) openModal("unlock-repo", { id, name: repo.name, verify: "1" });
                }
                break;
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
