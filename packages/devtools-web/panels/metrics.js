// Performance panel: per-thread CPU/heap/GC/latency table + heap chart.
import { on } from "/app.js";

const history = new Map(); // slotIndex → {cpu:[], heap:[]}
const HIST = 240;

export function initMetricsPanel(root) {
  root.innerHTML = `
    <canvas class="chart" height="90"></canvas>
    <div class="snap-section"><h3>Heap per slot (MB)</h3></div>
    <div class="tbl"></div>`;

  const tbl = root.querySelector(".tbl");
  const canvas = root.querySelector("canvas.chart");
  const ctx2d = canvas.getContext("2d");

  const render = (slots) => {
    (slots ?? []).forEach((s) => {
      const h = s.history?.[0];
      if (!h) return;
      let rec = history.get(s.slotIndex);
      if (!rec) { rec = { cpu: [], heap: [] }; history.set(s.slotIndex, rec); }
      rec.cpu.push(h.cpuPercent); rec.heap.push(h.heapUsed / 1048576);
      if (rec.cpu.length > HIST) { rec.cpu.shift(); rec.heap.shift(); }
    });

    let html = `<table class="dt"><tr>
      <th>slot</th><th>name</th><th>cpu%</th><th>heap</th>
      <th>gc max µs</th><th>task p95 µs</th></tr>`;
    (slots ?? []).forEach((s) => {
      const h = s.history?.[0] ?? {};
      html += `<tr><td>${s.slotIndex}</td><td>${escapeHtml(s.name)}</td>
        <td>${(h.cpuPercent ?? 0).toFixed(1)}</td>
        <td>${fmtBytes(h.heapUsed)} / ${fmtBytes(h.heapTotal)}</td>
        <td>${(h.gcPauseMaxUs ?? 0).toFixed(0)}</td>
        <td>${(h.taskLatencyP95Us ?? 0).toFixed(0)}</td></tr>`;
    });
    tbl.innerHTML = html + "</table>";
    drawChart();
  };

  function drawChart() {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = 90 * devicePixelRatio;
    ctx2d.clearRect(0, 0, w, h);
    const colors = ["#4da3ff", "#57ab5a", "#e0b341", "#e5534b", "#bc8cff", "#39c5cf"];
    const max = Math.max(64, ...[...history.values()].flatMap((r) => r.heap));
    [...history.values()].forEach((rec, i) => {
      ctx2d.strokeStyle = colors[i % colors.length];
      ctx2d.lineWidth = devicePixelRatio;
      ctx2d.beginPath();
      rec.heap.forEach((v, j) => {
        const x = (j / HIST) * w;
        const y = h - (v / max) * (h - 4);
        if (j === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      });
      ctx2d.stroke();
    });
  }

  const off = on("metrics", render);
  return () => off();
}

function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
