// audit-wasm-bun.ts — Phase 0 audit: verify every WASM dependency the engine
// loads actually instantiates and runs under Bun/JSC.
//
// Run: bun run scripts/audit-wasm-bun.ts
//
// Covered: rapier3d-compat, recast-navigation, @bokuweb/zstd-wasm,
// xxhash-wasm, @h00w/basis-universal-transcoder, ktx2-encoder deps
// (meshoptimizer), and a note on the pure-TS libraries (marching-cubes,
// surface-nets) which have no wasm at all.

interface Result {
    name: string;
    ok: boolean;
    detail: string;
}

const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
    try {
        const detail = await fn();
        results.push({ name, ok: true, detail });
    } catch (err) {
        results.push({ name, ok: false, detail: String(err) });
    }
}

// ── Rapier WASM (physics-rapier backend) ──
await check("@dimforge/rapier3d-compat", async () => {
    const rapier = await import("@dimforge/rapier3d-compat");
    const origWarn = console.warn;
    console.warn = () => {};
    try { await rapier.init(); } finally { console.warn = origWarn; }
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    world.step();
    world.free();
    return "init + World.step OK";
});

// ── recast-navigation (navmesh) ──
await check("recast-navigation", async () => {
    const mod = await import("recast-navigation");
    await mod.init();
    const { generateSoloNavMesh } = await import("recast-navigation/generators");
    // Flat 2-triangle quad.
    // Flat 10×10m quad — plain number[] like the engine callers use.
    const positions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
    const indices = [0, 2, 1, 0, 3, 2]; // +Y-facing winding (recast needs up-facing tris)
    const result = generateSoloNavMesh(positions, indices, {
        cs: 0.3, ch: 0.2,
        walkableSlopeAngle: 45, walkableHeight: 2, walkableClimb: 0.4, walkableRadius: 0.4,
    });
    if (!result.success) throw new Error(`generateSoloNavMesh: ${result.error}`);
    return `init + navmesh gen OK (${result.navMesh ? "mesh built" : "no mesh"})`;
});

// ── zstd-wasm (save compression) ──
await check("@bokuweb/zstd-wasm", async () => {
    const { init, compress, decompress } = await import("@bokuweb/zstd-wasm");
    await init();
    const input = new TextEncoder().encode("downdraft ".repeat(100));
    const packed = compress(input, 3);
    const back = decompress(packed, input.length);
    if (back.length !== input.length || back[0] !== input[0]) throw new Error("round-trip mismatch");
    return `compress/decompress OK (${input.length}B → ${packed.length}B)`;
});

// ── xxhash-wasm (hashing) ──
await check("xxhash-wasm", async () => {
    const mod: any = await import("xxhash-wasm");
    const api = typeof mod.default === "function" ? await mod.default() : mod;
    const h = api.h64("downdraft").toString(16);
    return `h64 OK (0x${h})`;
});

// ── basis-universal-transcoder (KTX2 decode) ──
await check("@h00w/basis-universal-transcoder", async () => {
    const mod = await import("@h00w/basis-universal-transcoder");
    const { BasisUniversal } = mod as any;
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@h00w/basis-universal-transcoder/package.json");
    const wasmPath = path.join(path.dirname(pkgPath), "dist", "basis_capi_transcoder.wasm");
    const bytes = fs.readFileSync(wasmPath);
    const instance = await BasisUniversal.getInstance((imports: WebAssembly.Imports) =>
        WebAssembly.instantiate(bytes, imports));
    if (typeof instance.createKTX2Transcoder !== "function") throw new Error("no createKTX2Transcoder");
    return "wasm instantiate + getInstance OK (transcode path not exercised — needs KTX2 fixture)";
});

// ── meshoptimizer (asset-bake / gltf-transform dep, ktx2 pipeline) ──
await check("meshoptimizer", async () => {
    const { MeshoptEncoder } = await import("meshoptimizer");
    await MeshoptEncoder.ready;
    const src = new Uint8Array(256);
    for (let i = 0; i < 256; i++) src[i] = i;
    const out = MeshoptEncoder.encodeVertexBuffer(src, 16, 16, 4, "ATTRIBUTES");
    return `encodeVertexBuffer OK (${out.length}B)`;
});

// ── Pure-TS libraries (no wasm, listed for completeness) ──
await check("marching-cubes / surface-nets (pure TS)", async () => {
    const mc = await import("../packages/engine/libraries/marching-cubes/src/index.ts");
    return typeof mc === "object" ? "module loads — pure TS, no wasm" : "module loads";
});

console.log(`WASM audit — Bun ${Bun.version} (JSC)\n`);
let failures = 0;
for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failures++;
    console.log(`${mark}  ${r.name.padEnd(42)} ${r.detail}`);
}
process.exit(failures === 0 ? 0 : 1);
