// ============================================================================
// app.js — DownDraft web devtools shell.
//
// Connects to the in-process DevToolsServer over WS (token in ?t=), renders
// the tab bar, and routes server push events to panels. Panels register via
// registerPanel(id, title, factory). Provider-driven panels (sim, memory,
// render-graph, …) are added dynamically from the hello handshake.
// ============================================================================

import { initConsolePanel } from "/panels/console.js";
import { initGpuPanel } from "/panels/gpu.js";
import { initMetricsPanel } from "/panels/metrics.js";
import { initSnapshotPanel } from "/panels/snapshot.js";
import { initTreePanel } from "/panels/tree.js";

const params = new URLSearchParams(location.search);
const token = params.get("t") ?? "";

// ── WS client ──

let ws = null;
let nextId = 1;
const pending = new Map();
const listeners = new Map(); // event → Set<fn>
let hello = { panels: [], inspector: [] };

export function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
function emitLocal(event, data) {
  listeners.get(event)?.forEach((fn) => { try { fn(data); } catch (e) { setStatus(`panel error: ${e?.message ?? e}`); } });
}

function setConn(state) {
  const el = document.getElementById("conn");
  el.className = state;
  el.textContent = state;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?t=${encodeURIComponent(token)}`);
  ws.onopen = () => setConn("connected");
  ws.onclose = () => {
    setConn("disconnected");
    pending.forEach((p) => p.reject(new Error("closed")));
    pending.clear();
    setTimeout(connect, 1500); // auto-reconnect (server survives)
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.event === "hello") {
      hello = msg.data ?? hello;
      rebuildTabs();
      return;
    }
    if (msg.event === "devtools.close") { try { window.close(); } catch { /* noop */ } return; }
    if (msg.event === "devtools.focus") {
      // F12 pressed while already connected — flash the title so the
      // keystroke is visibly acknowledged.
      const t = document.title;
      document.title = `● ${t}`;
      setTimeout(() => { document.title = t; }, 600);
      return;
    }
    emitLocal(msg.event, msg.data);
  };
}

// ── __sceneInspector shim (extension API over the wire) ──
// Methods return Promises — panel code should `await` results.
window.__sceneInspector = new Proxy({}, {
  get: (_t, name) => (...args) => call("inspector.call", { method: name, args }),
});

// ── Tab shell ──

const FIXED = [
  ["console", "Console", (el) => initConsolePanel(el)],
  ["scene", "Scene", (el) => initTreePanel(el, "sceneTree", "scene")],
  ["dom", "DOM / ECS", (el) => initTreePanel(el, "domTree", "dom", true)],
  ["gpu", "GPU", (el) => initGpuPanel(el)],
  ["perf", "Performance", (el) => initMetricsPanel(el)],
];

const panels = new Map(); // id → {title, mount}
let activePanel = null;

function rebuildTabs() {
  // Fixed panels + one tab per provider slot reported by hello.
  panels.clear();
  FIXED.forEach(([id, title, mount]) => panels.set(id, { title, mount }));
  (hello.panels ?? []).forEach((p) => {
    const id = `snap-${p.name}`;
    if (!panels.has(id) && !FIXED.some(([fid]) => fid === p.name)) {
      panels.set(id, { title: titleize(p.name), mount: (el) => initSnapshotPanel(el, p.name, p.slot) });
    }
  });
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  panels.forEach((p, id) => {
    const b = document.createElement("button");
    b.textContent = p.title;
    b.dataset.panel = id;
    if (id === activePanel) b.classList.add("active");
    b.onclick = () => activate(id);
    bar.appendChild(b);
  });
  if (!activePanel) activate("console");
  else activate(activePanel);
}

function activate(id) {
  activePanel = id;
  document.querySelectorAll("#tabbar button").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === id);
  });
  const host = document.getElementById("panel");
  host.innerHTML = "";
  const sec = document.createElement("section");
  host.appendChild(sec);
  const p = panels.get(id);
  if (p) {
    try { p.mount(sec); } catch (e) {
      sec.innerHTML = `<div class="status-banner error">panel error: ${e.message ?? e}</div>`;
    }
  }
}

function titleize(s) {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// status helpers used by panels
export function setStatus(text) { document.getElementById("status-text").textContent = text; }
export function setStatusRight(text) { document.getElementById("status-right").textContent = text; }

connect();
rebuildTabs();
