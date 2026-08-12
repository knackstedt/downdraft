#!/usr/bin/env node
// ============================================================================
// MCP stdio-to-HTTP bridge — connects Devin's MCP client (which uses stdio)
// to the game's MCP HTTP transport on localhost:9876.
// ============================================================================

import fs from "node:fs";

const MCP_HTTP_URL = process.env.MCP_HTTP_URL ?? "http://localhost:9876/mcp";

let buf = "";

function log(...args) {
  const msg = "[mcp-bridge] " + args.join(" ") + "\n";
  process.stderr.write(msg);
  try { fs.appendFileSync("/tmp/mcp-bridge.log", msg); } catch {}
}

log("Starting bridge, MCP_HTTP_URL =", MCP_HTTP_URL);

async function sendToHttp(method, params) {
  log("→ HTTP:", method, JSON.stringify(params).slice(0, 200));
  const res = await fetch(MCP_HTTP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  log("← HTTP status:", res.status);
  if (res.status === 202) {
    throw new Error("Server returned 202 (SSE mode).");
  }
  const text = await res.text();
  log("← HTTP body:", text.slice(0, 500));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  // Check if result itself contains an error (proxy mode wraps errors in result)
  if (json.result?.error) {
    throw new Error(`MCP error ${json.result.error.code}: ${json.result.error.message}`);
  }
  return json.result;
}

async function handleMessage(msg) {
  const { id, method, params = {} } = msg;
  log("← stdin:", JSON.stringify(msg).slice(0, 200));

  // Notifications (no id) — silently ignore, don't send a response
  if (id === undefined || id === null) {
    log("  (notification, ignoring)");
    return;
  }

  try {
    let result;
    if (method === "initialize") {
      result = await sendToHttp("initialize", params);
    } else if (method === "tools/list") {
      result = await sendToHttp("tools/list", params);
    } else if (method === "tools/call") {
      result = await sendToHttp("tools/call", params);
    } else if (method === "resources/list") {
      // Return empty list — the game doesn't expose resources
      result = { resources: [] };
    } else if (method === "resources/read") {
      result = await sendToHttp("resources/read", params);
    } else if (method === "prompts/list") {
      // Return empty list — the game doesn't expose prompts
      result = { prompts: [] };
    } else if (method === "prompts/get") {
      result = await sendToHttp("prompts/get", params);
    } else if (method === "shutdown") {
      result = {};
    } else {
      const errResp = { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      log("→ stdout (error):", JSON.stringify(errResp).slice(0, 200));
      process.stdout.write(JSON.stringify(errResp) + "\n");
      return;
    }

    const response = { jsonrpc: "2.0", id, result };
    const responseStr = JSON.stringify(response);
    log("→ stdout:", responseStr.slice(0, 300));
    process.stdout.write(responseStr + "\n");
  } catch (e) {
    log("Error:", e.message);
    const errResp = { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
    process.stdout.write(JSON.stringify(errResp) + "\n");
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      log("Parse error:", e.message, "line:", line.slice(0, 100));
    }
  }
});

process.stdin.on("end", () => {
  log("stdin ended, exiting");
  process.exit(0);
});

process.stdin.on("error", (e) => {
  log("stdin error:", e.message);
});
