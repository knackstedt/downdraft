// ============================================================================
// pages.ts — document markup for the app shell: sidebar nav + page region.
// Each page renders from `store` and is re-rendered via setInnerHtml on
// store.notify(). Phase-1 skeleton: real daemon state where wired, empty
// states elsewhere.
// ============================================================================

import * as kit from "@downdraft/engine/libraries/html-ui-kit";
import { PAGES, store, type PageId } from "./store";

export const APP_CSS = `
  .rd-shell { display:flex; flex-direction:row; width:100%; height:100%; }
  .rd-side { width:196px; flex:0 0 196px; display:flex; flex-direction:column;
    border-right:1px solid var(--dd-line); padding:12px 8px; gap:2px; }
  .rd-logo { font-size:15px; font-weight:700; padding:4px 8px 10px 8px; }
  .rd-nav { padding:5px 8px; border-radius:6px; cursor:pointer; font-size:12px; }
  .rd-nav:hover { background:var(--dd-hover, rgba(255,255,255,.06)); }
  .rd-nav[data-on="true"] { background:var(--dd-accent-dim, rgba(90,140,255,.18)); color:var(--dd-accent, #8ab4ff); }
  .rd-sidefoot { margin-top:auto; padding:8px; font-size:10px; color:var(--dd-dim); }
  .rd-main { flex:1; display:flex; flex-direction:column; min-width:0; }
  .rd-content { flex:1; overflow:hidden; padding:16px; }
  .rd-h { font-size:14px; font-weight:600; margin-bottom:10px; }
  .rd-cards { display:flex; flex-direction:row; flex-wrap:wrap; gap:10px; }
  .rd-card { border:1px solid var(--dd-line); border-radius:8px; padding:12px;
    min-width:230px; flex:1 1 230px; display:flex; flex-direction:column; gap:6px; }
  .rd-card-t { font-size:12px; font-weight:600; }
  .rd-card-m { font-size:10px; color:var(--dd-dim); }
  .rd-empty { color:var(--dd-dim); font-size:12px; padding:24px 0; text-align:center; }
  .rd-warn { color:#e8b458; }
  .rd-err { color:#e06c60; }
`;

function esc(s: string): string {
  return kit.esc(s);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function sidebarHtml(): string {
  const items = PAGES.map((p) =>
    `<div class="rd-nav" data-action="nav" data-page="${p.id}" data-on="${store.page === p.id}" data-nav>${esc(p.title)}</div>`
  ).join("");
  const conn = store.daemonConnected
    ? `<span>daemon: <b style="color:#7ec87e">connected</b></span>`
    : `<span class="rd-err">daemon: offline</span>`;
  const ver = store.status ? ` · v${esc(store.status.version)}` : "";
  return `<div class="rd-side">
    <div class="rd-logo">Redoubt</div>
    ${items}
    <div class="rd-sidefoot" id="rd-conn">${conn}${ver}</div>
  </div>`;
}

// ── pages ──

function overviewPage(): string {
  const jobs = store.jobs.filter((j) => j.state === "running" || j.state === "queued");
  const planCards = store.plans.map((p) => {
    const repo = store.repositories.find((r) => r.id === p.repositoryId);
    return `<div class="rd-card">
      <div class="rd-card-t">${esc(p.name)}</div>
      <div class="rd-card-m">${p.sources.length} source${p.sources.length === 1 ? "" : "s"} → ${esc(repo?.name ?? "?")}</div>
      <div class="rd-card-m">keep ≥${p.retention.minCount}${p.retention.maxAgeDays ? ` · ≤${p.retention.maxAgeDays}d` : ""}</div>
    </div>`;
  }).join("");
  const active = jobs.length
    ? jobs.map((j) => `<div class="rd-card"><div class="rd-card-t">${esc(j.kind)}</div>
        ${kit.progressBar({ value: j.progress * 100 })}
        <div class="rd-card-m">${esc(j.message)}</div></div>`).join("")
    : `<div class="rd-empty">No jobs running.</div>`;
  return `<div class="rd-h">Overview</div>
    ${kit.sectionLabel("Active jobs")}
    <div class="rd-cards">${active}</div>
    ${kit.spacer(8)}
    ${kit.sectionLabel("Backup plans")}
    <div class="rd-cards">${planCards || `<div class="rd-empty">No plans yet — create one on the Plans page.</div>`}</div>`;
}

function plansPage(): string {
  const rows = store.plans.map((p) => [
    p.name,
    p.sources.map((s) => s.path).join(", "),
    store.repositories.find((r) => r.id === p.repositoryId)?.name ?? "?",
    p.enabled ? "enabled" : "disabled",
  ]);
  return `<div class="rd-h">Backup Plans</div>
    ${store.plans.length
      ? kit.dataTable({ id: "plans-table", cols: ["Name", "Sources", "Repository", "State"], rows })
      : `<div class="rd-empty">No backup plans configured.</div>`}
    ${kit.spacer(8)}
    ${kit.button({ id: "btn-new-plan", label: "New Plan…", kind: "accent", action: "plan:new" })}`;
}

function targetsPage(): string {
  const rows = store.targets.map((t) => [t.name, t.kind, t.ref]);
  return `<div class="rd-h">Targets</div>
    ${store.targets.length
      ? kit.dataTable({ id: "targets-table", cols: ["Name", "Kind", "Remote / Path"], rows })
      : `<div class="rd-empty">No rclone remotes or folders configured.</div>`}
    ${kit.spacer(8)}
    ${kit.button({ id: "btn-new-target", label: "Add Target…", kind: "accent", action: "target:new" })}`;
}

function snapshotsPage(): string {
  return `<div class="rd-h">Snapshots</div>
    <div class="rd-empty">Select a plan to browse its snapshots. (Phase 5 adds mount + restore.)</div>`;
}

function syncPage(): string {
  const rows = store.syncs.map((s) => [s.name, s.localPath, s.remote, s.direction, s.enabled ? "enabled" : "disabled"]);
  return `<div class="rd-h">Sync Jobs</div>
    ${store.syncs.length
      ? kit.dataTable({ id: "sync-table", cols: ["Name", "Local", "Remote", "Mode", "State"], rows })
      : `<div class="rd-empty">No sync jobs configured.</div>`}
    ${kit.spacer(8)}
    ${kit.button({ id: "btn-new-sync", label: "New Sync…", kind: "accent", action: "sync:new" })}`;
}

function settingsPage(): string {
  const s = store.status;
  return `<div class="rd-h">Settings</div>
    ${kit.kvTable([
      ["Daemon", store.daemonConnected ? `connected (pid ${s?.pid ?? "?"})` : "offline"],
      ["Daemon version", s?.version ?? "—"],
      ["Socket", s?.socketPath ?? "—"],
      ["kopia binary", s?.kopiaBin ?? "not found"],
      ["rclone binary", s?.rcloneBin ?? "not found"],
      ["Repositories", String(s?.counts.repositories ?? 0)],
      ["Plans", String(s?.counts.plans ?? 0)],
      ["Targets", String(s?.counts.targets ?? 0)],
    ])}
    ${kit.spacer(8)}
    ${kit.button({ id: "btn-reconnect", label: "Reconnect daemon", action: "daemon:reconnect" })}`;
}

export function pageInnerHtml(page: PageId): string {
  switch (page) {
    case "overview": return overviewPage();
    case "plans": return plansPage();
    case "targets": return targetsPage();
    case "snapshots": return snapshotsPage();
    case "sync": return syncPage();
    case "settings": return settingsPage();
  }
}

export function shellHtml(): string {
  return `<div class="rd-shell">
    ${sidebarHtml()}
    <div class="rd-main"><div class="dd-scroll rd-content" id="rd-page" data-kit="scroll" data-id="rd-page">${pageInnerHtml(store.page)}</div></div>
  </div>`;
}
