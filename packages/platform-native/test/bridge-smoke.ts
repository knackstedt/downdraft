// Smoke test: native host + downdraft bridge + in-process MCP end-to-end.
// Run: bun run test/bridge-smoke.ts   (needs a display; xvfb-run works)
import { createNativeHost } from "../src/native-host";

const host = await createNativeHost({
  window: { title: "bridge-smoke", width: 320, height: 200 },
  appId: "dd-bridge-smoke",
  mcp: {},
});

const d = (globalThis as any).downdraft;
if (!d) throw new Error("downdraft bridge not installed");
console.log("[ok] bridge installed");

// ── saves ──
const ok = await d.saveGameState("smoke", JSON.stringify({ hp: 42, pos: [1, 2, 3] }));
console.log("[ok] saveGameState →", ok);
console.log("[ok] loadGameState →", await d.loadGameState("smoke"));
const slots = await d.listSaveSlots();
console.log("[ok] listSaveSlots →", slots.map((s: any) => s.slot ?? s.slotName));
await d.setSaveProperties("smoke", { label: "smoke test" });
console.log("[ok] getSaveProperties →", await d.getSaveProperties("smoke"));
await d.deleteGameState("smoke");
console.log("[ok] deleteGameState →", await d.loadGameState("smoke"));

// ── import cache ──
await d.importCacheSet("/models/test.glb", {
  settings: { quality: "high" }, sourceMtime: 1, sidecarMtime: 2, updatedAt: Date.now(),
});
console.log("[ok] importCacheGet →", await d.importCacheGet("/models/test.glb"));

// ── diagnostics ──
console.log("[ok] getDisplayInfo →", await d.getDisplayInfo());
console.log("[ok] getFeatureLog.rt →", (await d.getFeatureLog())?.rt);
console.log("[ok] processSnapshot.rss →", (await d.processSnapshot()).main?.rss > 0);
console.log("[ok] capturePage bytes →", (await d.capturePage())?.byteLength);

// ── MCP ──
const port = host.mcp!.port;
const health = await fetch(`http://127.0.0.1:${port}/mcp/health`);
console.log("[ok] /mcp/health →", health.status);
const rpc = async (method: string, params: any = {}) =>
  (await (await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })).json()) as any;
await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.0" },
});
const list = await rpc("tools/list");
console.log("[ok] tools/list →", list.result?.tools?.map((t: any) => t.name));
const shot = await rpc("tools/call", { name: "capture_screenshot", arguments: {} });
console.log("[ok] capture_screenshot →", JSON.stringify(shot.result ?? shot.error).slice(0, 120));

host.destroy();
console.log("SMOKE PASS");
process.exit(0);
