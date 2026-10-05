// ============================================================================
// GameClient — client for a running game's in-process MCP automation endpoint.
//
// A running game (draft dev / draft test / launchGame) exposes a JSON-RPC
// over HTTP endpoint on 127.0.0.1 (McpHttpTransport) and advertises its port
// via ~/.downdraft/port/<pid>. This module is the single implementation of
// the client side of that wire — previously triplicated across
// scripts/mcp-call.mjs, .devin/mcp-stdio-bridge.mjs, and tests/e2e/harness.ts.
//
//   import { GameClient, launchGame } from "@downdraft/engine/mcp/client";
//
//   const client = await GameClient.connect();          // PID-file discovery
//   const tools = await client.listTools();
//   const state = await client.callJson("get_world_state");
//   await client.screenshot("shot.png");
//
//   // Or launch + connect + kill in one:
//   const game = await launchGame({ game: "to-the-ocean" });
//   await game.client.callText("get_player_state");
//   await game.kill();
//
// Node- and Bun-compatible: only node: APIs + fetch, no Bun.* globals.
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { MCPToolDef, MCPToolResult } from "./types";

export type { MCPToolDef, MCPToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;

export class McpClientError extends Error {}

// ---------------------------------------------------------------------------
// Instance discovery — ~/.downdraft/port/<pid> PID files
// ---------------------------------------------------------------------------

/** Directory holding one PID file per running game instance. Each file is
 *  named `<pid>` and contains the bound MCP HTTP port; a sibling
 *  `<pid>.token` holds the bearer token when the instance requires auth. */
export function mcpPortDir(): string {
    return join(homedir(), ".downdraft", "port");
}

export interface GameInstance {
    pid: number;
    /** Automation endpoint port (host tools + game harness), from the
     *  `<pid>` file. Absent when the instance only advertises an editor
     *  endpoint. */
    port?: number;
    /** Bearer token from `<pid>.token`, when the instance wrote one. */
    token?: string;
    /** Editor toolset endpoint port (`createMcpModule({ transport: "http" })`),
     *  from the `<pid>.editor` sibling file. */
    editorPort?: number;
    /** Bearer token from `<pid>.editor.token`, when present. */
    editorToken?: string;
    /** PID-file mtime — newest instance wins when no selector is given. */
    mtimeMs: number;
    /** The instance's appId when it can be recovered (Linux /proc only). */
    appId?: string;
}

export interface InstanceSelector {
    /** Match instances whose --user-data-dir basename equals this appId
     *  (Linux-only; ignored elsewhere). */
    appId?: string;
    /** Match exactly this PID. */
    pid?: number;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Best-effort appId recovery: read /proc/<pid>/cmdline and return the
 *  basename of --user-data-dir=<path>. Returns undefined on non-Linux or
 *  when the arg is absent. */
function readAppId(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const m = /--user-data-dir=(\S+)/.exec(raw.replace(/\0+$/g, "").replace(/\0/g, " "));
        return m ? basename(m[1]) : undefined;
    } catch {
        return undefined;
    }
}

/** List all live game instances, newest-first. Dead PID files are pruned
 *  as a side effect. */
export function listGameInstances(sel: InstanceSelector = {}): GameInstance[] {
    let entries: string[];
    try {
        entries = readdirSync(mcpPortDir());
    } catch {
        return [];
    }
    const out: GameInstance[] = [];
    // Group files by PID: "<pid>" is the automation endpoint, "<pid>.editor"
    // the editor toolset endpoint (createMcpModule http transport). Token
    // siblings "<pid>.token" / "<pid>.editor.token" don't match the regex.
    const byPid = new Map<number, { automation?: string; editor?: string }>();
    for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const name = _it[_i];
        const m = /^(\d+)(\.editor)?$/.exec(name);
        if (!m) continue;
        const rec = byPid.get(Number(m[1])) ?? {};
        if (m[2]) rec.editor = name; else rec.automation = name;
        byPid.set(Number(m[1]), rec);
    }
    const readPort = (file?: string): number | undefined => {
        if (!file) return undefined;
        try {
            const raw = readFileSync(join(mcpPortDir(), file), "utf8").trim();
            return /^\d+$/.test(raw) ? Number(raw) : undefined;
        } catch {
            return undefined;
        }
    };
    const readToken = (file?: string): string | undefined => {
        if (!file) return undefined;
        try {
            return readFileSync(join(mcpPortDir(), `${file}.token`), "utf8").trim() || undefined;
        } catch { /* no token file — auth not required */ }
        return undefined;
    };
    for (const [pid, files] of byPid.entries()) {
        if (!isAlive(pid)) {
            [files.automation, files.editor].forEach((f) => {
                if (!f) return;
                try { unlinkSync(join(mcpPortDir(), f)); } catch { /* gone */ }
                try { unlinkSync(join(mcpPortDir(), `${f}.token`)); } catch { /* gone */ }
            });
            continue;
        }
        if (sel.pid !== undefined && pid !== sel.pid) continue;
        const appId = readAppId(pid);
        if (sel.appId !== undefined && appId !== undefined && appId !== sel.appId) continue;
        if (sel.appId !== undefined && appId === undefined && process.platform === "linux") continue;

        const port = readPort(files.automation);
        const editorPort = readPort(files.editor);
        if (port === undefined && editorPort === undefined) continue;
        let mtimeMs = 0;
        [files.automation, files.editor].forEach((f) => {
            if (!f) return;
            try { mtimeMs = Math.max(mtimeMs, statSync(join(mcpPortDir(), f)).mtimeMs); } catch { /* treat as oldest */ }
        });
        out.push({
            pid,
            port,
            editorPort,
            token: readToken(files.automation),
            editorToken: readToken(files.editor),
            mtimeMs,
            appId,
        });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
}

/** Pick the newest live instance matching the selector, or null. */
export function discoverGameInstance(sel: InstanceSelector = {}): GameInstance | null {
    return listGameInstances(sel)[0] ?? null;
}

// ---------------------------------------------------------------------------
// GameClient
// ---------------------------------------------------------------------------

export interface GameClientOptions {
    /** Narrow discovery to a specific game's appId. */
    appId?: string;
    /** Connect to a specific PID. */
    pid?: number;
    /** Explicit endpoint URL (e.g. http://localhost:9976/mcp) — skips
     *  PID-file discovery entirely. */
    url?: string;
    /** Bearer token; auto-read from <pid>.token on discovery. */
    token?: string;
    /** Which of the instance's endpoints to connect to: "automation"
     *  (default — `<pid>` file: host tools + game harness) or "editor"
     *  (`<pid>.editor` file: createMcpModule http transport's full editor
     *  toolset). DOWNDRAFT_MCP_ENDPOINT=editor works too. Ignored when
     *  `url` is given. */
    endpoint?: "automation" | "editor";
    /** Per-request timeout in ms (default 120s). */
    timeoutMs?: number;
}

export interface CallOptions {
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
}

interface JsonRpcResponse {
    result?: unknown;
    error?: { code: number; message: string };
}

/** Minimal process handle for liveness checks during waitForReady —
 *  satisfied by node:child_process ChildProcess and Bun's Subprocess. */
export interface ProcessProbe {
    exitCode: number | null;
    killed?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export class GameClient {
    readonly url: string;
    readonly pid: number | undefined;
    private token: string | undefined;
    private sessionId: string | null = null;
    private reqId = 0;
    private defaultTimeout: number;

    private constructor(url: string, token: string | undefined, pid: number | undefined, timeoutMs: number) {
        this.url = url;
        this.token = token;
        this.pid = pid;
        this.defaultTimeout = timeoutMs;
    }

    /**
     * Connect to a running game instance. With no selector, attaches to the
     * newest live instance in ~/.downdraft/port/. Performs the `initialize`
     * handshake before returning.
     */
    static async connect(opts: GameClientOptions = {}): Promise<GameClient> {
        // Env fallbacks: DOWNDRAFT_MCP_URL/MCP_HTTP_URL for explicit targets,
        // MCP_APP_ID/MCP_PID for discovery selectors — the same selectors the
        // old stdio bridge honored, so existing configs keep working.
        const envPid = Number(process.env.MCP_PID);
        const appId = opts.appId ?? process.env.MCP_APP_ID;
        let pid = opts.pid ?? (Number.isFinite(envPid) && envPid > 0 ? envPid : undefined);
        let url = opts.url ?? process.env.DOWNDRAFT_MCP_URL ?? process.env.MCP_HTTP_URL;
        let token = opts.token ?? process.env.DOWNDRAFT_MCP_TOKEN ?? process.env.MCP_TOKEN;
        const endpoint = opts.endpoint ?? (process.env.DOWNDRAFT_MCP_ENDPOINT === "editor" ? "editor" : "automation");
        if (!url) {
            const inst = discoverGameInstance({ appId, pid });
            if (!inst) {
                const filter = appId
                    ? ` with appId "${appId}"`
                    : pid !== undefined
                        ? ` with PID ${pid}`
                        : "";
                throw new McpClientError(
                    `No running downdraft game instance found${filter} in ${mcpPortDir()}. ` +
                    `Start a game first (e.g. \`draft dev\`), or pass url / set DOWNDRAFT_MCP_URL.`,
                );
            }
            const instPort = endpoint === "editor" ? inst.editorPort : inst.port;
            if (instPort === undefined) {
                throw new McpClientError(
                    `Instance ${inst.pid} has no ${endpoint} MCP endpoint in ${mcpPortDir()}` +
                    (endpoint === "editor"
                        ? ` — register createMcpModule({ transport: "http" }) in the game, or drop the editor endpoint selection.`
                        : "."),
                );
            }
            url = `http://localhost:${instPort}/mcp`;
            token ??= endpoint === "editor" ? (inst.editorToken ?? inst.token) : inst.token;
            pid = inst.pid;
        }
        const client = new GameClient(url, token, pid, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        await client.rpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "downdraft-game-client", version: "0.1.0" },
        }, 10_000);
        return client;
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            // Deliberately no text/event-stream — the transport then answers
            // with plain JSON instead of SSE framing.
            "Accept": "application/json",
        };
        if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
        if (this.token) h["X-Downdraft-Token"] = this.token;
        return h;
    }

    private async rpc(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
        const res = await fetch(this.url, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.reqId, method, params }),
            signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeout),
        });
        const sid = res.headers.get("Mcp-Session-Id");
        if (sid) this.sessionId = sid;
        const text = await res.text();
        if (!res.ok) throw new McpClientError(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
        let json: JsonRpcResponse;
        try {
            json = JSON.parse(text);
        } catch {
            throw new McpClientError(`Non-JSON response: ${text.slice(0, 500)}`);
        }
        if (json.error) throw new McpClientError(`MCP error ${json.error.code}: ${json.error.message}`);
        // Proxy mode wraps handler errors in result.error — surface those too.
        const result = json.result as { error?: { code: number; message: string } } | undefined;
        if (result?.error) throw new McpClientError(`MCP error ${result.error.code}: ${result.error.message}`);
        return json.result;
    }

    /** Raw JSON-RPC method call — for methods without a typed helper
     *  (resources/read, prompts/get) and the stdio bridge's forwarding. */
    async request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
        return this.rpc(method, params, timeoutMs);
    }

    /** tools/list — the tool defs the game registered. */
    async listTools(): Promise<MCPToolDef[]> {
        const result = (await this.rpc("tools/list", {}, 10_000)) as { tools?: MCPToolDef[] };
        return result.tools ?? [];
    }

    /** tools/call — returns the raw {content, isError} envelope. */
    async call(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<MCPToolResult> {
        return (await this.rpc("tools/call", { name, arguments: args }, opts.timeoutMs)) as MCPToolResult;
    }

    private textOrThrow(result: MCPToolResult): string {
        const text = (result.content ?? [])
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        if (result.isError) throw new McpClientError(`MCP tool returned an error: ${text}`);
        return text;
    }

    /** tools/call → concatenated text content; throws when isError. */
    async callText(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<string> {
        return this.textOrThrow(await this.call(name, args, opts));
    }

    /** tools/call → JSON.parse of the text content; throws on isError or
     *  non-JSON output. */
    async callJson<T = unknown>(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
        const text = this.textOrThrow(await this.call(name, args, opts));
        try {
            return JSON.parse(text) as T;
        } catch (e) {
            throw new McpClientError(`MCP tool returned non-JSON text: ${(e as Error).message} | ${text.slice(0, 200)}`);
        }
    }

    /** Retry on transport/connection errors only — tool-level isError
     *  results are thrown immediately. */
    async callWithRetry(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<MCPToolResult> {
        const maxRetries = opts.retries ?? 3;
        const backoffMs = opts.backoffMs ?? 500;
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.call(name, args, opts);
                if (result.isError) {
                    throw new McpClientError(`MCP tool returned an error: ${result.content?.[0] && "text" in result.content[0] ? result.content[0].text : ""}`);
                }
                return result;
            } catch (e) {
                lastError = e as Error;
                const msg = lastError.message;
                const isTransportError =
                    msg.includes("MCP HTTP") ||
                    msg.includes("fetch failed") ||
                    msg.includes("aborted") ||
                    msg.includes("ECONNREFUSED") ||
                    msg.includes("MCP error");
                if (!isTransportError || attempt === maxRetries) throw lastError;
                await sleep(backoffMs * (attempt + 1));
            }
        }
        throw lastError ?? new McpClientError("callWithRetry exhausted retries");
    }

    /** capture_screenshot → write the image block to `path` as PNG. Returns
     *  the dimensions from the tool's text metadata. */
    async screenshot(path: string, args: Record<string, unknown> = {}): Promise<{ width: number; height: number }> {
        const result = await this.call("capture_screenshot", { fullPage: true, ...args });
        const text = this.textOrThrow(result);
        let meta: { width?: number; height?: number } = {};
        try { meta = JSON.parse(text); } catch { /* older tools may not emit meta */ }
        const image = result.content.find((c) => c.type === "image") as
            | { type: "image"; data: string; mimeType: string }
            | undefined;
        if (!image?.data) throw new McpClientError("capture_screenshot returned no image data");
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(path, Buffer.from(image.data, "base64"));
        return { width: meta.width ?? 0, height: meta.height ?? 0 };
    }

    /**
     * Wait until the instance is serving MCP and has registered tools:
     * poll GET /mcp/health, then initialize + tools/list until non-empty.
     * `proc` (optional) enables fail-fast when a launched game dies early.
     * A final capture_screenshot probe warns (non-fatal) when WebGPU isn't
     * producing frames yet — mirrors the e2e harness's readiness check.
     */
    async waitForReady(timeoutMs = 90_000, opts: { proc?: ProcessProbe } = {}): Promise<void> {
        const healthUrl = this.url.replace(/\/mcp\/?$/, "/mcp/health");
        const deadline = Date.now() + timeoutMs;
        let lastErr = "";
        const alive = () => !opts.proc || (opts.proc.exitCode === null && !opts.proc.killed);
        const failIfDead = (stage: string) => {
            if (!alive()) throw new McpClientError(`Game process exited before ${stage} became ready`);
        };

        while (Date.now() < deadline) {
            failIfDead("MCP health endpoint");
            try {
                const res = await fetch(healthUrl, {
                    headers: this.token ? { "X-Downdraft-Token": this.token } : {},
                    signal: AbortSignal.timeout(5_000),
                });
                if (res.ok) break;
                lastErr = `HTTP ${res.status}`;
            } catch (e) {
                lastErr = (e as Error).message;
            }
            await sleep(250);
        }
        if (Date.now() >= deadline) {
            throw new McpClientError(`MCP health endpoint did not become ready at ${healthUrl}: ${lastErr}`);
        }

        while (Date.now() < deadline) {
            failIfDead("MCP tools");
            try {
                const tools = await this.listTools();
                if (tools.length > 0) break;
                lastErr = "tools list empty";
            } catch (e) {
                lastErr = (e as Error).message;
            }
            await sleep(1_000);
        }
        if (Date.now() >= deadline) {
            throw new McpClientError(`MCP tools did not become available at ${this.url}: ${lastErr}`);
        }

        // Best-effort readiness probe: a valid screenshot implies WebGPU is
        // initialized. Warn but don't fail — some games can't screenshot in
        // their initial state.
        const probeDeadline = Math.min(Date.now() + 30_000, deadline + 30_000);
        let lastProbeErr = "";
        while (Date.now() < probeDeadline) {
            failIfDead("readiness probe");
            try {
                const result = await this.call("capture_screenshot", { fullPage: false }, { timeoutMs: 10_000 });
                if (!result.isError && result.content?.some((c) => c.type === "image" && c.data)) return;
                lastProbeErr = result.isError
                    ? `capture_screenshot error: ${result.content?.[0] && "text" in result.content[0] ? result.content[0].text : ""}`
                    : "capture_screenshot returned no image data";
            } catch (e) {
                lastProbeErr = (e as Error).message;
            }
            await sleep(1_000);
        }
        process.stderr.write(`[GameClient] readiness probe failed (non-fatal): ${lastProbeErr}\n`);
    }

    // ── Harness-compat aliases (the old tests/e2e McpClient interface) ──
    callTool(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<MCPToolResult> {
        return this.call(name, args, opts);
    }
    callToolWithRetry(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<MCPToolResult> {
        return this.callWithRetry(name, args, opts);
    }
    close(): void {
        // Stateless HTTP — nothing to tear down.
    }
}

// ---------------------------------------------------------------------------
// launchGame — spawn a game, wait for MCP, connect
// ---------------------------------------------------------------------------

export interface LaunchGameOptions {
    /** Game name resolved to games/<name>/ or examples/<name>/ under cwd. */
    game?: string;
    /** Explicit entry file (default: <game>/src/native-entry.ts). */
    entry?: string;
    /** Working directory for the spawned process (default: process.cwd() —
     *  the monorepo root or a standalone game dir, where bunfig.toml's
     *  preload registers the ?raw/.wgsl/.css loaders). */
    cwd?: string;
    /** MCP_PORT pin; default is an OS-assigned free port. */
    port?: number;
    /** DOWNDRAFT_DETERMINISTIC=1 (fixed seed, paused render loop). */
    deterministic?: boolean;
    /** DOWNDRAFT_GPU value. Default: parent env, else "swiftshader". */
    gpu?: "auto" | "hardware" | "swiftshader";
    /** DOWNDRAFT_HEADED=1 — show the window instead of headless. */
    headed?: boolean;
    /** Extra env vars, applied last. */
    env?: Record<string, string>;
    /** Extra console-output patterns to ignore for getConsoleErrors(). */
    ignoreErrorPatterns?: RegExp[];
    /** Readiness budget in ms (default 90s). */
    timeoutMs?: number;
    /** Tee child stdout/stderr to this process's (default false). */
    mirrorOutput?: boolean;
}

export interface LaunchedGame {
    client: GameClient;
    process: ChildProcess;
    pid: number;
    port: number;
    /** The instance's bearer token (may be undefined when the launch raced
     *  the pid-file write; tools still work unless auth is required). */
    token?: string;
    /** JS-error-looking lines captured from the child's console output. */
    getConsoleErrors(): string[];
    /** SIGTERM the process group + /proc descendants, SIGKILL after 5s. */
    kill(): Promise<void>;
}

/** Find a free loopback TCP port (OS-assigned). */
export function findFreePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => (port ? resolvePort(port) : reject(new Error("no port assigned"))));
        });
        srv.on("error", reject);
    });
}

const DEFAULT_ERROR_PATTERNS = [
    /Uncaught/i,
    /TypeError:/,
    /ReferenceError:/,
    /SyntaxError:/,
    /RangeError:/,
    /WrongDocumentError:/,
    /is not a function/,
    /is not defined/,
    /cannot read propert/i,
    /REJECTED action/i,
    /GPU process exited unexpectedly/i,
    /WebGPU.*not available/i,
    /adapter request failed/i,
    /\[.*WorkerHost.*\]\s*[Ww]orker error:/i,
];

const DEFAULT_IGNORE_PATTERNS = [
    /ERROR:components\/services\/storage/,
    /ERROR:storage\/browser/,
    /Gtk-Message/,
    /deprecated.*session\.loadExtension/,
    /SandboxOriginDatabase/,
    /Failed to load module.*xapp-gtk3/,
    /Failed to delete the database/,
    /Could not open the quota database/,
    /WebSocket connection.*failed/,
    /gc.*does not exist/,
    /Physics re-initialized after panic/i,
    /Slow (tick|physics)/,
];

function isRealError(line: string, extraIgnorePatterns: RegExp[] = []): boolean {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*/g, "");
    if (!DEFAULT_ERROR_PATTERNS.some((p) => p.test(stripped))) return false;
    if (DEFAULT_IGNORE_PATTERNS.some((p) => p.test(stripped))) return false;
    return !extraIgnorePatterns.some((p) => p.test(stripped));
}

/** Collect all descendant PIDs of `rootPid` by walking /proc/<pid>/stat on
 *  Linux. Backup for helpers that called setsid and escaped the process
 *  group — the group signal alone would miss them. */
function collectDescendants(rootPid: number): number[] {
    const childrenOf = new Map<number, number[]>();
    try {
        for (const entry of readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            const pid = Number(entry);
            if (pid === rootPid) continue;
            try {
                const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
                const rparen = stat.lastIndexOf(")");
                if (rparen < 0) continue;
                const ppid = Number(stat.slice(rparen + 2).split(" ")[1]);
                if (ppid === rootPid || childrenOf.has(ppid)) {
                    const list = childrenOf.get(ppid) ?? [];
                    list.push(pid);
                    childrenOf.set(ppid, list);
                }
            } catch {
                // Process exited between readdir and read — ignore.
            }
        }
    } catch {
        return []; // /proc unavailable (non-Linux)
    }
    const result: number[] = [];
    const queue = [rootPid];
    while (queue.length) {
        const cur = queue.shift()!;
        (childrenOf.get(cur) ?? []).forEach((k) => {
            result.push(k);
            queue.push(k);
        });
    }
    return result;
}

/**
 * Launch a game on the native runtime (`bun <entry>`), wait for its MCP
 * endpoint to serve tools, and return a connected GameClient plus a kill()
 * that tears down the whole process tree (detached group kill + /proc
 * descendant sweep — the game must not outlive the caller).
 */
export async function launchGame(opts: LaunchGameOptions = {}): Promise<LaunchedGame> {
    const cwd = opts.cwd ?? process.cwd();
    const game = opts.game ?? "to-the-ocean";
    const entry = opts.entry
        ? resolve(cwd, opts.entry)
        : [
            resolve(cwd, "games", game, "src", "native-entry.ts"),
            resolve(cwd, "examples", game, "src", "native-entry.ts"),
            resolve(cwd, "src", "native-entry.ts"),
        ].find((p) => existsSync(p)) ?? resolve(cwd, "games", game, "src", "native-entry.ts");
    if (!existsSync(entry)) {
        throw new McpClientError(`Game entry not found: ${entry} (pass --entry or game:)`);
    }
    const port = opts.port ?? (await findFreePort());

    const env: Record<string, string> = {
        ...process.env,
        MCP_PORT: String(port),
        MCP_TIMEOUT_MS: String(DEFAULT_TIMEOUT_MS),
        DOWNDRAFT_GPU: opts.gpu ?? process.env.DOWNDRAFT_GPU ?? "swiftshader",
        ...(opts.deterministic ? { DOWNDRAFT_DETERMINISTIC: "1" } : {}),
        ...(opts.headed ? { DOWNDRAFT_HEADED: "1" } : {}),
        ...opts.env,
    };
    const proc = spawn("bun", [entry], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // New session → child is a process-group leader, so kill(-pid)
        // reaches helpers that get re-parented to init.
        detached: true,
    });
    const exited = new Promise<number | null>((res) => proc.once("exit", (code) => res(code)));

    // Capture console output lines to detect JS errors.
    const consoleErrors: string[] = [];
    const watchStream = (stream: NodeJS.ReadableStream | null, mirror: (s: string) => void) => {
        if (!stream) return;
        let buf = "";
        stream.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            buf += text;
            if (opts.mirrorOutput) mirror(text);
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            lines.forEach((line) => {
                if (isRealError(line, opts.ignoreErrorPatterns)) {
                    consoleErrors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
                }
            });
        });
    };
    watchStream(proc.stdout, (s) => process.stdout.write(s));
    watchStream(proc.stderr, (s) => process.stderr.write(s));

    const kill = async () => {
        const pid = proc.pid;
        const signalAll = (sig: NodeJS.Signals) => {
            if (pid) {
                try { process.kill(-pid, sig); } catch { /* group already gone */ }
                [pid, ...collectDescendants(pid)].forEach((p) => {
                    try { process.kill(p, sig); } catch { /* already dead */ }
                });
            } else {
                try { proc.kill(sig); } catch { /* already dead */ }
            }
        };
        signalAll("SIGTERM");
        try {
            await Promise.race([
                exited,
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
            ]);
        } catch {
            signalAll("SIGKILL");
            try { await exited; } catch { /* gone */ }
        }
    };

    // The token file (when required) is written synchronously at server
    // bind — poll briefly so callers don't race it.
    let token: string | undefined;
    {
        const tokenFile = join(mcpPortDir(), `${proc.pid}.token`);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && proc.exitCode === null) {
            if (existsSync(tokenFile)) {
                try { token = readFileSync(tokenFile, "utf8").trim() || undefined; } catch { /* retry */ }
                break;
            }
            // No token file → auth not required; don't wait for a file that
            // will never appear. But it also may just not be written yet —
            // the transport always writes one, so if the pid file exists
            // but the token doesn't, auth is genuinely off.
            if (existsSync(join(mcpPortDir(), String(proc.pid)))) break;
            await sleep(100);
        }
    }

    const client = await GameClient.connect({
        url: `http://localhost:${port}/mcp`,
        token,
        timeoutMs: opts.timeoutMs,
    }).catch(async (e) => { await kill(); throw e; });

    try {
        await client.waitForReady(opts.timeoutMs ?? 90_000, { proc });
    } catch (e) {
        await kill();
        throw e;
    }

    return {
        client,
        process: proc,
        pid: proc.pid ?? 0,
        port,
        token,
        getConsoleErrors: () => [...consoleErrors],
        kill,
    };
}
