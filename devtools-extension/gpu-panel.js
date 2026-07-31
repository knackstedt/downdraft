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

  // --- Electron GPU Info (app.getGPUInfo via IPC) ---

  function refreshElectronGPUInfo() {
    callInspector("getElectronGPUInfo").then(function (res) {
      var info = res.result;
      var el = document.getElementById("gpu-electron-info");
      if (!el) return;
      if (res.err || !info) {
        el.innerHTML = '<div class="debug-row"><div class="debug-label">Status</div><div class="debug-value" style="color:#666">Not available (Electron GPU info not accessible)</div></div>';
        return;
      }
      var rows = [
        ["GPU Vendor", info.gpuVendor || "—"],
        ["GPU Device", info.gpuDevice || "—"],
        ["GPU Driver", info.gpuDriver || "—"],
        ["Driver Version", info.gpuDriverVersion || "—"],
        ["GPU Active", info.gpuActive ? "Yes" : "No"],
      ];
      if (info.auxAttributes) {
        var aux = info.auxAttributes;
        if (aux.vendorId) rows.push(["Vendor ID", aux.vendorId]);
        if (aux.deviceId) rows.push(["Device ID", aux.deviceId]);
        if (aux.optimus !== undefined) rows.push(["Optimus", aux.optimus ? "Yes" : "No"]);
      }
      if (info.featureStatus) {
        var fs = info.featureStatus;
        if (fs.gpu_rasterization !== undefined) rows.push(["GPU Rasterization", fs.gpu_rasterization ? "On" : "Off"]);
        if (fs.webgl !== undefined) rows.push(["WebGL", fs.webgl ? "On" : "Off"]);
        if (fs.vulkan !== undefined) rows.push(["Vulkan", fs.vulkan ? "On" : "Off"]);
      }
      el.innerHTML = debugGridHtml(rows);
    });
  }

  // --- Vulkan Validation Layer Status ---

  function refreshVulkanValidationStatus() {
    callInspector("getVulkanValidationStatus").then(function (res) {
      var badge = document.getElementById("vulkan-validation-badge");
      if (!badge || res.err || !res.result) return;
      var data = res.result;
      if (data.enabled) {
        badge.textContent = "Vulkan Validation: ON";
        badge.className = "validation-badge validation-on";
      } else {
        badge.textContent = "Vulkan Validation: OFF";
        badge.className = "validation-badge validation-off";
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

  // Quick Launch buttons (chrome://tracing, chrome://gpu)
  // DevTools panel runs in its own context — window.downdraft is on the inspected page,
  // so we use evalInPage to invoke the IPC call from there.
  var btnChromeTracing = document.getElementById("btn-open-chrome-tracing");
  if (btnChromeTracing) {
    btnChromeTracing.addEventListener("click", function () {
      evalInPage("window.downdraft && window.downdraft.openChromeUrl && window.downdraft.openChromeUrl('chrome://tracing')", function () {});
    });
  }

  var btnChromeGpu = document.getElementById("btn-open-chrome-gpu");
  if (btnChromeGpu) {
    btnChromeGpu.addEventListener("click", function () {
      evalInPage("window.downdraft && window.downdraft.openChromeUrl && window.downdraft.openChromeUrl('chrome://gpu')", function () {});
    });
  }

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

  // --- Init: start refresh cycle immediately ---

  refreshGPUInfo();
  refreshGPUErrors();
  refreshFrameTelemetry();
  refreshGPUResources();
  refreshPassTimings();
  drawPerfGraph();
  refreshSnapshots();
  refreshGPUSystemMetrics();
  refreshElectronGPUInfo();
  refreshVulkanValidationStatus();

  gpuTimer = setInterval(function () {
    refreshGPUInfo();
    refreshGPUErrors();
    refreshFrameTelemetry();
    refreshGPUResources();
    refreshPassTimings();
    drawPerfGraph();
    refreshGPUSystemMetrics();
    refreshElectronGPUInfo();
  }, 500);

  // Vulkan validation status rarely changes — check once on load
  setInterval(refreshVulkanValidationStatus, 10000);

})();
