#!/usr/bin/env node
// Call an MCP tool on a running game's HTTP transport from the shell.
//
//   node scripts/mcp-call.mjs --list                    # tools/list
//   node scripts/mcp-call.mjs get_world_state           # tools/call, no args
//   node scripts/mcp-call.mjs set_test_state '{"weather":"storm"}'
//
// Unlike the stdio bridge (.devin/mcp-stdio-bridge.mjs) this is a one-shot
// CLI: each run does its own `initialize` handshake, so it never depends on
// a cached session id.
//
// Discovery matches the bridge: reads ~/.downdraft/port/<pid> files (content
// = bound port), prunes dead PIDs, picks the newest live instance. Selectors:
//   MCP_APP_ID  — narrow to a specific game (matches --user-data-dir basename;
//                 Linux-only, falls back to newest elsewhere).
//   MCP_PID     — connect to a specific PID (exact match).
//   MCP_HTTP_URL — explicit URL override (skips discovery entirely).
// If the instance wrote a <pid>.token file (mcp.requireAuth / MCP_AUTH=1),
// the token is sent via the X-Downdraft-Token header.
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PORT_DIR = join(homedir(), ".downdraft", "port");
const TIMEOUT_MS = 120_000;

function die(msg) {
  console.error(`mcp-call: ${msg}`);
  process.exit(1);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function matchesAppId(pid, appId) {
  if (process.platform !== "linux") return true;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const cmdline = raw.replace(/\0+$/g, "").replace(/\0/g, " ");
    const m = cmdline.match(/--user-data-dir=(\S+)/);
    return m ? basename(m[1]) === appId : false;
  } catch {
    return false;
  }
}

// Returns { port, pid, token? } for the newest live instance, or null.
function discoverInstance() {
  let entries;
  try {
    entries = readdirSync(PORT_DIR);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!isAlive(pid)) {
      try { unlinkSync(join(PORT_DIR, name)); } catch {}
      continue;
    }
    if (process.env.MCP_PID && pid !== Number(process.env.MCP_PID)) continue;
    if (process.env.MCP_APP_ID && !matchesAppId(pid, process.env.MCP_APP_ID)) continue;

    let port;
    try {
      port = readFileSync(join(PORT_DIR, name), "utf8").trim();
    } catch {
      continue;
    }
    if (!/^\d+$/.test(port)) continue;

    let token;
    try {
      token = readFileSync(join(PORT_DIR, `${name}.token`), "utf8").trim() || undefined;
    } catch {
      /* no token file — auth not required */
    }

    let mtime = 0;
    try {
      mtime = statSync(join(PORT_DIR, name)).mtimeMs;
    } catch {}

    candidates.push({ pid, port: Number(port), token, mtime });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

function resolveTarget() {
  if (process.env.MCP_HTTP_URL) {
    return { url: process.env.MCP_HTTP_URL, token: process.env.MCP_TOKEN };
  }
  const inst = discoverInstance();
  if (!inst) {
    const filter = process.env.MCP_APP_ID
      ? ` with appId "${process.env.MCP_APP_ID}"`
      : process.env.MCP_PID
        ? ` with PID ${process.env.MCP_PID}`
        : "";
    die(`no running downdraft game instance found${filter} in ${PORT_DIR}. Start a game first (e.g. \`draft dev\`), or set MCP_HTTP_URL.`);
  }
  return { url: `http://localhost:${inst.port}/mcp`, token: inst.token, pid: inst.pid };
}

async function rpc(url, token, sessionId, method, params) {
  const headers = {
    "Content-Type": "application/json",
    // Deliberately no text/event-stream — the transport then answers with
    // plain JSON instead of SSE framing.
    "Accept": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (token) headers["X-Downdraft-Token"] = token;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) die(`HTTP ${res.status}: ${text}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`non-JSON response: ${text.slice(0, 500)}`);
  }
  if (json.error) die(`MCP error ${json.error.code}: ${json.error.message}`);
  // Proxy mode wraps handler errors in result.error — surface those too.
  if (json.result?.error) die(`MCP error ${json.result.error.code}: ${json.result.error.message}`);
  return { result: json.result, sessionId: res.headers.get("Mcp-Session-Id") ?? sessionId };
}

function printResult(result) {
  // MCP tool results are {content: [{type, text, ...}], isError?}. Print text
  // blocks directly; fall back to the raw JSON for anything else.
  if (result?.isError) {
    for (const c of result.content ?? []) {
      if (c.type === "text") console.error(c.text);
    }
    process.exit(1);
  }
  const textBlocks = (result?.content ?? []).filter((c) => c.type === "text");
  if (textBlocks.length > 0) {
    for (const c of textBlocks) console.log(c.text);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(`Usage: node scripts/mcp-call.mjs --list
       node scripts/mcp-call.mjs <tool> [json-args]

Env: MCP_APP_ID, MCP_PID, MCP_HTTP_URL, MCP_TOKEN`);
  process.exit(args.length === 0 ? 1 : 0);
}

const target = resolveTarget();
const init = await rpc(target.url, target.token, undefined, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-call", version: "0.1.0" },
});
const sid = init.sessionId;

if (args[0] === "--list") {
  const { result } = await rpc(target.url, target.token, sid, "tools/list", {});
  for (const t of result?.tools ?? []) {
    console.log(`${t.name}\t${t.description ?? ""}`);
  }
} else {
  let toolArgs = {};
  if (args[1]) {
    try {
      toolArgs = JSON.parse(args[1]);
    } catch (e) {
      die(`invalid JSON arguments: ${e.message}`);
    }
  }
  const { result } = await rpc(target.url, target.token, sid, "tools/call", {
    name: args[0],
    arguments: toolArgs,
  });
  printResult(result);
}
