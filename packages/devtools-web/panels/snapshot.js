// Generic PanelSnapshot renderer — covers every provider-registered panel
// (sim, memory, render-graph, materials, doctor, workers, input, postfx,
// assets, game, …). Sections: kv, table, series, lines, controls.
import { call, on, setStatus } from "/app.js";

export function initSnapshotPanel(root, panelName, slot) {
  root.innerHTML = `
    <div class="panel-toolbar">
      <button data-act="refresh">Refresh</button>
      <span class="spacer"></span><span class="updated"></span>
    </div>
    <div class="snap-body"></div>`;

  const body = root.querySelector(".snap-body");
  const updated = root.querySelector(".updated");

  const render = (snap) => {
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
    body.innerHTML = "";
    if (!snap) { body.innerHTML = `<div class="empty-note">no data</div>`; return; }
    if (snap.status && snap.status !== "ok") {
      const cls = snap.status === "error" ? "status-banner error" : "status-banner";
      body.innerHTML = `<div class="${cls}">${escapeHtml(snap.statusMsg ?? snap.status)}</div>`;
    }
    (snap.sections ?? []).forEach((s) => body.appendChild(renderSection(s, slot)));
  };

  root.querySelector('[data-act="refresh"]').onclick = async () => {
    try { render(await call("snapshot", { panel: slot })); }
    catch (e) { body.innerHTML = `<div class="status-banner error">${e}</div>`; }
  };

  const off = on("snapshot", (d) => { if (d?.slot === slot) render(d.snap); });

  // initial fetch (don't wait for the pushed snapshot)
  call("snapshot", { panel: slot }).then(render).catch(() => {});
  return () => off();
}

function renderSection(s, slot) {
  const sec = document.createElement("div");
  sec.className = "snap-section";
  if (s.name) {
    const h = document.createElement("h3");
    h.textContent = s.name;
    sec.appendChild(h);
  }
  switch (s.kind) {
    case "kv": {
      const kv = document.createElement("div");
      kv.className = "kv";
      (s.rows ?? []).forEach((r) => {
        if (r.flags & 1) { // header
          const h = document.createElement("div");
          h.className = "hdr"; h.textContent = r.key;
          kv.appendChild(h);
          return;
        }
        const k = document.createElement("div"); k.className = "k"; k.textContent = r.key;
        const v = document.createElement("div");
        v.textContent = r.value;
        if (r.flags & 2) v.className = "fl-warn";
        if (r.flags & 4) v.className = "fl-err";
        kv.appendChild(k); kv.appendChild(v);
      });
      sec.appendChild(kv);
      break;
    }
    case "table": {
      const t = document.createElement("table");
      t.className = "dt";
      const tr = document.createElement("tr");
      (s.cols ?? []).forEach((c) => {
        const th = document.createElement("th"); th.textContent = c; tr.appendChild(th);
      });
      t.appendChild(tr);
      (s.rows ?? []).forEach((row) => {
        const tr2 = document.createElement("tr");
        row.forEach((cell) => {
          const td = document.createElement("td"); td.textContent = cell; tr2.appendChild(td);
        });
        t.appendChild(tr2);
      });
      sec.appendChild(t);
      break;
    }
    case "series": {
      const c = document.createElement("canvas");
      c.className = "chart"; c.height = 90;
      sec.appendChild(c);
      requestAnimationFrame(() => drawSeries(c, s.series ?? []));
      break;
    }
    case "lines": {
      const d = document.createElement("div");
      d.className = "lines";
      (s.lines ?? []).forEach((l) => {
        const line = document.createElement("div");
        line.textContent = l.text;
        if (l.flags & 2) line.className = "fl-warn";
        if (l.flags & 4) line.className = "fl-err";
        d.appendChild(line);
      });
      sec.appendChild(d);
      break;
    }
    case "controls": {
      const c = document.createElement("div");
      c.className = "controls";
      (s.controls ?? []).forEach((ctl) => c.appendChild(renderControl(ctl, slot)));
      sec.appendChild(c);
      break;
    }
    default:
      sec.innerHTML = `<div class="empty-note">unknown section ${escapeHtml(s.kind)}</div>`;
  }
  return sec;
}

function renderControl(ctl, slot) {
  const send = (payload) =>
    call("command", { panel: slot, action: ctl.id, payload: payload ?? "" })
      .catch((e) => setStatus(`command failed: ${e.message ?? e}`));

  if (ctl.type === "button") {
    const b = document.createElement("button");
    b.textContent = ctl.label;
    b.onclick = () => send(ctl.payload);
    return b;
  }
  const label = document.createElement("label");
  if (ctl.type === "checkbox") {
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!ctl.checked;
    cb.onchange = () => send(cb.checked ? "1" : "0");
    label.appendChild(cb);
    label.appendChild(document.createTextNode(ctl.label));
    return label;
  }
  if (ctl.type === "slider") {
    const r = document.createElement("input");
    r.type = "range"; r.min = ctl.min; r.max = ctl.max; r.value = ctl.value;
    r.step = (ctl.max - ctl.min) / 100 || 1;
    const val = document.createElement("span");
    val.className = "val"; val.textContent = Number(ctl.value).toFixed(2);
    r.oninput = () => { val.textContent = Number(r.value).toFixed(2); };
    r.onchange = () => send(r.value);
    label.appendChild(document.createTextNode(ctl.label));
    label.appendChild(r);
    label.appendChild(val);
    return label;
  }
  return document.createTextNode(ctl.label ?? ctl.id);
}

const CHART_COLORS = ["#4da3ff", "#57ab5a", "#e0b341", "#e5534b", "#bc8cff", "#39c5cf"];

function drawSeries(canvas, series) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 90 * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  const all = series.flatMap((s) => [...(s.values ?? [])].map(Number));
  if (!all.length) return;
  const max = Math.max(...all, 1e-9);
  const min = Math.min(...all, 0);
  const span = Math.max(1e-9, max - min);
  series.forEach((s, i) => {
    const vals = [...(s.values ?? [])].map(Number);
    ctx.strokeStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.lineWidth = devicePixelRatio;
    ctx.beginPath();
    vals.forEach((v, j) => {
      const x = (j / Math.max(1, vals.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4);
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
