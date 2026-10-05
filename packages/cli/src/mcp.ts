// ============================================================================
// draft mcp — one-shot client for a running game's MCP automation endpoint.
//
//   draft mcp instances                     # live game instances
//   draft mcp tools                         # tools/list (name<TAB>description)
//   draft mcp tools --schema <name>         # one tool's inputSchema
//   draft mcp call <tool> [json-args]       # tools/call, text on stdout
//   draft mcp screenshot <file.png>         # capture_screenshot → file
//   draft mcp run <script.ts> [-- args]     # launch game → run script → kill
//   draft mcp stdio                         # stdio→HTTP JSON-RPC bridge
//
// Output contract: payload on stdout, diagnostics on stderr.
//   exit 0 = ok, 1 = tool/transport/usage error (ArgError is caught by
//   index.ts and exits 1, same as every other draft command).
// Text output is capped at --max-bytes (default 256 KiB); image/binary
// blocks never print inline — use --out <file>.
// ============================================================================

import {
    GameClient,
    launchGame,
    listGameInstances,
    type GameClientOptions,
    type MCPToolResult
} from "@downdraft/engine/mcp/client";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ArgError, parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const DEFAULT_MAX_BYTES = 256 * 1024;

interface McpFlags {
    app: string;
    pid: number;
    url: string;
    token: string;
    editor: boolean;
    json: boolean;
    out: string;
    maxBytes: number;
    schema: string;
    game: string;
    entry: string;
    headed: boolean;
    gpu: string;
    deterministic: boolean;
    port: number;
    timeout: number;
}

function selectorFrom(f: McpFlags): GameClientOptions {
    return {
        appId: f.app || undefined,
        pid: f.pid || undefined,
        url: f.url || undefined,
        token: f.token || undefined,
        endpoint: f.editor ? "editor" : undefined,
        timeoutMs: f.timeout || undefined,
    };
}

/** Print text content to stdout, capped at maxBytes with a stderr notice. */
function printCapped(text: string, maxBytes: number): void {
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes) {
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
        return;
    }
    process.stdout.write(buf.subarray(0, maxBytes).toString("utf8"));
    process.stderr.write(`draft-mcp: truncated ${buf.length - maxBytes} bytes (--max-bytes to adjust)\n`);
}

/** Image/binary blocks are never printed inline — describe or write them. */
function writeBinaryBlocks(result: MCPToolResult, outPath: string): void {
    let i = 0;
    for (let _i = 0, _it = result.content ?? [], _n = _it.length; _i < _n; _i++) { const c = _it[_i];
        if (c.type !== "image") continue;
        const name = i === 0 ? outPath : `${outPath}.${i}`;
        mkdirSync(dirname(resolve(name)), { recursive: true });
        writeFileSync(name, Buffer.from(c.data, "base64"));
        process.stderr.write(`draft-mcp: wrote ${name} (${c.mimeType}, ${Buffer.from(c.data, "base64").length} bytes)\n`);
        i++;
    }
}

function printResult(result: MCPToolResult, f: McpFlags): void {
    if (f.out) writeBinaryBlocks(result, f.out);

    if (f.json) {
        // Raw envelope, with image data elided to a size marker unless --out
        // already captured the bytes to disk.
        const elided = {
            ...result,
            content: (result.content ?? []).map((c) =>
                c.type === "image" && !f.out
                    ? { type: "image", mimeType: c.mimeType, bytes: Buffer.from(c.data, "base64").length }
                    : c,
            ),
        };
        printCapped(JSON.stringify(elided, null, 2), f.maxBytes);
        if (result.isError) process.exit(1);
        return;
    }

    if (result.isError) {
        (result.content ?? []).forEach((c) => {
            if (c.type === "text") process.stderr.write(c.text + "\n");
        });
        process.exit(1);
    }
    const textBlocks = (result.content ?? []).filter((c) => c.type === "text");
    if (textBlocks.length > 0) {
        printCapped(textBlocks.map((c) => ("text" in c ? c.text : "")).join("\n"), f.maxBytes);
    }
    // Non-text blocks that weren't written via --out get a one-line marker.
    (result.content ?? []).forEach((c) => {
        if (c.type === "image") {
            const bytes = Buffer.from(c.data, "base64").length;
            process.stderr.write(`draft-mcp: [image ${c.mimeType}: ${bytes} bytes${f.out ? " → file" : " — pass --out <file>"}]\n`);
        }
    });
}

/** stdio→HTTP bridge: newline-delimited JSON-RPC on stdin forwarded to the
 *  game's HTTP transport. Replaces .devin/mcp-stdio-bridge.mjs. */
async function stdioBridge(sel: GameClientOptions): Promise<void> {
    const client = await GameClient.connect(sel);
    process.stderr.write(`draft-mcp: stdio bridge → ${client.url}\n`);

    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) void handleLine(line);
        }
    });
    process.stdin.on("end", () => process.exit(0));

    async function handleLine(line: string): Promise<void> {
        let msg: { id?: number | string; method: string; params?: Record<string, unknown> };
        try {
            msg = JSON.parse(line);
        } catch {
            write({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Parse error" } });
            return;
        }
        // Notifications (no id) — ignore, don't respond.
        if (msg.id === undefined || msg.id === null) return;
        try {
            let result: unknown;
            if (msg.method === "resources/list") result = { resources: [] };
            else if (msg.method === "prompts/list") result = { prompts: [] };
            else if (msg.method === "shutdown") result = {};
            else result = await client.request(msg.method, msg.params ?? {});
            write({ jsonrpc: "2.0", id: msg.id, result });
        } catch (e) {
            write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } });
        }
    }
    function write(obj: unknown): void {
        process.stdout.write(JSON.stringify(obj) + "\n");
    }
}

/** draft mcp run <script> — launch a game, run the script with a connected
 *  client available via env (DOWNDRAFT_MCP_URL / DOWNDRAFT_MCP_TOKEN), then
 *  kill the game. Propagates the script's exit code. */
async function runScript(script: string, scriptArgs: string[], f: McpFlags): Promise<void> {
    const launched = await launchGame({
        game: f.game || undefined,
        entry: f.entry || undefined,
        headed: f.headed,
        deterministic: f.deterministic,
        gpu: (f.gpu || undefined) as "auto" | "hardware" | "swiftshader" | undefined,
        port: f.port || undefined,
        mirrorOutput: true,
    });
    process.stderr.write(`draft-mcp: game up on MCP port ${launched.port} (pid ${launched.pid})\n`);
    // NB: process.exit() must run AFTER launched.kill() — inside try/finally
    // it would terminate before the finally block executes.
    const child = spawn("bun", [script, ...scriptArgs], {
        cwd: process.cwd(),
        stdio: "inherit",
        env: {
            ...process.env,
            DOWNDRAFT_MCP_URL: `http://localhost:${launched.port}/mcp`,
            ...(launched.token ? { DOWNDRAFT_MCP_TOKEN: launched.token } : {}),
            DOWNDRAFT_MCP_PID: String(launched.pid),
        },
    });
    const code = await new Promise<number>((res) => {
        child.on("exit", (c) => res(c ?? 1));
        child.on("error", (e) => { process.stderr.write(`draft-mcp: ${e.message}\n`); res(1); });
    });
    await launched.kill();
    const errs = launched.getConsoleErrors();
    if (errs.length > 0) {
        process.stderr.write(`draft-mcp: ${errs.length} console error(s) in game output:\n`);
        for (const e of errs.slice(0, 20)) process.stderr.write(`  ${e}\n`);
    }
    process.exit(code);
}

export async function mcp(argv: string[]): Promise<void> {
    const entry = getCommand("mcp")!;
    const parsed = parseArgs(argv, entry.schema);
    if (parsed.help) {
        print(renderHelp(entry.usage, entry.schema));
        return;
    }

    const f: McpFlags = {
        app: parsed.flags.app as string,
        pid: parsed.flags.pid as number,
        url: parsed.flags.url as string,
        token: parsed.flags.token as string,
        editor: parsed.flags.editor as boolean,
        json: parsed.flags.json as boolean,
        out: parsed.flags.out as string,
        maxBytes: (parsed.flags["max-bytes"] as number) || DEFAULT_MAX_BYTES,
        schema: parsed.flags.schema as string,
        game: parsed.flags.game as string,
        entry: parsed.flags.entry as string,
        headed: parsed.flags.headed as boolean,
        gpu: parsed.flags.gpu as string,
        deterministic: parsed.flags.deterministic as boolean,
        port: parsed.flags.port as number,
        timeout: parsed.flags.timeout as number,
    };

    const [action, ...rest] = parsed.positionals;
    if (!action) throw new ArgError("Missing required positional: <action>");

    switch (action) {
        case "instances": {
            let insts = listGameInstances({ appId: f.app || undefined });
            if (f.editor) insts = insts.filter((i) => i.editorPort !== undefined);
            if (insts.length === 0) {
                process.stderr.write("draft-mcp: no running instances\n");
                return;
            }
            insts.forEach((i) => {
                print(`${i.pid}\t${i.port ?? "-"}\t${i.appId ?? "-"}\t${i.editorPort ?? "-"}`);
            });
            return;
        }

        case "tools": {
            const client = await GameClient.connect(selectorFrom(f));
            if (f.schema) {
                const tools = await client.listTools();
                const tool = tools.find((t) => t.name === f.schema);
                if (!tool) {
                    process.stderr.write(`draft-mcp: unknown tool "${f.schema}"\n`);
                    process.exit(1);
                }
                printCapped(JSON.stringify(tool.inputSchema, null, 2), f.maxBytes);
                return;
            }
            const tools = await client.listTools();
            tools.forEach((t) => {
                print(`${t.name}\t${t.description ?? ""}`);
            });
            return;
        }

        case "call": {
            const [toolName, jsonArgs] = rest;
            if (!toolName) throw new ArgError("draft mcp call requires <tool> [json-args]");
            let args: Record<string, unknown> = {};
            if (jsonArgs) {
                try {
                    args = JSON.parse(jsonArgs);
                } catch (e) {
                    throw new ArgError(`invalid JSON arguments: ${(e as Error).message}`);
                }
            }
            const client = await GameClient.connect(selectorFrom(f));
            const result = await client.call(toolName, args, { timeoutMs: f.timeout || undefined });
            printResult(result, f);
            return;
        }

        case "screenshot": {
            const [file] = rest;
            if (!file) throw new ArgError("draft mcp screenshot requires <file.png>");
            const client = await GameClient.connect(selectorFrom(f));
            let shotArgs: Record<string, unknown> = {};
            if (rest[1]) {
                try {
                    shotArgs = JSON.parse(rest[1]);
                } catch (e) {
                    throw new ArgError(`invalid JSON arguments: ${(e as Error).message}`);
                }
            }
            const meta = await client.screenshot(file, shotArgs);
            print(`wrote ${file} (${meta.width}x${meta.height})`);
            return;
        }

        case "stdio": {
            await stdioBridge(selectorFrom(f));
            // Bridge runs until stdin closes — keep the process alive.
            await new Promise(() => {});
            return;
        }

        case "run": {
            const [script, ...scriptArgs] = rest;
            if (!script) throw new ArgError("draft mcp run requires <script.ts>");
            await runScript(resolve(script), scriptArgs, f);
            return;
        }

        default:
            throw new ArgError(`Unknown mcp action: ${action} (instances | tools | call | screenshot | stdio | run)`);
    }
}
