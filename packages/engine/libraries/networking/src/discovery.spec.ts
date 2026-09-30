// ============================================================================
// discovery.spec.ts — LanDiscovery over real UDP multicast. Uses a
// non-default group/port so parallel test runs don't cross-talk; skips when
// UDP multicast is unavailable (sandboxed CI).
// ============================================================================

import { describe, expect, test } from "bun:test";
import { LanDiscovery } from "./discovery";

const GROUP = "239.255.77.99";
const PORT = 47999;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LanDiscovery", () => {
  test("advertise → browse roundtrip over real multicast", async () => {
    const a = await LanDiscovery.create({ group: GROUP, port: PORT, intervalMs: 100 });
    const b = await LanDiscovery.create({ group: GROUP, port: PORT, intervalMs: 100 });
    if (!a || !b) return; // no UDP — skip

    const joined: string[] = [];
    b.onJoin((p) => joined.push(p.id));

    a.advertise({ id: "spec-host", app: "dd-spec", name: "Spec Lobby", port: 9100, meta: { mode: "coop" } });
    await sleep(800);

    const peers = b.browse();
    const found = peers.find((p) => p.id === "spec-host");
    expect(found?.name).toBe("Spec Lobby");
    expect(found?.port).toBe(9100);
    expect(found?.meta?.mode).toBe("coop");
    expect(found?.host.length).toBeGreaterThan(0);
    expect(joined).toContain("spec-host");

    // Self is never in the peer table.
    expect(a.browse().find((p) => p.id === "spec-host")).toBeUndefined();

    a.dispose(); b.dispose();
  }, 5000);

  test("peers expire after ttl", async () => {
    const a = await LanDiscovery.create({ group: GROUP, port: PORT, intervalMs: 100, ttlMs: 300 });
    const b = await LanDiscovery.create({ group: GROUP, port: PORT, intervalMs: 100, ttlMs: 300 });
    if (!a || !b) return;

    const left: string[] = [];
    b.onLeave((p) => left.push(p.id));

    a.advertise({ id: "spec-gone", app: "dd-spec2", name: "Bye", port: 1 });
    await sleep(500);
    a.stopAdvertising();
    a.dispose(); // no more beacons
    await sleep(700);
    b.tick(); // manual expiry pass
    expect(b.browse().find((p) => p.id === "spec-gone")).toBeUndefined();
    expect(left).toContain("spec-gone");
    b.dispose();
  }, 5000);
});
