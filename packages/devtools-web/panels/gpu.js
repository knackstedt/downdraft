// GPU panel: adapter/limits/telemetry/resources kv + frame-time chart.
import { call, on } from "/app.js";

export function initGpuPanel(root) {
  root.innerHTML = `
    <div class="panel-toolbar">
      <button data-act="refresh">Refresh</button>
      <button data-act="record">Record CPU profile</button>
    </div>
    <canvas class="chart" height="90"></canvas>
    <div class="snap-section"><h3>Frame times (ms)</h3></div>
    <div class="gpu-kv"></div>`;

  const kvEl = root.querySelector(".gpu-kv");
  const canvas = root.querySelector("canvas.chart");
  const ctx2d = canvas.getContext("2d");
  let recording = false;

  const render = (info) => {
    kvEl.innerHTML = "";
    let curSection = null;
    (info?.entries ?? []).forEach((e) => {
      if (e.isHeader) {
        curSection = document.createElement("div");
        curSection.className = "snap-section";
        curSection.innerHTML = `<h3>${escapeHtml(e.key)}</h3><div class="kv"></div>`;
        kvEl.appendChild(curSection);
        return;
      }
      if (!curSection) {
        curSection = document.createElement("div");
        curSection.className = "snap-section";
        curSection.innerHTML = `<div class="kv"></div>`;
        kvEl.appendChild(curSection);
      }
      const kv = curSection.querySelector(".kv");
      const k = document.createElement("div"); k.className = "k"; k.textContent = e.key;
      const v = document.createElement("div"); v.textContent = e.value;
      kv.appendChild(k); kv.appendChild(v);
    });
    drawChart(info?.frameTimes ?? []);
  };

  function drawChart(times) {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = 90 * devicePixelRatio;
    ctx2d.clearRect(0, 0, w, h);
    if (!times.length) return;
    const max = Math.max(16.7, ...times.map((t) => t[0]));
    ctx2d.strokeStyle = "#4da3ff";
    ctx2d.lineWidth = devicePixelRatio;
    ctx2d.beginPath();
    times.forEach((t, i) => {
      const x = (i / Math.max(1, times.length - 1)) * w;
      const y = h - (t[0] / max) * (h - 4);
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    });
    ctx2d.stroke();
    // 16.7ms line
    const fy = h - (16.7 / max) * (h - 4);
    ctx2d.strokeStyle = "#e0b34166";
    ctx2d.beginPath(); ctx2d.moveTo(0, fy); ctx2d.lineTo(w, fy); ctx2d.stroke();
  }

  const off = on("gpu", render);
  root.querySelector('[data-act="refresh"]').onclick = async () => {
    try { render(await call("gpuInfo")); } catch { /* keep last */ }
  };
  root.querySelector('[data-act="record"]').onclick = async (ev) => {
    const btn = ev.target;
    try {
      if (!recording) {
        recording = true; btn.textContent = "Stop profile";
        await call("profile.start");
      } else {
        recording = false; btn.textContent = "Record CPU profile";
        await call("profile.stop");
      }
    } catch (e) { btn.textContent = `error: ${e.message ?? e}`; }
  };
  on("profile", (p) => {
    const sec = document.createElement("div");
    sec.className = "snap-section";
    const top = [...(p?.nodes ?? [])].sort((a, b) => b.hitCount - a.hitCount).slice(0, 40);
    const total = Math.max(1, top.reduce((s, n) => s + n.hitCount, 0));
    sec.innerHTML = `<h3>CPU Profile — ${p?.nodes?.length ?? 0} nodes</h3>` +
      `<div class="lines">` + top.map((n) =>
        `${String((100 * n.hitCount / total).toFixed(1)).padStart(5)}%  ${escapeHtml(n.callFrame)}  ${escapeHtml(n.url)}:${n.line}`
      ).join("\n") + `</div>`;
    kvEl.prepend(sec);
  });
  call("gpuInfo").then(render).catch(() => {});
  return () => off();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
