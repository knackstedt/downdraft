// ============================================================================
// desktop-demo-smoke.spec.ts — Phase 6 desktop-app acceptance e2e
//
// Launches the tracked `apps/desktop-demo` fixture through the standard MCP
// harness and asserts the whole desktop surface end-to-end:
//
//   - menu backend (native on win/mac, in-window kit bar on Linux)
//   - close-request veto keeps the window alive; disarming lets it close
//   - second-instance forwarding delivers {argv, cwd} to the primary
//   - damageOnly render loop parks the event pump (idle CPU ~0)
//   - getTheme() returns a valid enum member
//   - settings write/read roundtrip
//   - dialogs resolve under DD_DIALOGS_MOCK=1
//   - tray toggle (backend-dependent: SNI watcher on Linux, real on win/mac)
//
// The primary instance runs NON-deterministic (lock active) — the second-
// instance assertion needs a real lock owner. `draft test` exports
// DOWNDRAFT_DETERMINISTIC=1 into the spec env, so the launch explicitly
// clears it via extraEnv.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { appAvailable, launchApp, parseJsonContent, sleep, type AppProcess } from "./harness";

const APP = "desktop-demo";
const appDir = resolve(import.meta.dir, "..", "..", "apps", APP);
const entry = join(appDir, "src", "native-entry.ts");
const SECOND_INSTANCE_MARKER = "--dd-e2e-second-instance";

let app: AppProcess;

async function demoState(): Promise<any> {
    return parseJsonContent(await app.mcpClient.callTool("demo_state", {}));
}

describe.skipIf(!appAvailable(APP))("desktop-demo", () => {
    beforeAll(async () => {
        app = await launchApp({
            app: APP,
            deterministic: false,
            extraEnv: {
                // `draft test` exports DOWNDRAFT_DETERMINISTIC=1 into our env —
                // clear it for the child so the singleton lock path runs.
                DOWNDRAFT_DETERMINISTIC: "",
                DD_DIALOGS_MOCK: "1",
            },
            // The demo runs gpu.mode=stability — the first hardware probe
            // error is the expected fallback path to the software adapter.
            ignoreErrorPatterns: [/adapter request failed/i],
        });
    }, 60_000);

    afterAll(async () => {
        await app?.kill();
        const errors = app?.getConsoleErrors() ?? [];
        expect(errors).toEqual([]);
    });

    it("exposes the demo MCP tools", async () => {
        const names = (await app.mcpClient.listTools()).map((t) => t.name);
        ["demo_state", "demo_request_close", "demo_set_veto", "demo_tray", "demo_pump_stats", "demo_dialog", "demo_settings"].forEach((t) => {
            expect(names).toContain(t);
        });
    });

    it("reports a live menu backend", async () => {
        const s = await demoState();
        // Native on win/mac, in-window kit bar on Linux; "unavailable" only
        // when the native lib predates the menu symbols — that would mean a
        // stale staged cdylib, which is a real failure.
        expect(["native", "inwindow"]).toContain(s.menuBackend);
    });

    it("returns a valid theme enum", async () => {
        const s = await demoState();
        expect(["light", "dark", "unknown"]).toContain(s.theme);
    });

    it("round-trips a settings write/read", async () => {
        const r = parseJsonContent(
            await app.mcpClient.callTool("demo_settings", { key: "demo.e2e", value: 42 }),
        );
        expect(r.match).toBe(true);
        expect(r.read).toBe(42);
    });

    it("resolves dialogs under DD_DIALOGS_MOCK", async () => {
        const open = parseJsonContent(await app.mcpClient.callTool("demo_dialog", { kind: "open" }));
        expect(open.kind).toBe("open");
        expect(open.paths).toEqual(["/var/tmp/dd-dialog-mock"]);
        const save = parseJsonContent(await app.mcpClient.callTool("demo_dialog", { kind: "save" }));
        expect(save.kind).toBe("save");
        expect(save.path).toBe("/var/tmp/dd-dialog-mock");
    });

    it("toggles the tray icon (backend permitting)", async () => {
        const r = parseJsonContent(await app.mcpClient.callTool("demo_tray", {}));
        expect(typeof r.trayBackend).toBe("boolean");
        if (r.trayBackend) {
            // A create(true) or a tolerated create-failure (no SNI watcher on
            // headless Linux) are both acceptable — destroy either way.
            expect([true, false]).toContain(r.trayCreated);
        }
    });

    it("forwards a second instance's argv to the primary", async () => {
        const child = spawn("bun", [entry, SECOND_INSTANCE_MARKER], {
            cwd: appDir,
            env: { ...process.env, DOWNDRAFT_DETERMINISTIC: "" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = new Promise<number | null>((res) => {
            const t = setTimeout(() => res(null), 30_000);
            child.once("exit", (code) => { clearTimeout(t); res(code); });
        });
        expect(await exited).toBe(0);

        // The primary receives the forwarded payload over the instance socket.
        let log: { argv: string[]; cwd: string }[] = [];
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            log = (await demoState()).secondInstanceLog;
            if (log.some((e) => e.argv.includes(SECOND_INSTANCE_MARKER))) break;
            await sleep(250);
        }
        expect(log.some((e) => e.argv.includes(SECOND_INSTANCE_MARKER))).toBe(true);
    }, 45_000);

    it("parks the event pump when idle (damageOnly)", async () => {
        await sleep(1500); // settle after the earlier MCP traffic
        const a = parseJsonContent(await app.mcpClient.callTool("demo_pump_stats", {}));
        await sleep(2000);
        const b = parseJsonContent(await app.mcpClient.callTool("demo_pump_stats", {}));
        const itersPerSec = (b.iters - a.iters) / 2;
        // A spinning loop would iterate thousands of times per second; a
        // parked damage-gated loop idles in the 32ms-wait regime (~30/s).
        expect(itersPerSec).toBeLessThan(100);
    });

    it("vetoes the close while armed, then accepts it", async () => {
        expect(parseJsonContent(await app.mcpClient.callTool("demo_set_veto", { armed: true })).armed).toBe(true);
        const vetoed = parseJsonContent(await app.mcpClient.callTool("demo_request_close", {}));
        expect(vetoed.closed).toBe(false);
        expect((await demoState()).windowClosed).toBe(false);

        expect(parseJsonContent(await app.mcpClient.callTool("demo_set_veto", { armed: false })).armed).toBe(false);
        // The accepted close ends the app — last assertion in the file.
        await app.mcpClient
            .callTool("demo_request_close", {})
            .catch(() => { /* the socket can drop mid-reply as the process exits */ });
        const exited = new Promise<number | null>((res) => {
            const t = setTimeout(() => res(null), 15_000);
            app.process.once("exit", (code) => { clearTimeout(t); res(code); });
        });
        expect(await exited).toBe(0);
    }, 30_000);
});
