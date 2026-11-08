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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appAvailable, launchApp, parseJsonContent, sleep, type AppProcess } from "./harness";

const APP = "redoubt";
const appDir = resolve(import.meta.dir, "..", "..", "apps", APP);
const daemonBin = join(appDir, "daemon", "target", "debug", "redoubtd");
const testRoot = "/var/tmp/redoubt-e2e";
const sockPath = join(testRoot, "daemon.sock");
const configDir = join(testRoot, "config");
const dataDir = join(testRoot, "data");
const srcDir = join(testRoot, "src");
const repoDir = join(testRoot, "repo");
const restoreDir = join(testRoot, "restore");
// Pinned download lands under <dataDir>/bin — a pre-seeded local copy works
// too (resolver checks it before PATH/download).
const kopiaBin = join(dataDir, "bin", "kopia-0.23.1");

let app: AppProcess;

async function drpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const r = parseJsonContent(await app.mcpClient.callTool("daemon_rpc", { method, params }));
    return r;
}

async function waitJob(jobId: string, ms = 60_000): Promise<any> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const r = await drpc("job.list");
        const j = (r.result as any[]).find((x) => x.id === jobId);
        if (j && j.state !== "running" && j.state !== "queued") return j;
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
}

describe.skipIf(!appAvailable(APP))("redoubt", () => {
    beforeAll(async () => {
        mkdirSync(testRoot, { recursive: true });
        // Kill stray redoubtd from earlier runs — autospawned daemons are
        // detached and outlive the app, and a stale daemon on the shared
        // socket path would serve stale state.
        const { spawnSync } = await import("node:child_process");
        spawnSync("bash", ["-c", "for pid in $(pgrep -x redoubtd); do kill \"$pid\" 2>/dev/null; done"]);
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

    // ── Phase 2: real filesystem-repo backup roundtrip (gated on kopia) ──

    it("runs a full backup → snapshot → restore roundtrip", async () => {
        if (!existsSync(daemonBin)) return;
        // Ensure kopia resolves — bins.ensure downloads the pinned build when
        // nothing is on PATH (needs network; a seeded copy skips it).
        let r = await drpc("bins.status");
        if (!r.result.tools[0].path) {
            r = await drpc("bins.ensure");
            const j = await waitJob(r.result.jobId, 120_000);
            expect(j.state).toBe("done");
        }

        mkdirSync(srcDir, { recursive: true });
        writeFileSync(join(srcDir, "hello.txt"), "e2e-payload-1");
        mkdirSync(join(srcDir, "sub"), { recursive: true });
        writeFileSync(join(srcDir, "sub", "deep.txt"), "e2e-payload-2");
        // Idempotent across runs — kopia refuses to init a repo over existing
        // data, and a previous run may have populated the dir.
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(restoreDir, { recursive: true, force: true });
        mkdirSync(repoDir, { recursive: true });
        // The daemon may also hold a repo with this location from a prior run —
        // wipe its view by deleting the config (fresh daemon reads empty).
        rmSync(join(configDir, "config.toml"), { force: true });

        r = await drpc("repo.create", {
            name: "e2e-repo", passphrase: "e2e-pass",
            location: { provider: "filesystem", path: repoDir },
        });
        expect(r.error ?? null).toBe(null);
        expect(r.ok).toBe(true);
        const repoId = r.result.id;

        r = await drpc("repo.passwordVerify", { id: repoId, passphrase: "e2e-pass" });
        expect(r.result.ok).toBe(true);
        r = await drpc("repo.passwordVerify", { id: repoId, passphrase: "nope" });
        expect(r.result.ok).toBe(false);

        r = await drpc("plan.create", {
            id: "", name: "e2e-plan",
            sources: [{ path: srcDir, excludeProfileId: "default", extraExcludes: [] }],
            repositoryId: repoId,
            retention: { minCount: 3, maxAgeDays: null },
            enabled: true, schedule: null,
        });
        const planId = r.result.id;

        r = await drpc("plan.runNow", { id: planId });
        const job = await waitJob(r.result.jobId);
        expect(job.state).toBe("done");
        expect(job.result.snapshots.length).toBe(1);

        r = await drpc("snapshot.list", { planId });
        expect(r.ok).toBe(true);
        expect(r.result.length).toBeGreaterThanOrEqual(1);
        const snapId = r.result[0].id;

        r = await drpc("snapshot.restore", { repositoryId: repoId, snapshotId: snapId, targetDir: restoreDir });
        const rj = await waitJob(r.result.jobId);
        expect(rj.state).toBe("done");
        expect(readFileSync(join(restoreDir, "hello.txt"), "utf8")).toBe("e2e-payload-1");
        expect(readFileSync(join(restoreDir, "sub", "deep.txt"), "utf8")).toBe("e2e-payload-2");
    }, 180_000);
});
