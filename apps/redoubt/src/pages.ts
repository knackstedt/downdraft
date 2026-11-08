// ============================================================================
// pages.ts — document markup for the app shell: sidebar nav + page region.
// Each page renders from `store` and is re-rendered via setInnerHtml on
// store.notify(). Phase-1 skeleton: real daemon state where wired, empty
// states elsewhere.
// ============================================================================

import * as kit from "@downdraft/engine/libraries/html-ui-kit";
import { PAGES, store, type PageId, type SunNode } from "./store";

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
  const banners = [
    ...store.passwordDue.map((id) => {
      const repo = store.repositories.find((r) => r.id === id);
      return `<div class="rd-card" style="border-color:#c99a3a">
        <div class="rd-card-t">Password check due — ${esc(repo?.name ?? id.slice(0, 8))}</div>
        <div class="rd-card-m">Re-enter the passphrase to confirm you remember it.</div>
        <div class="dd-row">${kit.button({ id: `pw-verify-${id}`, label: "Verify now", action: `pw:verify:${id}` })}</div>
      </div>`;
    }),
    ...(store.storageWarn
      ? [`<div class="rd-card" style="border-color:#c99a3a">
          <div class="rd-card-t">Storage warning</div>
          <div class="rd-card-m">${esc(store.storageWarn)}</div></div>`]
      : []),
  ].join("");
  const planCards = store.plans.map((p) => {
    const repo = store.repositories.find((r) => r.id === p.repositoryId);
    const r = p.schedule?.rule;
    const sched = !r ? "manual"
      : r.kind === "interval" ? `every ${r.everyMinutes}m`
      : r.kind === "hourly" ? "hourly"
      : r.kind === "daily" ? `daily ${r.hour}:${String(r.minute).padStart(2, "0")}`
      : `weekly`;
    const last = p.lastRunAt ? new Date(p.lastRunAt).toLocaleString() : "never";
    return `<div class="rd-card">
      <div class="rd-card-t">${esc(p.name)}</div>
      <div class="rd-card-m">${p.sources.length} source${p.sources.length === 1 ? "" : "s"} → ${esc(repo?.name ?? "?")}</div>
      <div class="rd-card-m">${sched} · last ${last} · keep ≥${p.retention.minCount}${p.retention.maxAgeDays ? ` · ≤${p.retention.maxAgeDays}d` : ""}</div>
    </div>`;
  }).join("");
  const active = jobs.length
    ? jobs.map((j) => `<div class="rd-card"><div class="rd-card-t">${esc(j.kind)}</div>
        ${kit.progressBar({ value: j.progress * 100 })}
        <div class="rd-card-m">${esc(j.message)}</div></div>`).join("")
    : `<div class="rd-empty">No jobs running.</div>`;
  return `<div class="rd-h">Overview</div>
    ${banners ? `<div class="rd-cards">${banners}</div>` : ""}
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
  const repoRows = store.repositories.map((r) => [
    r.name,
    r.location.provider === "filesystem" ? `fs: ${r.location.path}` : `rclone: ${r.location.remote}:${r.location.path}`,
  ]);
  const tgtRows = store.targets.map((t) => {
    const a = store.about[t.ref];
    const space = a === "error" ? "error" : a && a.free !== undefined ? `${fmtBytes(a.free)} free of ${fmtBytes(a.total)}` : "—";
    return [t.name, t.kind, t.ref, space];
  });
  return `<div class="rd-h">Targets</div>
    ${kit.sectionLabel("Repositories (backup destinations)")}
    ${repoRows.length
      ? kit.dataTable({ id: "repos-table", cols: ["Name", "Location"], rows: repoRows })
      : `<div class="rd-empty">No repositories yet.</div>`}
    ${kit.spacer(6)}
    <div class="dd-row" style="gap:8px">
      ${kit.button({ id: "btn-new-repo", label: "New Repository…", kind: "accent", action: "repo:new" })}
      ${kit.button({ id: "btn-recovery", label: "Recovery Key…", action: "repo:recovery", disabled: !store.repositories.length })}
    </div>
    ${kit.spacer(10)}
    ${kit.sectionLabel("Rclone remotes / folders")}
    ${tgtRows.length
      ? kit.dataTable({ id: "targets-table", cols: ["Name", "Kind", "Remote / Path", "Space"], rows: tgtRows })
      : `<div class="rd-empty">No rclone remotes or folders configured.</div>`}
    ${kit.spacer(8)}
    <div class="dd-row" style="gap:8px">
      ${kit.button({ id: "btn-new-target", label: "Add Remote…", kind: "accent", action: "target:new" })}
      ${kit.button({ id: "btn-import-conf", label: "Import rclone.conf", action: "target:import" })}
      ${kit.button({ id: "btn-about", label: "Check free space", action: "target:about", disabled: !store.targets.length })}
    </div>`;
}

function snapshotsPage(): string {
  const planOpts = store.plans.map((p) => p.name);
  const selIdx = Math.max(0, store.plans.findIndex((p) => p.id === store.snapshotsPlanId));
  const rows = store.snapshots.map((s) => [
    new Date(s.startTime).toLocaleString(),
    s.source,
    fmtBytes(s.sizeBytes),
    String(s.fileCount),
    s.id.slice(0, 10),
  ]);
  const list = store.snapshotsLoading
    ? `<div class="rd-empty">${kit.spinner({})} loading…</div>`
    : store.snapshots.length
      ? kit.dataTable({ id: "snap-table", cols: ["When", "Source", "Size", "Files", "ID"], rows })
      : `<div class="rd-empty">${store.snapshotsPlanId ? "No snapshots for this plan." : "Select a plan."}</div>`;
  return `<div class="rd-h">Snapshots</div>
    ${store.plans.length
      ? `<div class="dd-row" style="gap:8px;align-items:center">
          ${kit.label("Plan:")}
          ${kit.dropdown({ id: "snap-plan", options: planOpts, selected: store.snapshotsPlanId ? selIdx : undefined, placeholder: "Select plan…" })}
          ${kit.button({ id: "btn-snap-refresh", label: "Refresh", action: "snap:refresh", disabled: !store.snapshotsPlanId })}
        </div>`
      : `<div class="rd-empty">Create a plan first.</div>`}
    ${kit.spacer(8)}
    ${list}
    ${kit.spacer(8)}
    <div class="dd-row" style="gap:8px">
      ${kit.button({ id: "btn-snap-restore", label: "Restore Selected…", action: "snap:restore", disabled: !store.snapshots.length })}
      ${kit.button({ id: "btn-snap-browse", label: "Browse…", action: "snap:browse", disabled: !store.snapshots.length })}
      ${kit.button({ id: "btn-snap-mount", label: "Mount All", action: "snap:mount", disabled: !store.snapshotsPlanId })}
      ${kit.button({ id: "btn-snap-catalog", label: "Index Contents", action: "snap:catalog", disabled: !store.snapshots.length })}
    </div>`;
}

// ── Filelight-style sunburst ──

const SUN_COLORS = ["#5b8def", "#4fc08d", "#e2b33c", "#e06c60", "#9d6bdf", "#56b6c2", "#d19a66", "#c678dd"];

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const rad = (a: number) => (a - 90) * Math.PI / 180;
  const p = (r: number, a: number) => `${cx + r * Math.cos(rad(a))},${cy + r * Math.sin(rad(a))}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function sunburstSvg(nodes: SunNode[], size = 300): string {
  const cx = size / 2, cy = size / 2;
  const ringW = (size / 2 - 40) / 3;
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${40}" fill="#2a2e33"/>`;
  const emit = (list: SunNode[], a0: number, a1: number, ring: number, hueShift: number): void => {
    if (ring > 3) return;
    const sum = list.reduce((a, n) => a + Math.max(n.size, 0), 0) || 1;
    let a = a0;
    list.forEach((n, i) => {
      const span = (a1 - a0) * (Math.max(n.size, 0) / sum);
      const r0 = 40 + ring * ringW;
      const r1 = r0 + ringW - 2;
      const color = SUN_COLORS[(i + hueShift) % SUN_COLORS.length];
      svg += `<path d="${arcPath(cx, cy, r0, r1, a, a + span)}" fill="${color}" opacity="${0.9 - ring * 0.15}"><title>${esc(n.name)} — ${fmtBytes(n.size)}</title></path>`;
      if (n.children?.length && span > 4) emit(n.children, a, a + span, ring + 1, i + hueShift);
      a += span;
    });
  };
  emit(nodes, 0, 360, 0, 0);
  svg += `</svg>`;
  return svg;
}

function filesPage(): string {
  const snapList = store.plans.length ? store.snapshots : [];
  const snapOpts = snapList.map((s) => `${new Date(s.startTime).toLocaleString()} (${s.id.slice(0, 8)})`);
  const snapSection = store.snapshots.length
    ? `<div class="dd-row" style="gap:8px;align-items:center">
        ${kit.dropdown({ id: "viz-snap", options: snapOpts, placeholder: "Pick snapshot…" })}
        ${kit.button({ id: "btn-viz-snap", label: "Visualize", action: "viz:snap" })}
      </div>
      ${store.snapTree.length
        ? `<div class="dd-row" style="gap:12px;align-items:flex-start">
            <div>${sunburstSvg(store.snapTree)}</div>
            <div>${kit.dataTable({ id: "viz-table", cols: ["Name", "Size"], rows: store.snapTree.slice(0, 14).map((n) => [n.name, fmtBytes(n.size)]) })}</div>
          </div>`
        : `<div class="rd-empty">Pick a snapshot and visualize its contents.</div>`}`
    : `<div class="rd-empty">No snapshots yet — run a backup first.</div>`;
  return `<div class="rd-h">Files</div>
    ${kit.sectionLabel("Backup contents")}
    ${snapSection}
    ${kit.spacer(14)}
    ${kit.sectionLabel("Local disk")}
    <div class="dd-row" style="gap:8px;align-items:center">
      ${kit.textInput({ id: "disk-path", value: store.diskScanPath || "/home", width: 220 })}
      ${kit.button({ id: "btn-disk-scan", label: "Scan", action: "disk:scan" })}
      ${store.diskTree ? `<div class="dd-label">${fmtBytes(store.diskTree.total)}</div>` : ""}
    </div>
    ${store.diskTree ? `<div class="dd-row" style="gap:12px;align-items:flex-start"><div>${sunburstSvg(store.diskTree.roots)}</div>
      <div>${kit.dataTable({ id: "disk-table", cols: ["Path", "Size"], rows: store.diskTree.roots.slice(0, 14).map((n) => [n.name, fmtBytes(n.size)]) })}</div></div>` : `<div class="rd-empty">Scan a folder to see what's eating disk space (backup exclusions applied).</div>`}`;
}

function syncPage(): string {
  const rows = store.syncs.map((s) => [s.name, s.localPath, s.remote,
    s.direction === "twoway" ? "two-way" : (s.remoteIsSource ? "pull ←" : "push →"),
    s.enabled ? "enabled" : "disabled"]);
  return `<div class="rd-h">Sync Jobs</div>
    ${store.syncs.length
      ? kit.dataTable({ id: "sync-table", cols: ["Name", "Local", "Remote", "Mode", "State"], rows })
      : `<div class="rd-empty">No sync jobs configured — a sync keeps a folder and a remote in step rather than taking snapshots.</div>`}
    ${kit.spacer(8)}
    <div class="dd-row" style="gap:8px">
      ${kit.button({ id: "btn-new-sync", label: "New Sync…", kind: "accent", action: "sync:new" })}
      ${kit.button({ id: "btn-run-sync", label: "Run Selected", action: "sync:run", disabled: !store.syncs.length })}
      ${kit.button({ id: "btn-del-sync", label: "Delete Selected", action: "sync:delete", disabled: !store.syncs.length })}
    </div>`;
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
    case "files": return filesPage();
    case "sync": return syncPage();
    case "settings": return settingsPage();
  }
}

export function shellHtml(): string {
  return `<div class="rd-shell">
    ${sidebarHtml()}
    <div class="rd-main"><div class="dd-scroll rd-content" id="rd-page" data-kit="scroll" data-id="rd-page">${pageInnerHtml(store.page)}</div></div>
  </div>${modalHtml()}`;
}

function pwInput(id: string, label: string): string {
  return `<div class="dd-field"><div class="dd-lbl">${esc(label)}</div>` +
    `<input class="dd-input" id="${id}" data-kit="input" data-id="${id}" type="password" style="width:280px"></div>`;
}

function modalHtml(): string {
  const err = store.formError ? kit.fieldError(store.formError) : "";
  const foot = `<div class="dd-row" style="gap:8px;justify-content:flex-end;margin-top:12px">
    ${kit.button({ id: "modal-cancel", label: "Cancel", action: "modal:cancel" })}
    ${kit.button({ id: "modal-ok", label: store.busy ? "Working…" : "OK", kind: "accent", action: "modal:ok", disabled: store.busy })}
  </div>`;
  switch (store.modal) {
    case "new-repo": {
      const remoteNames = store.targets.filter((t) => t.kind === "rclone").map((t) => t.name);
      const prov = store.form["repo-prov"] ?? "filesystem";
      const locFields = prov === "filesystem"
        ? kit.textInput({ id: "repo-path", label: "Folder (local dir or USB path)", value: store.form["repo-path"] ?? "", width: 280 }) +
          `<div class="dd-row">${kit.button({ id: "repo-browse", label: "Browse…", action: "repo:browse" })}</div>`
        : `<div class="dd-field"><div class="dd-lbl">Remote</div>` +
          kit.dropdown({ id: "repo-remote", options: remoteNames, selected: Number(store.form["repo-remote-i"] ?? 0), placeholder: "pick remote" }) + `</div>` +
          kit.textInput({ id: "repo-rpath", label: "Path on remote", value: store.form["repo-rpath"] ?? "redoubt", width: 280 });
      return kit.modal({ id: "modal", title: "New Repository", open: true, html:
        kit.textInput({ id: "repo-name", label: "Name", value: store.form["repo-name"] ?? "" }) +
        `<div class="dd-field"><div class="dd-lbl">Location</div>` +
        kit.dropdown({ id: "repo-prov", options: ["filesystem", "rclone"], selected: prov === "rclone" ? 1 : 0 }) + `</div>` +
        locFields +
        pwInput("repo-pw", "Encryption passphrase") +
        pwInput("repo-pw2", "Confirm passphrase") + err + foot });
    }
    case "new-remote": {
      const types = store.remoteTypes;
      const tIdx = Number(store.form["remote-type-i"] ?? 0);
      const sel = types[tIdx];
      const fields = sel ? sel.params.map((p) =>
        p.secret
          ? pwInput(`rp-${p.key}`, p.label)
          : kit.textInput({ id: `rp-${p.key}`, label: p.label, value: store.form[`rp-${p.key}`] ?? "", width: 280 })
      ).join("") : "";
      const oauthBlock = sel?.oauth
        ? `<div class="dd-row" style="gap:8px;align-items:center">
            ${kit.button({ id: "btn-authorize", label: store.authState?.state === "waiting" ? "Waiting for browser auth…" : "Authorize in browser", action: "target:authorize", disabled: store.authState?.state === "waiting" })}
            ${store.authState?.state === "done" ? kit.badge({ label: "authorized", kind: "good" }) : ""}
          </div>
          <div class="dd-label" style="font-size:10px">rclone opens your browser; complete the sign-in, then finish below.</div>`
        : "";
      return kit.modal({ id: "modal", title: "Add Remote", open: true, html:
        kit.textInput({ id: "remote-name", label: "Name", value: store.form["remote-name"] ?? "" }) +
        `<div class="dd-field"><div class="dd-lbl">Type</div>` +
        kit.dropdown({ id: "remote-type", options: types.map((t) => t.label), selected: tIdx }) + `</div>` +
        fields + oauthBlock + err + foot });
    }
    case "new-plan":
      return kit.modal({ id: "modal", title: "New Backup Plan", open: true, html:
        kit.textInput({ id: "plan-name", label: "Name", value: store.form["plan-name"] ?? "" }) +
        kit.textInput({ id: "plan-src", label: "Source folder", value: store.form["plan-src"] ?? "", width: 280 }) +
        `<div class="dd-row">${kit.button({ id: "src-browse", label: "Browse…", action: "src:browse" })}</div>` +
        `<div class="dd-field"><div class="dd-lbl">Repository</div>` +
        kit.dropdown({ id: "plan-repo", options: store.repositories.map((r) => r.name), selected: Number(store.form["plan-repo-i"] ?? 0) }) + `</div>` +
        `<div class="dd-field"><div class="dd-lbl">Schedule</div>` +
        kit.dropdown({ id: "plan-sched", options: ["manual", "hourly", "daily", "every N minutes"], selected: Number(store.form["plan-sched-i"] ?? 0) }) + `</div>` +
        kit.numberField({ id: "plan-sched-min", label: "Run every N minutes (when 'every N' selected)", value: store.form["plan-sched-min"] ?? "60", min: 5, max: 10080 }) +
        kit.numberField({ id: "plan-min", label: "Keep at least N snapshots", value: store.form["plan-min"] ?? "3", min: 1, max: 100 }) +
        kit.numberField({ id: "plan-maxage", label: "Delete snapshots older than (days, 0 = keep)", value: store.form["plan-maxage"] ?? "0", min: 0, max: 36500 }) + err + foot });
    case "restore": {
      const snapId = store.modalPayload.snapshotId ?? "";
      return kit.modal({ id: "modal", title: "Restore Snapshot", open: true, html:
        kit.kvTable([["Snapshot", snapId.slice(0, 12)], ["Source", store.modalPayload.source ?? ""]]) +
        kit.textInput({ id: "restore-dir", label: "Restore into folder", value: store.form["restore-dir"] ?? "", width: 280 }) +
        `<div class="dd-row">${kit.button({ id: "restore-browse", label: "Browse…", action: "restore:browse" })}</div>` + err + foot });
    }
    case "unlock-repo":
      return kit.modal({ id: "modal", title: `Unlock “${store.modalPayload.name ?? ""}”`, open: true, html:
        pwInput("unlock-pw", "Passphrase") + err + foot });
    case "new-sync": {
      const remoteNames = store.targets.filter((t) => t.kind === "rclone").map((t) => t.name);
      const dir = store.form["sync-dir"] ?? "oneway";
      return kit.modal({ id: "modal", title: "New Sync", open: true, html:
        kit.textInput({ id: "sync-name", label: "Name", value: store.form["sync-name"] ?? "" }) +
        kit.textInput({ id: "sync-local", label: "Local folder", value: store.form["sync-local"] ?? "", width: 280 }) +
        `<div class="dd-row">${kit.button({ id: "sync-browse", label: "Browse…", action: "sync:browse" })}</div>` +
        `<div class="dd-field"><div class="dd-lbl">Remote</div>` +
        kit.dropdown({ id: "sync-remote", options: remoteNames, selected: Number(store.form["sync-remote-i"] ?? 0), placeholder: "pick remote" }) + `</div>` +
        kit.textInput({ id: "sync-rpath", label: "Path on remote", value: store.form["sync-rpath"] ?? "sync", width: 280 }) +
        `<div class="dd-field"><div class="dd-lbl">Mode</div>` +
        kit.dropdown({ id: "sync-dir", options: ["one-way (mirror)", "two-way (bisync)"], selected: dir === "twoway" ? 1 : 0 }) + `</div>` +
        (dir !== "twoway"
          ? `<div class="dd-field"><div class="dd-lbl">Direction</div>` +
            kit.dropdown({ id: "sync-to", options: ["local → remote (push)", "remote → local (pull)"], selected: Number(store.form["sync-to-i"] ?? 0) }) + `</div>`
          : "") + err + foot });
    }
    case "recovery": {
      const key = store.form["recovery-key"];
      return kit.modal({ id: "modal", title: "Recovery Key", open: true, html:
        key
          ? `<div class="dd-field"><div class="dd-lbl">Save this recovery key — it is shown ONCE.</div>
             <div class="dd-label" style="font-size:11px">A hybrid X25519 + ML-KEM-768 recipient slot was added to the keybox. Anyone with this key can unlock the repository without the passphrase.</div>
             <pre class="dd-input" style="white-space:pre-wrap;word-break:break-all;user-select:all;max-height:140px;overflow:auto">${esc(key)}</pre></div>` + err + foot
          : `<div class="dd-field"><div class="dd-lbl">Repository</div>` +
            kit.dropdown({ id: "rec-repo", options: store.repositories.map((r) => r.name), selected: Number(store.form["rec-repo-i"] ?? 0) }) + `</div>` +
            kit.textInput({ id: "rec-label", label: "Label (e.g. 'safety deposit')", value: store.form["rec-label"] ?? "recovery" }) +
            `<div class="dd-label" style="font-size:11px">Generates a post-quantum recovery slot and shows the key once.</div>` + err + foot });
    }
    case "browse": {
      const crumbs = store.browseStack.map((b) => b.name).join(" / ") || "/";
      const rows = store.browseItems.map((e) => [
        e.isDir ? `${e.name}/` : e.name,
        fmtBytes(e.size),
        e.isDir ? "dir" : "file",
      ]);
      return kit.modal({ id: "modal", title: `Browse — ${crumbs}`, open: true, html:
        `<div class="dd-row" style="gap:8px;margin-bottom:8px">
          ${kit.button({ id: "browse-up", label: "↑ Up", action: "browse:up", disabled: !store.browseStack.length })}
          ${kit.button({ id: "browse-enter", label: "Open dir", action: "browse:enter" })}
          ${kit.button({ id: "browse-restore", label: "Restore selected…", action: "browse:restore" })}
        </div>` +
        (rows.length
          ? kit.dataTable({ id: "browse-table", cols: ["Name", "Size", "Type"], rows })
          : `<div class="rd-empty">${store.busy ? "loading…" : "empty"}</div>`) + err + foot });
    }
    default:
      return "";
  }
}
