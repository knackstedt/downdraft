// ============================================================================
// packaging-smoke-smoke.spec.ts — self-contained e2e smoke
//
// Launches the tracked `examples/packaging-smoke` fixture headless
// (DD_PACKAGING_SMOKE=1 — no window, no GPU) and asserts its worker/asset
// pipeline completes. Unlike the `games/<name>` specs (which require local
// clones of separate game repos), this spec runs in any checkout — it is the
// contributor-visible e2e path.
// ============================================================================

import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const gameDir = join(import.meta.dir, "..", "..", "examples", "packaging-smoke");

it("packaging-smoke fixture completes headless", () => {
    const r = spawnSync("bun", ["run", "src/native-entry.ts"], {
        cwd: gameDir,
        env: { ...process.env, DD_PACKAGING_SMOKE: "1" },
        encoding: "utf8",
        timeout: 60_000,
    });
    expect(r.stdout).toContain("DD_SMOKE_OK");
    expect(r.status).toBe(0);
});
