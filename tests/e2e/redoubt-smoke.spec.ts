// ============================================================================
// redoubt-smoke.spec.ts — Phase 1 scaffold e2e for `apps/redoubt`.
//
// Boots the app through the standard MCP harness with an isolated daemon
// endpoint (REDOUBT_SOCK + REDOUBT_CONFIG_DIR under the e2e artifacts dir)
// and asserts:
//   - the app boots and exposes its MCP tools (daemon_status/daemon_rpc/ui_nav)
//   - ui_nav switches pages
//   - daemon autospawn: when the dev binary exists (cargo build in
//     apps/redoubt/daemon), daemon.status RPCs return real data
//
// `draft test --app redoubt` runs this. SwiftShader-safe (2D, damageOnly).
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appAvailable, launchApp, parseJsonContent, sleep, type AppProcess } from "./harness";

const APP = "redoubt";
const appDir = resolve(import.meta.dir, "..", "..", "apps", APP);
const daemonBin = join(appDir, "daemon", "target", "debug", "redoubtd");
const testRoot = "/var/tmp/redoubt-e2e";
const sockPath = join(testRoot, "daemon.sock");
const configDir = join(testRoot, "config");
const dataDir = join(testRoot, "data");

let app: AppProcess;

describe.skipIf(!appAvailable(APP))("redoubt", () => {
    beforeAll(async () => {
        mkdirSync(testRoot, { recursive: true });
        app = await launchApp({
            app: APP,
            extraEnv: {
                REDOUBT_SOCK: sockPath,
                REDOUBT_CONFIG_DIR: configDir,
                REDOUBT_DATA_DIR: dataDir,
                REDOUBTD_BIN: existsSync(daemonBin) ? daemonBin : "",
                DD_DIALOGS_MOCK: "1",
            },
            ignoreErrorPatterns: [/adapter request failed/i],
        });
    }, 60_000);

    afterAll(async () => {
        await app?.kill();
        const errors = app?.getConsoleErrors() ?? [];
        expect(errors).toEqual([]);
    });

    it("exposes the app MCP tools", async () => {
        const names = (await app.mcpClient.listTools()).map((t) => t.name);
        ["daemon_status", "daemon_rpc", "ui_nav"].forEach((t) => {
            expect(names).toContain(t);
        });
    });

    it("navigates pages via ui_nav", async () => {
        const r = parseJsonContent(await app.mcpClient.callTool("ui_nav", { page: "plans" }));
        expect(r.page).toBe("plans");
    });

    it("reports daemon link state", async () => {
        // ensureDaemon is async (connect → autospawn → reconnect) — poll for
        // the link rather than asserting at MCP-ready time.
        let s: any;
        const deadline = Date.now() + 15_000;
        do {
            s = parseJsonContent(await app.mcpClient.callTool("daemon_status", {}));
            if (s.connected) break;
            await sleep(250);
        } while (Date.now() < deadline);
        expect(typeof s.connected).toBe("boolean");
        if (existsSync(daemonBin)) {
            expect(s.connected).toBe(true);
            expect(s.status.version).toBeTruthy();
        }
    });

    it("answers daemon.list RPCs when the daemon is up", async () => {
        if (!existsSync(daemonBin)) return;
        const r = parseJsonContent(await app.mcpClient.callTool("daemon_rpc", { method: "plan.list" }));
        expect(r.ok).toBe(true);
        expect(Array.isArray(r.result)).toBe(true);
    });
});
