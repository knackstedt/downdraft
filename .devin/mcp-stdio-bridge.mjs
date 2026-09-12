#!/usr/bin/env node
// ============================================================================
// MCP stdio-to-HTTP bridge — connects Devin's MCP client (which uses stdio)
// to a running game's MCP HTTP transport on localhost.
//
// Discovery: by default the bridge reads PID files from ~/.downdraft/port/
// (one file per running game instance, named <pid>, content = the bound port).
// Dead-PID files are pruned on read. Among live instances it picks the newest
// by file mtime. Optional selectors:
//   MCP_APP_ID  — narrow to instances of a specific game (matches the
//                 --user-data-dir=<path> cmdline arg whose basename === appId;
//                 Linux-only, falls back to newest on other platforms).
//   MCP_PID     — connect to a specific PID (exact match).
//   MCP_HTTP_URL — explicit URL override (skips discovery entirely; used by
//                 the e2e test harness which sets MCP_PORT explicitly).
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let buf = "";

function log(...args) {
  const msg = "[mcp-bridge] " + args.join(" ") + "\n";
  process.stderr.write(msg);
  try { fs.appendFileSync("/tmp/mcp-bridge.log", msg); } catch {}
}

// ---------------------------------------------------------------------------
// Instance discovery via PID files
// ---------------------------------------------------------------------------

const PORT_DIR = path.join(os.homedir(), ".downdraft", "port");

/** Check if a PID is alive (signal 0 = no-op probe). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // process exists but not ours — still alive
  }
}

/**
 * Read /proc/<pid>/cmdline (Linux) and check if it carries
 * --user-data-dir=<path> whose basename === appId. Returns true on match.
 * Non-Linux: returns true (no filtering; falls back to newest).
 */
function matchesAppId(pid, appId) {
  if (process.platform !== "linux") return true;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const cmdline = raw.replace(/\0+$/g, "").replace(/\0/g, " ");
    // Match --user-data-dir=<path> and check basename === appId.
    const m = cmdline.match(/--user-data-dir=(\S+)/);
    if (!m) return false;
    return path.basename(m[1]) === appId;
  } catch {
    return false;
  }
}

/**
 * Discover the MCP HTTP port for a running game instance.
 *
 * Reads ~/.downdraft/port/<pid> files, prunes dead PIDs, and returns the
 * port of the newest live instance (optionally filtered by MCP_APP_ID or
 * MCP_PID env vars).
 *
 * @returns {string|null} The port number as a string, or null if none found.
 */
function discoverPort() {
  let entries;
  try {
    entries = fs.readdirSync(PORT_DIR);
  } catch {
    return null; // directory doesn't exist — no instances
  }

  const candidates = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue; // not a PID file
    const pid = Number(name);
    if (!isAlive(pid)) {
      // Prune stale file (best-effort)
      try { fs.unlinkSync(path.join(PORT_DIR, name)); } catch {}
      continue;
    }
    // Optional exact-PID filter
    if (process.env.MCP_PID && pid !== Number(process.env.MCP_PID)) continue;
    // Optional appId filter
    if (process.env.MCP_APP_ID && !matchesAppId(pid, process.env.MCP_APP_ID)) continue;

    let port;
    try {
      port = fs.readFileSync(path.join(PORT_DIR, name), "utf8").trim();
    } catch {
      continue;
    }
    if (!/^\d+$/.test(port)) continue;

    let mtime;
    try {
      mtime = fs.statSync(path.join(PORT_DIR, name)).mtimeMs;
    } catch {
      mtime = 0;
    }
    candidates.push({ pid, port: Number(port), mtime });
  }

  if (candidates.length === 0) return null;

  // Pick the newest by mtime (most recently started).
  candidates.sort((a, b) => b.mtime - a.mtime);
  const winner = candidates[0];
  log(`Discovered ${candidates.length} live instance(s); connecting to PID ${winner.pid} on port ${winner.port}`);
  return String(winner.port);
}

// ---------------------------------------------------------------------------
// Resolve target URL
// ---------------------------------------------------------------------------

function resolveUrl() {
  // Explicit override (e.g. e2e test harness sets MCP_HTTP_URL directly).
  if (process.env.MCP_HTTP_URL) {
    log("Using explicit MCP_HTTP_URL =", process.env.MCP_HTTP_URL);
    return process.env.MCP_HTTP_URL;
  }

  const port = discoverPort();
  if (!port) {
    const filter = process.env.MCP_APP_ID
      ? ` with appId "${process.env.MCP_APP_ID}"`
      : process.env.MCP_PID
        ? ` with PID ${process.env.MCP_PID}`
        : "";
    throw new Error(
      `No running downdraft game instance found${filter} in ${PORT_DIR}. ` +
      `Start a game first (e.g. \`draft dev\`), or set MCP_HTTP_URL explicitly.`,
    );
  }
  return `http://localhost:${port}/mcp`;
}

const MCP_HTTP_URL = resolveUrl();
log("Starting bridge, MCP_HTTP_URL =", MCP_HTTP_URL);

// ---------------------------------------------------------------------------
// HTTP forwarding
// ---------------------------------------------------------------------------

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
