// ============================================================================
// DevTools Panel — GPU Debugging
// Standalone panel for GPU profiling, resource tracking, and diagnostics
// ============================================================================

(function () {
  "use strict";

  // --- Eval helpers ---

  function evalInPage(code, callback) {
    chrome.devtools.inspectedWindow.eval(code, function (result, isException) {
      if (isException) {
        console.error("[GPU] Eval error:", result);
        callback(null, result);
      } else {
        callback(result, null);
      }
    });
  }

  function callInspector(method, args) {
    var code = "(function(){ var r = window.__sceneInspector && window.__sceneInspector." + method + "(";
    if (args !== undefined && args !== null) {
      if (Array.isArray(args)) {
        code += args.map(function (a) { return JSON.stringify(a); }).join(",");
      } else {
        code += JSON.stringify(args);
      }
    }
    code += "); return r === undefined ? null : (typeof r === 'object' ? JSON.stringify(r) : r); })()";
    return new Promise(function (resolve) {
      evalInPage(code, function (result, err) {
        if (err || result === null || result === undefined) {
          resolve({ result: null, err: err });
          return;
        }
        if (typeof result === "string") {
          try { result = JSON.parse(result); } catch (e) { /* leave as string */ }
        }
        resolve({ result: result, err: err });
      });
    });
  }

  // --- Utils ---

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function fmtVal(v, decimals) {
    if (typeof v === "number") {
      return v.toFixed(decimals || 2);
    }
    return String(v);
  }

  function debugGridHtml(rows) {
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="debug-row">';
      html += '<div class="debug-label">' + escapeHtml(rows[i][0]) + '</div>';
      html += '<div class="debug-value">' + escapeHtml(rows[i][1]) + '</div>';
      html += '</div>';
    }
    return html;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  function formatUsageFlags(usage) {
    if (usage === undefined || usage === null) return "";
    var flags = [];
    if (usage & 0x01) flags.push("MAP_READ");
    if (usage & 0x02) flags.push("MAP_WRITE");
    if (usage & 0x04) flags.push("COPY_SRC");
    if (usage & 0x08) flags.push("COPY_DST");
    if (usage & 0x10) flags.push("INDEX");
    if (usage & 0x20) flags.push("VERTEX");
    if (usage & 0x40) flags.push("UNIFORM");
    if (usage & 0x80) flags.push("STORAGE");
    if (usage & 0x100) flags.push("INDIRECT");
    if (usage & 0x200) flags.push("QUERY_RESOLVE");
    return flags.join("|");
  }

  // --- State ---

  var gpuStatusEl = document.getElementById("gpu-status");
  var gpuTimer = null;
  var gpuErrorCount = -1;
  var perfGraphHistory = [];
  var PERF_GRAPH_MAX = 120;

  // --- GPU Info ---

  function refreshGPUInfo() {
    callInspector("getGPUInfo").then(function (res) {
      if (res.err || !res.result) {
        gpuStatusEl.textContent = "Not available — is the renderer initialized?";
        return;
      }
      var info = res.result;
      var a = info.adapter || {};
      gpuStatusEl.textContent =
        (a.vendor || "Unknown") + " " + (a.architecture || "") + " — " +
        (info.deviceLost ? "DEVICE LOST" : "OK");

      var adapterRows = [
        ["Vendor", a.vendor || "—"],
        ["Architecture", a.architecture || "—"],
        ["Device", a.device || "—"],
        ["Description", a.description || "—"],
        ["Canvas Format", info.canvasFormat || "—"],
        ["MSAA Samples", String(info.msaaSampleCount || 1)],
        ["Canvas Size", (info.canvasSize ? info.canvasSize.width + "x" + info.canvasSize.height : "—")],
        ["Device Lost", info.deviceLost ? "YES" : "No"],
      ];
      var adapterEl = document.getElementById("gpu-adapter-info");
      if (adapterEl) adapterEl.innerHTML = debugGridHtml(adapterRows);

      var limitsEl = document.getElementById("gpu-device-limits");
      if (limitsEl && info.deviceLimits) {
        var L = info.deviceLimits;
        var limitRows = [
          ["Max Texture D2", L.maxTextureDimension2D || "—"],
          ["Max Texture D3", L.maxTextureDimension3D || "—"],
          ["Max Buffer Size", formatBytes(L.maxBufferSize || 0)],
          ["Max Bind Groups", String(L.maxBindGroups || "—")],
          ["Max Bind Group Buffers", String(L.maxStorageBuffersPerShaderStage || "—")],
          ["Max Storage Buffers", String(L.maxStorageBuffersPerShaderStage || "—")],
          ["Max Samplers", String(L.maxSamplersPerShaderStage || "—")],
          ["Max Sampled Textures", String(L.maxSampledTexturesPerShaderStage || "—")],
          ["Max Storage Textures", String(L.maxStorageTexturesPerShaderStage || "—")],
          ["Max Uniform Buffer Bnd", String(L.maxUniformBuffersPerShaderStage || "—")],
          ["Max Uniform Buffer Size", formatBytes(L.maxUniformBufferBindingSize || 0)],
          ["Max Storage Buffer Bnd Size", formatBytes(L.maxStorageBufferBindingSize || 0)],
          ["Max Vertex Buffers", String(L.maxVertexBuffers || "—")],
          ["Max Vertex Attributes", String(L.maxVertexAttributes || "—")],
          ["Max Color Attachments", String(L.maxColorAttachments || "—")],
          ["Min Subgroup Size", String(L.minSubgroupSize || "—")],
          ["Max Subgroup Size", String(L.maxSubgroupSize || "—")],
        ];
        limitsEl.innerHTML = debugGridHtml(limitRows);
      }
    });
  }

  // --- GPU Errors ---

  function refreshGPUErrors() {
    callInspector("getGPUErrors").then(function (res) {
      if (res.err || !res.result) return;
      var errors = res.result;
      if (errors.length === gpuErrorCount) return;
      gpuErrorCount = errors.length;
      var logEl = document.getElementById("gpu-error-log");
      if (!logEl) return;
      if (errors.length === 0) {
        logEl.innerHTML = '<div class="gpu-error-empty">No GPU errors recorded</div>';
        return;
      }
      var html = "";
      for (var i = errors.length - 1; i >= 0; i--) {
        var e = errors[i];
        var t = new Date(e.timestamp);
        var ts = (t.getHours() < 10 ? "0" : "") + t.getHours() + ":" +
                 (t.getMinutes() < 10 ? "0" : "") + t.getMinutes() + ":" +
                 (t.getSeconds() < 10 ? "0" : "") + t.getSeconds() + "." +
                 Math.floor(t.getMilliseconds() / 100);
        html += '<div class="gpu-error-entry">';
        html += '<span class="gpu-error-time">' + ts + '</span>';
        if (e.label) html += '<span class="gpu-error-label">[' + escapeHtml(e.label) + ']</span>';
        html += '<span class="gpu-error-msg">' + escapeHtml(e.message) + '</span>';
        html += '</div>';
      }
      logEl.innerHTML = html;
    });
  }

  // --- Frame Telemetry ---

  function refreshFrameTelemetry() {
    callInspector("getFrameTelemetry").then(function (res) {
      if (res.err || !res.result) return;
      var t = res.result;
      var statsEl = document.getElementById("gpu-frame-stats");
      if (statsEl) {
        statsEl.innerHTML = debugGridHtml([
          ["FPS", fmtVal(t.fps, 0)],
          ["Avg Frame Time", fmtVal(t.avgFrameTime, 2) + " ms"],
          ["P95 Frame Time", fmtVal(t.p95, 2) + " ms"],
          ["P99 Frame Time", fmtVal(t.p99, 2) + " ms"],
          ["Draw Calls", String(t.drawCalls)],
          ["Triangles", String(t.triangles)],
          ["GPU Time", t.gpuTimeMs > 0 ? fmtVal(t.gpuTimeMs, 2) + " ms" : "—"],
        ]);
      }
      drawFrameTimeChart(t.frameTimes || []);
    });
  }

  function drawFrameTimeChart(frameTimes) {
    var canvas = document.getElementById("gpu-frame-chart");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);

    var maxMs = 50;
    for (var i = 0; i < frameTimes.length; i++) {
      if (frameTimes[i] > maxMs) maxMs = frameTimes[i];
    }
    maxMs = Math.ceil(maxMs / 10) * 10;

    ctx.strokeStyle = "#3e3e3e";
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(w - padR, padT + plotH);
    ctx.stroke();

    for (var j = 0; j <= 5; j++) {
      var v = (maxMs * (5 - j)) / 5;
      var y = padT + (plotH * j) / 5;
      ctx.fillText(fmtVal(v, 0) + "ms", 2, y + 3);
    }

    var y60 = padT + plotH - (plotH * 16.67) / maxMs;
    ctx.strokeStyle = "#4ec9b0";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y60);
    ctx.lineTo(w - padR, y60);
    ctx.stroke();

    var y30 = padT + plotH - (plotH * 33.33) / maxMs;
    if (y30 > padT && y30 < padT + plotH) {
      ctx.strokeStyle = "#e06c75";
      ctx.beginPath();
      ctx.moveTo(padL, y30);
      ctx.lineTo(w - padR, y30);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (frameTimes.length > 0) {
      ctx.strokeStyle = "#98c379";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (var k = 0; k < frameTimes.length; k++) {
        var x = padL + (plotW * k) / Math.max(1, frameTimes.length - 1);
        var v2 = Math.min(maxMs, frameTimes[k]);
        var y2 = padT + plotH - (plotH * v2) / maxMs;
        if (k === 0) ctx.moveTo(x, y2);
        else ctx.lineTo(x, y2);
      }
      ctx.stroke();
    }

    var legendEl = document.getElementById("gpu-frame-legend");
    if (legendEl) {
      legendEl.innerHTML =
        '<span class="legend-item" style="color:#98c379">Frame Time</span>' +
        '<span class="legend-item" style="color:#4ec9b0">16.67ms (60fps)</span>' +
        '<span class="legend-item" style="color:#e06c75">33.33ms (30fps)</span>';
    }
  }

  // --- GPU Resources ---

  function refreshGPUResources() {
    callInspector("getGPUResourceStats").then(function (res) {
      if (res.err || !res.result) return;
      var stats = res.result;

      var summaryEl = document.getElementById("gpu-resource-summary");
      if (summaryEl) {
        summaryEl.innerHTML = debugGridHtml([
          ["Textures", String(stats.textureCount)],
          ["Texture VRAM", formatBytes(stats.textureBytes)],
          ["Buffers", String(stats.bufferCount)],
          ["Buffer VRAM", formatBytes(stats.bufferBytes)],
          ["Total Resources", String(stats.textureCount + stats.bufferCount)],
          ["Total VRAM", formatBytes(stats.totalBytes)],
        ]);
      }

      var tbody = document.getElementById("gpu-resource-tbody");
      if (tbody) {
        var resources = stats.resources || [];
        var shown = resources.slice(0, 200);
        var html = "";
        for (var i = 0; i < shown.length; i++) {
          var r = shown[i];
          var typeClass = r.type === "texture" ? "gpu-res-type-text" : "gpu-res-type-buffer";
          var formatOrUsage = r.type === "texture"
            ? (r.format || "—")
            : formatUsageFlags(r.usageFlags);
          var dims = r.type === "texture"
            ? (r.width || 0) + "x" + (r.height || 0) + (r.depthOrArrayLayers > 1 ? "x" + r.depthOrArrayLayers : "") + (r.mipLevelCount > 1 ? " (" + r.mipLevelCount + " mip)" : "")
            : formatBytes(r.size);
          var copyData = JSON.stringify(r);
          html += '<tr>';
          html += '<td class="' + typeClass + '">' + r.type + '</td>';
          html += '<td>' + escapeHtml(r.label) + '</td>';
          html += '<td class="gpu-res-callsite">' + escapeHtml(r.callsite || '') + '</td>';
          html += '<td>' + formatBytes(r.size) + '</td>';
          html += '<td class="gpu-res-format-col">' + escapeHtml(formatOrUsage) + '</td>';
          html += '<td>' + escapeHtml(dims) + '</td>';
          html += '<td><button class="gpu-res-copy-btn" data-copy=\'' + copyData.replace(/'/g, '&#39;') + '\'>Copy</button></td>';
          html += '</tr>';
        }
        if (resources.length > 200) {
          html += '<tr><td colspan="7" style="color:#888;text-align:center;">... ' + (resources.length - 200) + ' more resources (sorted by size, top 200 shown)</td></tr>';
        }
        tbody.innerHTML = html;
      }
    });
  }

  // --- GPU System Metrics (nvidia-smi via IPC) ---

  function refreshGPUSystemMetrics() {
    callInspector("getGPUSystemInfo").then(function (res) {
      var data = res.result;
      var metricsEl = document.getElementById("gpu-system-metrics");
      var procTbody = document.getElementById("gpu-process-tbody");
      if (res.err || !data) {
        if (metricsEl) metricsEl.innerHTML = '<div class="debug-row"><div class="debug-label">nvidia-smi</div><div class="debug-value" style="color:#666">Not available</div></div>';
        if (procTbody) procTbody.innerHTML = "";
        return;
      }
      var gpu = data.gpus && data.gpus[0];
      if (gpu && metricsEl) {
        metricsEl.innerHTML = debugGridHtml([
          ["GPU Name", gpu.name || "—"],
          ["Driver", gpu.driver_version || "—"],
          ["GPU Utilization", fmtVal(gpu.utilization_gpu, 0) + "%"],
          ["VRAM Used", fmtVal(gpu.memory_used, 0) + " / " + fmtVal(gpu.memory_total, 0) + " MB"],
          ["Temperature", fmtVal(gpu.temperature_gpu, 0) + " C"],
          ["Power Draw", fmtVal(gpu.power_draw, 1) + " W"],
          ["SM Clock", fmtVal(gpu.clocks_sm, 0) + " MHz"],
          ["Mem Clock", fmtVal(gpu.clocks_mem, 0) + " MHz"],
        ]);
      }
      if (procTbody) {
        var procs = data.processes || [];
        var html = "";
        for (var i = 0; i < procs.length; i++) {
          var p = procs[i];
          html += '<tr><td>' + escapeHtml(String(p.pid)) + '</td>';
          html += '<td>' + escapeHtml(p.processName) + '</td>';
          html += '<td>' + fmtVal(p.usedMemoryMB, 0) + '</td></tr>';
        }
        if (procs.length === 0) {
          html = '<tr><td colspan="3" style="color:#666;text-align:center;">No GPU processes</td></tr>';
        }
        procTbody.innerHTML = html;
      }
    });
  }

  // --- Host GPU Info (downdraft.getGpuInfo — wgpu adapter identity) ---

  function refreshHostGpuInfo() {
    callInspector("getGPUAdapterInfo").then(function (res) {
      var info = res.result;
      var el = document.getElementById("gpu-host-info");
      if (!el) return;
      if (res.err || !info) {
        el.innerHTML = '<div class="debug-row"><div class="debug-label">Status</div><div class="debug-value" style="color:#666">Not available (no host bridge)</div></div>';
        return;
      }
      var rows = [
        ["Backend", info.backend || "—"],
        ["Vendor", info.vendor || "—"],
        ["Architecture", info.architecture || "—"],
        ["Device", info.device || "—"],
        ["Description", info.description || "—"],
      ];
      if (info.features && info.features.length) {
        rows.push(["Features", info.features.join(", ")]);
      }
      el.innerHTML = debugGridHtml(rows);

      var badge = document.getElementById("host-runtime-badge");
      if (badge && info.backend) {
        badge.textContent = "Backend: " + info.backend;
        badge.className = "validation-badge validation-on";
      }
    });
  }

  // --- Per-Pass GPU Timing ---

  function refreshPassTimings() {
    callInspector("getPassTimings").then(function (res) {
      if (res.err || !res.result) return;
      var passes = res.result;
      var statusEl = document.getElementById("gpu-pass-timing-status");
      var tbody = document.getElementById("gpu-pass-timing-tbody");
      if (!tbody) return;

      if (!passes || passes.length === 0) {
        if (statusEl) statusEl.textContent = "No pass timing data yet.";
        tbody.innerHTML = "";
        return;
      }
      if (statusEl) statusEl.textContent = passes.length + " passes tracked";

      var html = "";
      for (var i = 0; i < passes.length; i++) {
        var p = passes[i];
        var gpuStr = p.gpuMs > 0 ? fmtVal(p.gpuMs, 3) : "—";
        var trisStr = p.triangles >= 1000 ? fmtVal(p.triangles / 1000, 1) + "K" : String(p.triangles);
        html += '<tr>';
        html += '<td class="pass-name">' + escapeHtml(p.name) + '</td>';
        html += '<td class="pass-cpu">' + fmtVal(p.cpuMs, 3) + '</td>';
        html += '<td class="pass-gpu">' + gpuStr + '</td>';
        html += '<td>' + String(p.drawCalls) + '</td>';
        html += '<td>' + trisStr + '</td>';
        html += '<td>' + String(p.pipelineSwitches || 0) + '</td>';
        html += '<td>' + String(p.bindGroupChanges || 0) + '</td>';
        html += '<td>' + String(p.bufferRebinds || 0) + '</td>';
        html += '</tr>';
      }
      tbody.innerHTML = html;
    });
  }

  // --- Performance Graph ---

  function drawPerfGraph() {
    var canvas = document.getElementById("gpu-perf-graph");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var padL = 40, padR = 8, padT = 8, padB = 16;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);

    callInspector("getFrameTelemetry").then(function (res) {
      if (res.err || !res.result) return;
      var t = res.result;
      perfGraphHistory.push({
        frameTime: t.avgFrameTime || 16.67,
        gpuTime: t.gpuTimeMs || 0,
        drawCalls: t.drawCalls || 0,
      });
      if (perfGraphHistory.length > PERF_GRAPH_MAX) perfGraphHistory.shift();

      var maxMs = 50;
      for (var i = 0; i < perfGraphHistory.length; i++) {
        if (perfGraphHistory[i].frameTime > maxMs) maxMs = perfGraphHistory[i].frameTime;
      }
      maxMs = Math.ceil(maxMs / 10) * 10;

      ctx.strokeStyle = "#3e3e3e";
      ctx.fillStyle = "#888";
      ctx.font = "10px monospace";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT);
      ctx.lineTo(padL, padT + plotH);
      ctx.lineTo(w - padR, padT + plotH);
      ctx.stroke();

      for (var j = 0; j <= 5; j++) {
        var v = (maxMs * (5 - j)) / 5;
        var y = padT + (plotH * j) / 5;
        ctx.fillText(fmtVal(v, 0) + "ms", 2, y + 3);
      }

      var y60 = padT + plotH - (plotH * 16.67) / maxMs;
      ctx.strokeStyle = "#4ec9b0";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, y60);
      ctx.lineTo(w - padR, y60);
      ctx.stroke();

      var y30 = padT + plotH - (plotH * 33.33) / maxMs;
      if (y30 > padT && y30 < padT + plotH) {
        ctx.strokeStyle = "#e06c75";
        ctx.beginPath();
        ctx.moveTo(padL, y30);
        ctx.lineTo(w - padR, y30);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (perfGraphHistory.length > 1) {
        ctx.strokeStyle = "#98c379";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var k = 0; k < perfGraphHistory.length; k++) {
          var x = padL + (plotW * k) / (PERF_GRAPH_MAX - 1);
          var y2 = padT + plotH - (plotH * perfGraphHistory[k].frameTime) / maxMs;
          if (k === 0) ctx.moveTo(x, y2); else ctx.lineTo(x, y2);
        }
        ctx.stroke();

        if (perfGraphHistory[0].gpuTime > 0) {
          ctx.strokeStyle = "#c678dd";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (var g = 0; g < perfGraphHistory.length; g++) {
            var gx = padL + (plotW * g) / (PERF_GRAPH_MAX - 1);
            var gy = padT + plotH - (plotH * perfGraphHistory[g].gpuTime) / maxMs;
            if (g === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
          }
          ctx.stroke();
        }
      }

      var legendEl = document.getElementById("gpu-perf-graph-legend");
      if (legendEl) {
        legendEl.innerHTML =
          '<span class="legend-item" style="color:#98c379">Frame Time</span>' +
          '<span class="legend-item" style="color:#c678dd">GPU Time</span>' +
          '<span class="legend-item" style="color:#4ec9b0">— 60fps</span>' +
          '<span class="legend-item" style="color:#e06c75">— 30fps</span>';
      }
    });
  }

  // --- Snapshot Comparison ---

  function refreshSnapshots() {
    callInspector("getSnapshots").then(function (res) {
      if (res.err || !res.result) return;
      var snaps = res.result || [];
      var listEl = document.getElementById("gpu-snapshot-list");
      var selA = document.getElementById("gpu-snapshot-a");
      var selB = document.getElementById("gpu-snapshot-b");

      if (listEl) {
        if (snaps.length === 0) {
          listEl.innerHTML = '<div style="color:#666;font-style:italic;padding:4px">No snapshots saved</div>';
        } else {
          var html = "";
          for (var i = 0; i < snaps.length; i++) {
            var s = snaps[i];
            var t = new Date(s.timestamp);
            var ts = t.getHours() + ":" + (t.getMinutes() < 10 ? "0" : "") + t.getMinutes() + ":" +
                     (t.getSeconds() < 10 ? "0" : "") + t.getSeconds();
            html += '<div class="snap-item"><span class="snap-label">[' + i + '] ' + escapeHtml(s.label) +
                    '</span><span class="snap-time">' + ts + '</span>' +
                    ' — FPS:' + fmtVal(s.fps, 0) + ' Draws:' + String(s.drawCalls) +
                    ' Tris:' + String(s.triangles) + ' GPU:' + fmtVal(s.gpuTimeMs, 2) + 'ms</div>';
          }
          listEl.innerHTML = html;
        }
      }

      function fillSelect(sel, snaps) {
        if (!sel) return;
        var prevVal = sel.value;
        var html = '<option value="-1">— Select —</option>';
        for (var i = 0; i < snaps.length; i++) {
          html += '<option value="' + i + '">[' + i + '] ' + escapeHtml(snaps[i].label) + '</option>';
        }
        sel.innerHTML = html;
        sel.value = prevVal;
      }
      fillSelect(selA, snaps);
      fillSelect(selB, snaps);
    });
  }

  function showSnapshotDiff(diffs) {
    var diffEl = document.getElementById("gpu-snapshot-diff");
    if (!diffEl) return;
    if (!diffs || diffs.length === 0) {
      diffEl.innerHTML = '<div style="color:#666;font-style:italic;padding:4px">No differences or invalid selection</div>';
      return;
    }

    var html = '<div class="diff-row diff-header">' +
      '<div class="diff-label">Metric</div>' +
      '<div class="diff-val-a">Snapshot A</div>' +
      '<div class="diff-val-b">Snapshot B</div>' +
      '<div class="diff-delta">Delta</div>' +
      '</div>';

    for (var i = 0; i < diffs.length; i++) {
      var d = diffs[i];
      var deltaStr = d.delta >= 0 ? "+" : "";
      var deltaVal = deltaStr + fmtVal(d.delta, d.delta % 1 === 0 ? 0 : 2);
      var deltaClass = d.delta < 0 ? "diff-delta negative" : "diff-delta";
      var valA = d.a % 1 === 0 ? String(d.a) : fmtVal(d.a, 2);
      var valB = d.b % 1 === 0 ? String(d.b) : fmtVal(d.b, 2);
      html += '<div class="diff-row">' +
        '<div class="diff-label">' + escapeHtml(d.metric) + '</div>' +
        '<div class="diff-val-a">' + valA + '</div>' +
        '<div class="diff-val-b">' + valB + '</div>' +
        '<div class="' + deltaClass + '">' + deltaVal + '</div>' +
        '</div>';
    }
    diffEl.innerHTML = html;
  }

  // --- Event Handlers ---

  // GPU resource copy button handler (event delegation)
  var gpuResTbody = document.getElementById("gpu-resource-tbody");
  if (gpuResTbody) {
    gpuResTbody.addEventListener("click", function (e) {
      var btn = e.target;
      if (!btn || !btn.classList || !btn.classList.contains("gpu-res-copy-btn")) return;
      var data = btn.getAttribute("data-copy") || "";
      if (navigator.clipboard) {
        navigator.clipboard.writeText(data).then(function () {
          btn.textContent = "Copied!";
          btn.classList.add("copied");
          setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = data;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (err) {}
        document.body.removeChild(ta);
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      }
    });
  }

  // Clear GPU errors button
  var btnClearGpuErrors = document.getElementById("btn-clear-gpu-errors");
  if (btnClearGpuErrors) {
    btnClearGpuErrors.addEventListener("click", function () {
      callInspector("clearGPUErrors").then(function () {
        gpuErrorCount = -1;
        refreshGPUErrors();
      });
    });
  }

  // Snapshot button handlers
  var btnSnapSave = document.getElementById("btn-gpu-snapshot-save");
  if (btnSnapSave) {
    btnSnapSave.addEventListener("click", function () {
      var label = "Snap " + new Date().toLocaleTimeString();
      callInspector("saveSnapshot", [label]).then(function () {
        refreshSnapshots();
      });
    });
  }

  var btnSnapClear = document.getElementById("btn-gpu-snapshot-clear");
  if (btnSnapClear) {
    btnSnapClear.addEventListener("click", function () {
      callInspector("clearSnapshots").then(function () {
        refreshSnapshots();
        var diffEl = document.getElementById("gpu-snapshot-diff");
        if (diffEl) diffEl.innerHTML = "";
      });
    });
  }

  var btnSnapDiff = document.getElementById("btn-gpu-snapshot-diff");
  if (btnSnapDiff) {
    btnSnapDiff.addEventListener("click", function () {
      var selA = document.getElementById("gpu-snapshot-a");
      var selB = document.getElementById("gpu-snapshot-b");
      var idxA = parseInt(selA ? selA.value : "-1", 10);
      var idxB = parseInt(selB ? selB.value : "-1", 10);
      if (idxA < 0 || idxB < 0) {
        showSnapshotDiff([]);
        return;
      }
      callInspector("diffSnapshots", [idxA, idxB]).then(function (res) {
        if (res.err || !res.result) {
          showSnapshotDiff([]);
          return;
        }
        showSnapshotDiff(res.result);
      });
    });
  }

  // --- Frame Graph Visualizer ---

  var fgCanvas = document.getElementById("gpu-framegraph-canvas");
  var fgCtx = fgCanvas ? fgCanvas.getContext("2d") : null;
  var fgDetailEl = document.getElementById("gpu-framegraph-detail");
  var fgSummaryEl = document.getElementById("gpu-framegraph-summary");
  var fgValidationsEl = document.getElementById("gpu-framegraph-validations");
  var fgSelectedNode = null;
  var fgNodePositions = [];
  var fgScale = 1;
  var fgOffsetX = 0;
  var fgOffsetY = 0;
  var fgLastData = null;
  var fgIsDragging = false;
  var fgDragStartX = 0;
  var fgDragStartY = 0;
  var fgDragOffX = 0;
  var fgDragOffY = 0;
  var fgHasMoved = false;

  function fgColorForGpuMs(gpuMs) {
    if (gpuMs <= 0) return "#4a4a5a";
    if (gpuMs < 0.5) return "#4ec9b0";
    if (gpuMs < 1.5) return "#dcdcaa";
    if (gpuMs < 3.0) return "#ce9178";
    return "#f44747";
  }

  function fgCategoryColor(category) {
    switch (category) {
      case "scene": return "#569cd6";
      case "postprocess": return "#c678dd";
      case "pixelation": return "#d19a66";
      case "ui": return "#4ec9b0";
      default: return "#888";
    }
  }

  function refreshFrameGraph() {
    callInspector("getFrameGraph").then(function (res) {
      if (res.err || !res.result) {
        if (fgSummaryEl) {
          if (res.err) {
            fgSummaryEl.innerHTML = '<span style="color:#f44747">Frame graph error: ' + escapeHtml(String(res.err)) + '</span>';
          } else {
            fgSummaryEl.textContent = "Frame graph not available — is the renderer initialized?";
          }
        }
        return;
      }
      var data = res.result;
      fgLastData = data;
      drawFrameGraph(data);
      renderFrameGraphSummary(data);
      renderFrameGraphValidations(data);
    });
  }

  function fgRedraw() {
    if (fgLastData) drawFrameGraph(fgLastData);
  }

  function drawFrameGraph(data) {
    if (!fgCtx || !fgCanvas) return;
    var W = fgCanvas.width;
    var H = fgCanvas.height;
    fgCtx.clearRect(0, 0, W, H);
    fgCtx.fillStyle = "#1a1a2e";
    fgCtx.fillRect(0, 0, W, H);

    fgCtx.save();
    fgCtx.translate(fgOffsetX, fgOffsetY);
    fgCtx.scale(fgScale, fgScale);

    var nodes = data.nodes;
    var edges = data.edges;
    if (!nodes || nodes.length === 0) {
      fgCtx.restore();
      fgCtx.fillStyle = "#666";
      fgCtx.font = "11px monospace";
      fgCtx.textAlign = "center";
      fgCtx.fillText("No frame graph data", W / 2, H / 2);
      return;
    }

    // Group nodes by layer
    var layers = [[], [], []];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.active) layers[n.layer].push(n);
    }

    // Layout: each layer is a column, nodes stacked vertically
    var layerX = [60, W / 2, W - 60];
    var nodeW = 110;
    var nodeH = 36;
    var padY = 20;
    fgNodePositions = [];

    for (var li = 0; li < 3; li++) {
      var layerNodes = layers[li];
      var count = layerNodes.length;
      if (count === 0) continue;
      var totalH = count * nodeH + (count - 1) * padY;
      var startY = (H - totalH) / 2;
      if (startY < 10) startY = 10;

      for (var ni = 0; ni < count; ni++) {
        var node = layerNodes[ni];
        var x = layerX[li] - nodeW / 2;
        var y = startY + ni * (nodeH + padY);
        fgNodePositions.push({ id: node.id, node: node, x: x, y: y, w: nodeW, h: nodeH });
      }
    }

    // Draw edges
    var nodeMap = {};
    for (var pi = 0; pi < fgNodePositions.length; pi++) {
      nodeMap[fgNodePositions[pi].id] = fgNodePositions[pi];
    }

    for (var ei = 0; ei < edges.length; ei++) {
      var edge = edges[ei];
      var from = nodeMap[edge.from];
      var to = nodeMap[edge.to];
      if (!from || !to) continue;

      var x1 = from.x + from.w;
      var y1 = from.y + from.h / 2;
      var x2 = to.x;
      var y2 = to.y + to.h / 2;
      var midX = (x1 + x2) / 2;

      fgCtx.strokeStyle = edge.type === "chain" ? "#c678dd" : "#555";
      fgCtx.lineWidth = edge.type === "chain" ? 2 : 1.5;
      fgCtx.globalAlpha = 0.6;
      fgCtx.beginPath();
      fgCtx.moveTo(x1, y1);
      fgCtx.bezierCurveTo(midX, y1, midX, y2, x2, y2);
      fgCtx.stroke();
      fgCtx.globalAlpha = 1;

      // Arrow head
      var angle = Math.atan2(y2 - y1, x2 - midX);
      fgCtx.fillStyle = edge.type === "chain" ? "#c678dd" : "#555";
      fgCtx.beginPath();
      fgCtx.moveTo(x2, y2);
      fgCtx.lineTo(x2 - 6 * Math.cos(angle - 0.4), y2 - 6 * Math.sin(angle - 0.4));
      fgCtx.lineTo(x2 - 6 * Math.cos(angle + 0.4), y2 - 6 * Math.sin(angle + 0.4));
      fgCtx.closePath();
      fgCtx.fill();
    }

    // Draw nodes
    for (var nj = 0; nj < fgNodePositions.length; nj++) {
      var pos = fgNodePositions[nj];
      var nd = pos.node;
      var isSelected = fgSelectedNode && fgSelectedNode === nd.id;

      // Node background
      fgCtx.fillStyle = isSelected ? "#2d4d6d" : "#252535";
      fgCtx.strokeStyle = fgCategoryColor(nd.category);
      fgCtx.lineWidth = isSelected ? 2.5 : 1.5;
      roundRect(fgCtx, pos.x, pos.y, pos.w, pos.h, 4);
      fgCtx.fill();
      fgCtx.stroke();

      // GPU time bar
      if (nd.gpuMs > 0) {
        var barW = Math.min(pos.w - 8, nd.gpuMs * 20);
        fgCtx.fillStyle = fgColorForGpuMs(nd.gpuMs);
        fgCtx.globalAlpha = 0.3;
        fgCtx.fillRect(pos.x + 4, pos.y + pos.h - 5, barW, 3);
        fgCtx.globalAlpha = 1;
      }

      // Node label
      fgCtx.fillStyle = "#d4d4d4";
      fgCtx.font = "10px monospace";
      fgCtx.textAlign = "center";
      fgCtx.textBaseline = "middle";
      var label = nd.name.length > 14 ? nd.name.substring(0, 13) + "\u2026" : nd.name;
      fgCtx.fillText(label, pos.x + pos.w / 2, pos.y + 12);

      // GPU time
      if (nd.gpuMs > 0) {
        fgCtx.fillStyle = fgColorForGpuMs(nd.gpuMs);
        fgCtx.font = "9px monospace";
        fgCtx.fillText(nd.gpuMs.toFixed(2) + "ms", pos.x + pos.w / 2, pos.y + 24);
      } else if (nd.drawCalls > 0) {
        fgCtx.fillStyle = "#888";
        fgCtx.font = "9px monospace";
        fgCtx.fillText(nd.drawCalls + "dc", pos.x + pos.w / 2, pos.y + 24);
      }
    }

    // Layer labels
    fgCtx.fillStyle = "#555";
    fgCtx.font = "9px monospace";
    fgCtx.textAlign = "center";
    fgCtx.fillText("Scene Passes", layerX[0], 12);
    fgCtx.fillText("Post-Process", layerX[1], 12);
    fgCtx.fillText("Composite", layerX[2], 12);

    fgCtx.restore();

    // Zoom indicator (drawn in screen space)
    fgCtx.fillStyle = "#555";
    fgCtx.font = "9px monospace";
    fgCtx.textAlign = "right";
    fgCtx.textBaseline = "top";
    fgCtx.fillText("Zoom: " + fgScale.toFixed(1) + "x  (scroll=zoom, drag=pan, dbl-click=reset)", W - 6, H - 14);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function renderFrameGraphSummary(data) {
    if (!fgSummaryEl) return;
    var html = '<div class="gpu-framegraph-stats">';
    html += '<span class="fg-stat">GPU: <b style="color:' + fgColorForGpuMs(data.totalGpuMs) + '">' + data.totalGpuMs.toFixed(2) + 'ms</b></span>';
    html += '<span class="fg-stat">CPU: <b>' + data.totalCpuMs.toFixed(2) + 'ms</b></span>';
    html += '<span class="fg-stat">Draws: <b>' + data.totalDrawCalls + '</b></span>';
    html += '<span class="fg-stat">Tris: <b>' + data.totalTriangles.toLocaleString() + '</b></span>';
    html += '<span class="fg-stat">Nodes: <b>' + data.nodes.length + '</b></span>';
    html += '<span class="fg-stat">Edges: <b>' + data.edges.length + '</b></span>';
    html += '</div>';
    fgSummaryEl.innerHTML = html;
  }

  function renderFrameGraphValidations(data) {
    if (!fgValidationsEl) return;
    var vals = data.validations || [];
    if (vals.length === 0) {
      fgValidationsEl.innerHTML = '<div class="fg-validation-none">No validation issues</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      var cls = v.level === "warning" ? "fg-validation-warning" : "fg-validation-info";
      html += '<div class="' + cls + '">';
      html += '<span class="fg-validation-icon">' + (v.level === "warning" ? "\u26a0" : "\u2139") + "</span>";
      html += escapeHtml(v.message);
      html += '</div>';
    }
    fgValidationsEl.innerHTML = html;
  }

  function renderFrameGraphDetail(node) {
    if (!fgDetailEl) return;
    if (!node) {
      fgDetailEl.innerHTML = '<div class="fg-detail-empty">Click a node for details</div>';
      return;
    }
    var html = '<div class="fg-detail-header" style="color:' + fgCategoryColor(node.category) + '">' + escapeHtml(node.name) + '</div>';
    html += '<div class="fg-detail-grid">';
    html += '<div class="fg-detail-row"><span>GPU Time</span><b style="color:' + fgColorForGpuMs(node.gpuMs) + '">' + node.gpuMs.toFixed(3) + ' ms</b></div>';
    html += '<div class="fg-detail-row"><span>CPU Time</span><b>' + node.cpuMs.toFixed(3) + ' ms</b></div>';
    html += '<div class="fg-detail-row"><span>Draw Calls</span><b>' + node.drawCalls + '</b></div>';
    html += '<div class="fg-detail-row"><span>Triangles</span><b>' + node.triangles.toLocaleString() + '</b></div>';
    html += '<div class="fg-detail-row"><span>Pipeline Switches</span><b>' + node.pipelineSwitches + '</b></div>';
    html += '<div class="fg-detail-row"><span>Bind Group Changes</span><b>' + node.bindGroupChanges + '</b></div>';
    html += '<div class="fg-detail-row"><span>Buffer Rebinds</span><b>' + node.bufferRebinds + '</b></div>';
    html += '<div class="fg-detail-row"><span>Category</span><b>' + node.category + '</b></div>';
    html += '<div class="fg-detail-row"><span>Active</span><b>' + (node.active ? "yes" : "no") + '</b></div>';
    html += '</div>';
    fgDetailEl.innerHTML = html;
  }

  // Convert screen mouse coords to graph world coords
  function fgScreenToWorld(clientX, clientY) {
    var rect = fgCanvas.getBoundingClientRect();
    var scaleX = fgCanvas.width / rect.width;
    var scaleY = fgCanvas.height / rect.height;
    var sx = (clientX - rect.left) * scaleX;
    var sy = (clientY - rect.top) * scaleY;
    return {
      x: (sx - fgOffsetX) / fgScale,
      y: (sy - fgOffsetY) / fgScale,
      sx: sx,
      sy: sy,
    };
  }

  // Canvas click handler for node selection
  if (fgCanvas) {
    fgCanvas.addEventListener("click", function (ev) {
      if (fgHasMoved) return; // suppress click after drag
      var w = fgScreenToWorld(ev.clientX, ev.clientY);

      for (var i = 0; i < fgNodePositions.length; i++) {
        var pos = fgNodePositions[i];
        if (w.x >= pos.x && w.x <= pos.x + pos.w && w.y >= pos.y && w.y <= pos.y + pos.h) {
          fgSelectedNode = pos.node.id;
          renderFrameGraphDetail(pos.node);
          fgRedraw();
          return;
        }
      }
    });

    // Double-click resets view
    fgCanvas.addEventListener("dblclick", function () {
      fgScale = 1;
      fgOffsetX = 0;
      fgOffsetY = 0;
      fgRedraw();
    });

    // Wheel to zoom (centered on cursor)
    fgCanvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var w = fgScreenToWorld(ev.clientX, ev.clientY);
      var delta = ev.deltaY > 0 ? 0.9 : 1.1;
      var newScale = Math.max(0.3, Math.min(5, fgScale * delta));
      // Adjust offset so the world point under cursor stays fixed
      fgOffsetX = w.sx - w.x * newScale;
      fgOffsetY = w.sy - w.y * newScale;
      fgScale = newScale;
      fgRedraw();
    }, { passive: false });

    // Drag to pan
    fgCanvas.addEventListener("mousedown", function (ev) {
      fgIsDragging = true;
      fgHasMoved = false;
      fgDragStartX = ev.clientX;
      fgDragStartY = ev.clientY;
      fgDragOffX = fgOffsetX;
      fgDragOffY = fgOffsetY;
      fgCanvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", function (ev) {
      if (!fgIsDragging) return;
      var dx = ev.clientX - fgDragStartX;
      var dy = ev.clientY - fgDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fgHasMoved = true;
      var rect = fgCanvas.getBoundingClientRect();
      var scaleX = fgCanvas.width / rect.width;
      var scaleY = fgCanvas.height / rect.height;
      fgOffsetX = fgDragOffX + dx * scaleX;
      fgOffsetY = fgDragOffY + dy * scaleY;
      fgRedraw();
    });

    window.addEventListener("mouseup", function () {
      if (fgIsDragging) {
        fgIsDragging = false;
        fgCanvas.style.cursor = "grab";
      }
    });

    fgCanvas.style.cursor = "grab";
  }

  // Initial detail placeholder
  renderFrameGraphDetail(null);

  // Copy-to-clipboard for external tool commands
  var toolCmds = document.querySelectorAll(".gpu-tool-command");
  for (var ci = 0; ci < toolCmds.length; ci++) {
    (function (el) {
      el.addEventListener("click", function () {
        var cmd = el.getAttribute("data-cmd") || el.textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(cmd).then(function () {
            el.classList.add("copied");
            setTimeout(function () { el.classList.remove("copied"); }, 1500);
          });
        } else {
          var ta = document.createElement("textarea");
          ta.value = cmd;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch (e) {}
          document.body.removeChild(ta);
          el.classList.add("copied");
          setTimeout(function () { el.classList.remove("copied"); }, 1500);
        }
      });
    })(toolCmds[ci]);
  }

  // Copy-to-clipboard for GPU resource rows (uses event delegation because
  // the table tbody is re-rendered every 500ms)
  var resTbody = document.getElementById("gpu-resource-tbody");
  if (resTbody) {
    resTbody.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target || !target.classList || !target.classList.contains("gpu-res-copy-btn")) return;
      var data = target.getAttribute("data-copy");
      if (!data) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(data).then(function () {
          target.classList.add("copied");
          setTimeout(function () { target.classList.remove("copied"); }, 1500);
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = data;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        target.classList.add("copied");
        setTimeout(function () { target.classList.remove("copied"); }, 1500);
      }
    });
  }

  // --- Feature Log ---

  function refreshFeatureLog() {
    callInspector("getFeatureLog").then(function (res) {
      if (res.err || !res.result) return;
      var el = document.getElementById("feature-log-text");
      if (el) el.textContent = res.result.line || "(feature log not yet collected)";
    });
  }

  (function () {
    var btn = document.getElementById("btn-copy-feature-log");
    if (btn) {
      btn.addEventListener("click", function () {
        callInspector("getFeatureLog").then(function (res) {
          if (res.err || !res.result) return;
          var text = res.result.line || "";
          if (!text) return;
          navigator.clipboard.writeText(text).then(function () {
            btn.textContent = "Copied!";
            setTimeout(function () { btn.textContent = "Copy"; }, 1500);
          }).catch(function () {
            // Fallback: select + execCommand
            var el = document.getElementById("feature-log-text");
            if (el) {
              var selection = window.getSelection();
              var range = document.createRange();
              range.selectNodeContents(el);
              selection.removeAllRanges();
              selection.addRange(range);
              document.execCommand("copy");
              selection.removeAllRanges();
              btn.textContent = "Copied!";
              setTimeout(function () { btn.textContent = "Copy"; }, 1500);
            }
          });
        });
      });
    }
  })();

  // --- Init: start refresh cycle immediately ---

  refreshGPUInfo();
  refreshGPUErrors();
  refreshFrameTelemetry();
  refreshGPUResources();
  refreshPassTimings();
  drawPerfGraph();
  refreshSnapshots();
  refreshFrameGraph();
  refreshGPUSystemMetrics();
  refreshHostGpuInfo();
  refreshFeatureLog();

  gpuTimer = setInterval(function () {
    refreshGPUInfo();
    refreshGPUErrors();
    refreshFrameTelemetry();
    refreshGPUResources();
    refreshPassTimings();
    drawPerfGraph();
    refreshFrameGraph();
    refreshGPUSystemMetrics();
    refreshHostGpuInfo();
    refreshFeatureLog();
  }, 500);

})();
