// ============================================================================
// markup.ts — html-ui document markup for the shell chrome.
// ============================================================================

import type { AppState, DockState, TargetInfo } from "../app/store";
import { panelTitle } from "./drawer";
import { mainTabsFor } from "../app/store";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sidebarMarkup(s: AppState): string {
  const targets = s.targets.map((t) => {
    const badges = (["mirror", "cdp", "mcp", "procfs"] as const).map((c) =>
      `<span class="badge${t.channels[c] ? " on" : ""}">${c}</span>`).join("");
    const statusBadge = t.status === "attached" ? `<span class="badge on">attached</span>`
      : t.status === "connecting" ? `<span class="badge warn">connecting</span>`
      : t.status === "degraded" ? `<span class="badge warn">degraded</span>`
      : `<span class="badge">lost</span>`;
    const threads = t.threads.length > 1 ? ` · ${t.threads.length} threads` : "";
    const panels = t.panels.length ? ` · ${t.panels.length} panels` : "";
    const pid = t.id.replace(/^pid-/, "");
    const ctl = t.status === "lost"
      ? `<span class="badge tctl" data-action="attach-target" data-pid="${esc(pid)}" title="reattach">↻ reattach</span>`
      : `<span class="badge tctl" data-action="detach-target" data-pid="${esc(pid)}" title="detach">⏏</span>`;
    const detail = t.detail ? ` · ${esc(t.detail)}` : "";
    return `<div class="target${t.id === s.activeTargetId ? " active" : ""}${t.status === "lost" ? " lost" : ""}" data-action="select-target" data-id="${esc(t.id)}">
      <div class="tname">${esc(t.name)}</div>
      <div class="tsub">${esc(t.kind)} · pid ${t.pid}${threads}${panels}${detail}</div>
      <div class="tbadges">${statusBadge}${badges}${ctl}</div>
    </div>`;
  }).join("");
  return `<div class="pt-col" style="height:100%">
    <div class="pt-title">Targets</div>
    <div class="scroll" style="flex:1">${targets || `<div class="empty">No targets discovered.<br/>Launch a downdraft app with devtools.ui:"web",<br/>or attach manually.</div>`}</div>
    <div style="padding:8px;border-top:1px solid #262b31">
      ${s.attachOpen
        ? `<div class="attach-hint">pid, ws://… or host:port</div>
           <input id="attach-input" class="attach-in" placeholder="pid or ws://…" value=""/>
           <div style="display:flex;gap:6px;margin-top:6px">
             <div class="dbtn" data-action="attach-do" style="flex:1">attach</div>
             <div class="dbtn" data-action="attach-cancel">×</div>
           </div>`
        : `<div class="dbtn" data-action="attach-manual">+ attach…</div>`}
    </div>
  </div>`;
}

export function tabstripMarkup(s: AppState): string {
  const active: TargetInfo | undefined = s.targets.find((t) => t.id === s.activeTargetId) ?? s.targets[0];
  const dyn = active?.panels ?? [];
  const mainTabs = mainTabsFor(active).map((id) =>
    `<div class="tab${s.mainTab === id ? " on" : ""}" data-action="main-tab" data-tab="${id}">${esc(panelTitle(id))}</div>`).join("");
  const dynTabs = dyn.filter((p) => !HIDDEN_PROVIDER_TABS.has(p.name)).map((p) => {
    const id = `panel:${p.slot}`;
    return `<div class="tab${s.mainTab === id ? " on" : ""}" data-action="main-tab" data-tab="${id}">${esc(p.name)}</div>`;
  }).join("");
  return `<div class="tabs">${mainTabs}${dynTabs}<span class="tabspacer"></span>
    <div class="chip${s.docks.right.collapsed ? "" : " on"}" data-action="dock-right" title="toggle right dock">▣</div>
    <div class="chip${s.docks.bottom.collapsed ? "" : " on"}" data-action="dock-bottom" title="toggle drawer">▤</div>
  </div>`;
}

export function dockStripMarkup(dock: DockState, which: "bottom" | "right", s: AppState): string {
  const tabs = dock.tabs.map((id) =>
    `<div class="tab${dock.active === id ? " on" : ""}" data-action="dock-tab-${which}" data-tab="${esc(id)}">${esc(dockTitle(id, s))}
      <span class="x" data-action="dock-close-${which}" data-tab="${esc(id)}">×</span>
    </div>`).join("");
  return `<div class="tabs" style="height:26px">${tabs}<span class="tabspacer"></span>
    <div class="chip" data-action="dock-collapse-${which}">${dock.collapsed ? "▴" : "▾"}</div>
  </div>`;
}

export function statusbarMarkup(s: AppState): string {
  const t = s.targets.find((x) => x.id === s.activeTargetId);
  const caps = t ? t.caps.slice(0, 6).join(" · ") : "no target";
  const chans = t ? (["mirror", "cdp", "mcp", "procfs"] as const).filter((c) => t.channels[c]).join(" ") : "";
  return `<div class="statusbar">
    <span>${t ? esc(t.name) : "platinum-devtools"}</span>
    <span>${esc(chans)}</span>
    <span style="flex:1"></span>
    <span>${esc(caps)}</span>
    <span>${s.targets.length} target(s)</span>
  </div>`;
}

/** Provider panels rolled up into bespoke tabs (world, gpu, profiler>mem)
 *  — they don't get their own top-level tabs. */
export const HIDDEN_PROVIDER_TABS = new Set(["sim", "scene", "memory", "assets", "gpu", "target-state"]);

/** Dock tab label — resolves provider-N/panel:N ids to live provider names. */
function dockTitle(id: string, s: AppState): string {
  const m = /^(?:panel|provider)[-:](\d+)$/.exec(id);
  if (m) {
    const slot = Number(m[1]);
    const name = s.targets.flatMap((t) => t.panels).find((p) => p.slot === slot)?.name;
    if (name) return name;
  }
  return panelTitle(id);
}
