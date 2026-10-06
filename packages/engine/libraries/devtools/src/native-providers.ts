// ============================================================================
// native-providers.ts — engine-generic data providers for the native devtools
// panels. registerEngineProviders() wires collectors for every provider-fed
// panel against whatever data is reachable on the renderer + ProfilingSAB.
// Game-specific data registers separately via mirror.registerProvider("game").
// ============================================================================

import type { PanelCommandHandler, PanelName, PanelProvider } from "./snapshot";
import {
    type DevtoolsCommand,
    type PanelSnapshot,
    SNAP_FLAG,
    type SnapshotKvRow,
    type SnapshotSection,
} from "./snapshot";

/** Minimal provider-registration surface — satisfied by WebDevtoolsMirror
 *  (WS/JSON transport) and the docked Blitz devtools host. */
export interface DevtoolsProviderTarget {
    registerProvider(panel: PanelName | number, collect: PanelProvider): void;
    registerCommandHandler(panel: PanelName | number | "*", handler: PanelCommandHandler): void;
}

export interface EngineProviderContext {
    /** The game renderer / accessors (duck-typed — getters are probed). */
    renderer: any;
    /** ProfilingSAB for per-worker memory/thread stats. */
    profilingSAB?: SharedArrayBuffer | null;
    /** Module hosts for the Doctor panel: { sim?, renderer? }. */
    moduleHosts?: { sim?: any; renderer?: any };
    /** Names of registered worker eval targets (REPL threads). */
    evalTargetNames?: () => string[];
    /** Extra game-level input info for the Input panel. */
    inputInfo?: () => { key: string; value: string; flags?: number }[];
    /**
     * Sim worker devtools proxy (__devtoolsGetManifest/__devtoolsCallCommand)
     * plus optional sim control methods (pause/resume/setSimSpeed/...).
     */
    simProxy?: any;
}

const fmtBytes = (b: any): string => {
    const n = typeof b === "bigint" ? Number(b) : b;
    if (!n || !Number.isFinite(n) || n < 0) return String(b ?? "?");
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
};
const fmtMs = (v: number | undefined): string => `${(v ?? 0).toFixed(2)} ms`;
const num = (v: any): string => (typeof v === "bigint" ? v.toString() : String(v ?? 0));

const kv = (key: string, value: any, flags = 0): SnapshotKvRow => ({ key, value: String(value ?? "?"), flags });
const header = (key: string): SnapshotKvRow => ({ key, value: "", flags: SNAP_FLAG.header });

// ── ProfilingSAB reader (lazy, same pattern as mirror.ts) ──

let profilingMod: any = undefined;
async function loadProfiling(): Promise<any> {
    if (profilingMod !== undefined) return profilingMod;
    try {
        profilingMod = await import("@downdraft/engine/profiling");
    } catch {
        profilingMod = null;
    }
    return profilingMod;
}

// Cache the reader per SAB — a fresh ProfilingSABReader every call would
// re-parse the layout header and re-drain the whole warning ring each
// provider refresh.
let sabReader: { sab: SharedArrayBuffer; reader: any } | null = null;
async function sabReaderFor(sab: SharedArrayBuffer): Promise<any | null> {
    if (sabReader?.sab === sab) return sabReader.reader;
    const mod = await loadProfiling();
    if (!mod) return null;
    const layout = mod.profilingLayoutFromSab(sab);
    if (!layout) return null;
    sabReader = { sab, reader: new mod.ProfilingSABReader(sab, layout) };
    return sabReader.reader;
}

// Cached sim-worker devtools manifest — refreshed in the background so the
// Workers provider never blocks on a slow/hung worker RPC.
const manifestFetch: { pending: boolean; at: number; value: any; error: string | null } = {
    pending: false, at: 0, value: null, error: null,
};

async function readSabSlots(sab: SharedArrayBuffer | null | undefined): Promise<any[]> {
    if (!sab) return [];
    try {
        const reader = await sabReaderFor(sab);
        if (!reader) return [];
        return reader.readSnapshot().slots ?? [];
    } catch {
        return [];
    }
}

// ── Panel collectors ──

function collectSim(ctx: EngineProviderContext): PanelSnapshot {
    const r = ctx.renderer;
    const rows: SnapshotKvRow[] = [];
    const sim = r?.simReader ?? r?.getSimReader?.();
    const valid = !!sim?.isValid?.();
    rows.push(kv("Sim SAB", valid ? "connected" : "not connected", valid ? 0 : SNAP_FLAG.warn));
    if (valid) {
        try { rows.push(kv("Entities", num(sim.getEntityCount?.()))); } catch { /* */ }
        try {
            const players = sim.getPlayerCount?.();
            if (players != null) rows.push(kv("Players", num(players)));
        } catch { /* */ }
    }
    try {
        const pos = r?.getPlayerWorldPos?.(0);
        if (pos) rows.push(kv("Player pos", `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`));
    } catch { /* */ }
    try {
        const boats = r?.getBoatReader?.();
        if (boats) {
            const c = boats.getBoatCount?.() ?? boats.count;
            if (c != null) rows.push(kv("Boats", num(c)));
        }
    } catch { /* */ }
    try {
        const water = r?.getWaterReader?.();
        if (water) rows.push(kv("Water reader", "connected"));
    } catch { /* */ }
    try {
        const ft = r?.getFrameTelemetry?.() ?? r?.telemetryCollector?.getFrameTelemetry?.();
        if (ft) {
            rows.push(header("Frame"));
            rows.push(kv("FPS", Math.round(ft.fps ?? 0)));
            rows.push(kv("Avg frame", fmtMs(ft.avgFrameTime)));
            rows.push(kv("P95", fmtMs(ft.p95)));
        }
    } catch { /* */ }
    const sections: SnapshotSection[] = [{ kind: "kv", name: "", rows }];
    if (ctx.simProxy) {
        sections.push({
            kind: "controls",
            name: "Sim controls",
            controls: [
                { type: "button", id: "sim.pause", label: "Pause" },
                { type: "button", id: "sim.resume", label: "Resume" },
                { type: "button", id: "sim.speed.0.25", label: "0.25×" },
                { type: "button", id: "sim.speed.0.5", label: "0.5×" },
                { type: "button", id: "sim.speed.1", label: "1×" },
                { type: "button", id: "sim.speed.2", label: "2×" },
                { type: "button", id: "sim.speed.4", label: "4×" },
            ],
        });
    }
    return { sections };
}

async function collectMemory(ctx: EngineProviderContext): Promise<PanelSnapshot> {
    const sections: SnapshotSection[] = [];
    const rows: SnapshotKvRow[] = [];

    // Main-thread memory (performance.memory where available; process.memoryUsage elsewhere).
    try {
        const pm = (performance as any)?.memory;
        if (pm) {
            rows.push(kv("JS heap used", fmtBytes(pm.usedJSHeapSize)));
            rows.push(kv("JS heap total", fmtBytes(pm.totalJSHeapSize)));
            if (pm.jsHeapSizeLimit) rows.push(kv("Heap limit", fmtBytes(pm.jsHeapSizeLimit)));
        }
    } catch { /* */ }
    try {
        const mu = (process as any)?.memoryUsage?.();
        if (mu) {
            rows.push(kv("RSS", fmtBytes(mu.rss)));
            rows.push(kv("External", fmtBytes(mu.external)));
            if (mu.arrayBuffers != null) rows.push(kv("ArrayBuffers", fmtBytes(mu.arrayBuffers)));
        }
    } catch { /* */ }
    // Per-worker heap/GC from ProfilingSAB.
    const slots = await readSabSlots(ctx.profilingSAB);
    if (slots.length > 0) {
        const table: string[][] = [];
        slots.forEach((s) => {
            const m = s.metrics ?? {};
            table.push([
                s.name || `slot-${s.slotIndex}`,
                fmtBytes(m.heapUsed),
                fmtBytes(m.heapTotal),
                `${((m.gcPauseMaxUs ?? 0) / 1000).toFixed(2)} ms`,
                `${((m.taskLatencyP95Us ?? 0) / 1000).toFixed(2)} ms`,
            ]);
        });
        sections.push({
            kind: "table",
            name: "Per-thread memory (ProfilingSAB)",
            cols: ["thread", "heap used", "heap total", "gc pause max", "task p95"],
            rows: table,
        });
    }

    // VRAM.
    try {
        const stats = ctx.renderer?.gpuResourceTracker?.getStats?.()
            ?? ctx.renderer?.getGPUResourceTracker?.()?.getStats?.();
        if (stats) {
            rows.push(header("VRAM"));
            rows.push(kv("Textures", `${stats.textureCount} (${fmtBytes(stats.textureBytes)})`));
            rows.push(kv("Buffers", `${stats.bufferCount} (${fmtBytes(stats.bufferBytes)})`));
            rows.push(kv("Total VRAM", fmtBytes(stats.totalBytes)));
        }
    } catch { /* */ }

    sections.unshift({ kind: "kv", name: "Main thread", rows });
    sections.push({
        kind: "controls",
        name: "Actions",
        controls: [{ type: "button", id: "gc", label: "Force GC" }],
    });
    return { sections };
}

function collectRenderGraph(ctx: EngineProviderContext): PanelSnapshot {
    const sections: SnapshotSection[] = [];
    const r = ctx.renderer;
    const profiler = r?.gpuProfiler ?? r?.getGPUProfiler?.();

    const timerSupported = profiler?.isGpuTimerSupported?.();
    if (timerSupported === false) {
        sections.push({
            kind: "lines",
            name: "",
            lines: [{ text: "GPU timestamp queries unsupported on this device — gpu times will be 0.", flags: SNAP_FLAG.warn }],
        });
    }

    try {
        const timings = profiler?.getPassTimings?.() ?? [];
        if (timings.length > 0) {
            sections.push({
                kind: "table",
                name: "Pass timings",
                cols: ["pass", "cpu ms", "gpu ms", "draws", "tris"],
                rows: timings.map((t: any) => [
                    t.name ?? "pass",
                    (t.cpuMs ?? 0).toFixed(2),
                    (t.gpuMs ?? 0).toFixed(2),
                    num(t.drawCalls),
                    num(t.triangles),
                ]),
            });
        } else {
            sections.push({ kind: "lines", name: "Pass timings", lines: [{ text: "(no passes recorded)" }] });
        }
    } catch (err) {
        sections.push({ kind: "lines", name: "Pass timings", lines: [{ text: String(err), flags: SNAP_FLAG.error }] });
    }

    try {
        const fg = r?.frameGraph ?? r?.getFrameGraph?.();
        const slots = fg?.getSlots?.() ?? fg?.getSlotRegistry?.()?.getAll?.() ?? [];
        if (slots.length > 0) {
            sections.push({
                kind: "table",
                name: "Frame graph slots",
                cols: ["slot", "detail"],
                rows: slots.map((s: any) => [
                    typeof s === "string" ? s : (s.name ?? s.label ?? "slot"),
                    typeof s === "string" ? "" : (s.detail ?? s.description ?? ""),
                ]),
            });
        }
    } catch { /* */ }

    try {
        const errors = profiler?.getGPUErrors?.() ?? r?.getGPUErrors?.() ?? [];
        if (errors.length > 0) {
            sections.push({
                kind: "lines",
                name: `GPU errors (${errors.length})`,
                lines: errors.slice(0, 50).map((e: any) => ({
                    text: e.message ?? String(e),
                    flags: SNAP_FLAG.error,
                })),
            });
            sections.push({
                kind: "controls",
                name: "",
                controls: [{ type: "button", id: "clear-gpu-errors", label: "Clear GPU errors" }],
            });
        }
    } catch { /* */ }

    return { sections };
}

function collectMaterials(ctx: EngineProviderContext): PanelSnapshot {
    const r = ctx.renderer;
    const lib = r?.materialLibrary ?? r?.getMaterialLibrary?.();
    if (!lib) {
        // Fall back to ModelRenderer stats — the bindless material table is
        // the de-facto material registry when no MaterialLibrary is wired.
        const mr = r?.modelRenderer ?? r?.getModelRenderer?.();
        if (!mr) {
            return {
                status: "unsupported",
                statusMsg: "no material library on renderer",
                sections: [{ kind: "lines", name: "", lines: [{ text: "No MaterialLibrary or ModelRenderer — renderer did not expose either." }] }],
            };
        }
        try {
            const models = (mr as any).modelResources as Map<string, any> | undefined;
            const matIdx = (mr as any).meshMaterialIndex as Map<string, any> | undefined;
            const instOffsets = (mr as any).modelInstanceOffsets as Map<string, any[]> | undefined;
            const registry = (mr as any).bindless?.registry;
            const buckets = registry?.buckets as Map<string, any> | undefined;
            let texCount = 0;
            // oxlint-disable-next-line downdraft/no-for-of -- iterates never[] | MapIterator<any>; for..of required
            for (const b of buckets?.values?.() ?? []) texCount += b?.sources?.size ?? 0;
            const rows: SnapshotKvRow[] = [
                kv("Material slots", matIdx?.size ?? "?"),
                kv("Bindless textures", buckets ? texCount : "?"),
                kv("Bindless buckets", buckets?.size ?? "?"),
                kv("Texture pages", registry?.nextGlobalArrayIndex ?? "?"),
                kv("Models", models?.size ?? 0),
                header("Per-model"),
            ];
            const table: string[][] = [];
            // oxlint-disable-next-line downdraft/no-for-of -- iterates MapIterator via `?? []`; for..of required
            for (const [id] of models?.entries() ?? []) {
                const instances = instOffsets?.get(id)?.length ?? 0;
                table.push([id, num(instances)]);
            }
            const sections: SnapshotSection[] = [{ kind: "kv", name: "ModelRenderer materials", rows }];
            if (table.length > 0) {
                sections.push({ kind: "table", name: "Models", cols: ["id", "instances"], rows: table });
            }
            return { sections };
        } catch (err) {
            return { status: "error", statusMsg: String(err), sections: [] };
        }
    }
    const rows: SnapshotKvRow[] = [];
    try {
        const all = lib.getAll?.() ?? [...(lib as any).materials?.values?.() ?? []];
        rows.push(kv("Materials", all.length));
        // Aggregate simple stats across materials.
        let pipelines = 0;
        let shaders = 0;
        const types = new Map<string, number>();
        all.forEach((m: any) => {
            const t = (m as any).type ?? (m as any).kind ?? "material";
            types.set(t, (types.get(t) ?? 0) + 1);
            if ((m as any).pipeline) pipelines++;
            if ((m as any).shaderModule || (m as any).shader) shaders++;
        });
        rows.push(kv("Pipelines", pipelines));
        rows.push(kv("Shader modules", shaders));
        for (const [t, c] of types.entries()) rows.push(kv(`  ${t}`, c));
        if (all.length > 0) {
            return {
                sections: [
                    { kind: "kv", name: "", rows },
                    {
                        kind: "table",
                        name: "Materials",
                        cols: ["name", "type", "flags"],
                        rows: all.slice(0, 200).map((m: any) => [
                            m.name ?? "?",
                            m.type ?? m.kind ?? "",
                            [m.transparent ? "transparent" : "", m.doubleSided ? "doubleSided" : ""].filter(Boolean).join(" "),
                        ]),
                    },
                ],
            };
        }
    } catch (err) {
        rows.push(kv("Error", String(err), SNAP_FLAG.error));
    }
    return { sections: [{ kind: "kv", name: "", rows }] };
}

function collectDoctor(ctx: EngineProviderContext): PanelSnapshot {
    const sim = ctx.moduleHosts?.sim;
    const ren = ctx.moduleHosts?.renderer;
    if (!sim && !ren) {
        return {
            status: "unsupported",
            statusMsg: "no module hosts provided",
            sections: [{ kind: "lines", name: "", lines: [{ text: "No module hosts registered (moduleHosts option)." }] }],
        };
    }
    const info = (host: any, thread: string): any[] => {
        if (!host) return [];
        try {
            const names: string[] = host.listModules?.() ?? [];
            const active: Map<string, any> = (host as any).active ?? new Map();
            return names.map((name) => {
                const mod = host.getModule?.(name) ?? {};
                return {
                    name,
                    version: mod.version ?? "?",
                    thread,
                    provides: (mod.provides ?? []).map((t: any) => t.key ?? String(t)),
                    requires: (mod.requires ?? []).map((t: any) => t.key ?? String(t)),
                    active: active.has?.(name) ?? true,
                };
            });
        } catch {
            return [];
        }
    };
    const simModules = info(sim, "sim");
    const renModules = info(ren, "renderer");
    const modules = [...simModules, ...renModules];

    // Inline buildCrossThreadReport logic (avoids a hard core import cycle).
    const providedBy = new Map<string, string[]>();
    const required = new Set<string>();
    for (let _i = 0, _it = modules, _n = _it.length; _i < _n; _i++) { const m = _it[_i];
        if (!m.active) continue;
        m.provides.forEach((tok: any) => {
            const t = providedBy.get(tok) ?? [];
            if (!t.includes(m.thread)) t.push(m.thread);
            providedBy.set(tok, t);
        });
        m.requires.forEach((tok: any) => { required.add(tok);; });
    }
    const unresolved = [...required].filter((t) => !providedBy.has(t));
    const shared = [...providedBy.entries()].filter(([, t]) => t.length > 1).map(([k]) => k);
    const conflicts: string[] = [];
    const byName = new Map<string, { sim?: string; renderer?: string }>();
    simModules.forEach((m) => { if (m.active) byName.set(m.name, { ...byName.get(m.name), sim: m.version });; });
    renModules.forEach((m) => { if (m.active) byName.set(m.name, { ...byName.get(m.name), renderer: m.version });; });
    for (const [name, v] of byName.entries()) {
        if (v.sim && v.renderer && v.sim !== v.renderer) conflicts.push(`${name}: sim=${v.sim} renderer=${v.renderer}`);
    }

    const sections: SnapshotSection[] = [
        {
            kind: "kv",
            name: "Summary",
            rows: [
                kv("Sim modules", simModules.length),
                kv("Renderer modules", renModules.length),
                kv("Shared resources", shared.length),
                kv("Unresolved requires", unresolved.length, unresolved.length ? SNAP_FLAG.error : 0),
                kv("Version conflicts", conflicts.length, conflicts.length ? SNAP_FLAG.warn : 0),
            ],
        },
        {
            kind: "table",
            name: "Modules",
            cols: ["name", "ver", "thread", "provides", "requires", "active"],
            rows: modules.map((m) => [
                m.name, m.version, m.thread,
                m.provides.join(", ") || "-",
                m.requires.join(", ") || "-",
                m.active ? "yes" : "no",
            ]),
        },
    ];
    const issues: { text: string; flags: number }[] = [
        ...unresolved.map((t) => ({ text: `unresolved require: ${t}`, flags: SNAP_FLAG.error })),
        ...conflicts.map((c) => ({ text: `version conflict: ${c}`, flags: SNAP_FLAG.warn })),
    ];
    if (issues.length === 0) issues.push({ text: "No issues detected.", flags: 0 });
    sections.push({ kind: "lines", name: "Issues", lines: issues });
    return { sections };
}

async function collectWorkers(ctx: EngineProviderContext): Promise<PanelSnapshot> {
    const rows: string[][] = [];
    const slots = await readSabSlots(ctx.profilingSAB);
    slots.forEach((s) => {
        const m = s.metrics ?? {};
        rows.push([
            s.name || `slot-${s.slotIndex}`,
            s.runtime === 1 ? "wasm" : "js",
            `${(m.cpuPercent ?? 0).toFixed(1)}%`,
            fmtBytes(m.heapUsed),
        ]);
    });
    const evalTargets = ctx.evalTargetNames?.() ?? [];
    const sections: SnapshotSection[] = [];
    sections.push({
        kind: "table",
        name: "ProfilingSAB threads",
        cols: ["name", "runtime", "cpu", "heap"],
        rows,
    });
    sections.push({
        kind: "kv",
        name: "Eval targets",
        rows: evalTargets.length
            ? evalTargets.map((t) => kv(t, "registered"))
            : [kv("(none)", "register thread evals via debuggerScene.registerThreadEval")],
    });

    // Sim worker devtools manifest (panels, toggles, feeds, commands).
    // The RPC can be slow while the worker is busy, so it's fetched in the
    // background and the last cached result is rendered — the provider never
    // blocks on it.
    const dtProxy = ctx.simProxy?.__devtoolsGetManifest
        ? ctx.simProxy
        : ctx.simProxy?.getDevToolsProxy?.();
    if (dtProxy?.__devtoolsGetManifest) {
        if (!manifestFetch.pending && performance.now() - manifestFetch.at > 2000) {
            manifestFetch.pending = true;
            void Promise.resolve(dtProxy.__devtoolsGetManifest())
                .then((m: any) => { manifestFetch.value = m ?? null; manifestFetch.error = null; })
                .catch((err: any) => { manifestFetch.value = null; manifestFetch.error = String(err); })
                .finally(() => { manifestFetch.pending = false; manifestFetch.at = performance.now(); });
        }
        const m = manifestFetch.value;
        const mErr = manifestFetch.error;
        if (mErr) {
            sections.push({
                kind: "lines",
                name: "Worker manifest",
                lines: [{ text: `manifest fetch failed: ${mErr}`, flags: SNAP_FLAG.warn }],
            });
        }
        if (m) {
                sections.push({
                    kind: "kv",
                    name: `Worker manifest (v${m.manifestVersion ?? "?"})`,
                    rows: [
                        kv("Panels", (m.panels ?? []).map((p: any) => p.id ?? p.name ?? "?").join(", ") || "(none)"),
                        kv("Toggles", (m.toggles ?? []).map((t: any) => t.id ?? "?").join(", ") || "(none)"),
                        kv("Data feeds", (m.dataFeeds ?? []).map((f: any) => `${f.name}@${f.writeRateHz}hz`).join(", ") || "(none)"),
                        kv("Commands", (m.commands ?? []).join(", ") || "(none)"),
                    ],
                });
                const sabStats = m.sabStats ?? [];
                if (sabStats.length > 0) {
                    sections.push({
                        kind: "table",
                        name: "SAB stats",
                        cols: ["name", "value"],
                        rows: sabStats.slice(0, 100).map((s: any) => [
                            s.name ?? "?",
                            String(s.value ?? s.current ?? "?"),
                        ]),
                    });
                }
        }
    }
    return { sections };
}

function collectInput(ctx: EngineProviderContext): PanelSnapshot {
    const r = ctx.renderer;
    const rows: SnapshotKvRow[] = [];
    try {
        const router = r?.uiInputRouter ?? r?.getUIInputRouter?.();
        if (router) {
            rows.push(kv("UI input router", "present"));
            const w = router.wantsKeyboardInput?.() ?? router.wantsTextInput?.();
            if (w != null) rows.push(kv("UI wants text", w ? "yes" : "no"));
        }
    } catch { /* */ }
    try {
        const canvas = { w: r?.getCanvasWidth?.() ?? 0, h: r?.getCanvasHeight?.() ?? 0 };
        rows.push(kv("Canvas", `${canvas.w}×${canvas.h}`));
    } catch { /* */ }
    const extra = ctx.inputInfo?.() ?? [];
    extra.forEach((e) => { rows.push(kv(e.key, e.value, e.flags));; });
    if (rows.length === 0) rows.push(kv("(no game input info)", "register inputInfo()"));
    return { sections: [{ kind: "kv", name: "Game input", rows }] };
}

// PostFX: effects toggle list + sliders for the exposed numeric params.
const POSTFX_SLIDERS: { id: string; label: string; field: string; setter: string; min: number; max: number }[] = [
    { id: "bloom.threshold", label: "Bloom threshold", field: "bloomThreshold", setter: "setBloomThreshold", min: 0, max: 4 },
    { id: "bloom.strength", label: "Bloom strength", field: "bloomStrength", setter: "setBloomStrength", min: 0, max: 4 },
    { id: "dof.focus", label: "DOF focus dist", field: "dofFocusDist", setter: "setDOFFocusDist", min: 0, max: 500 },
    { id: "dof.range", label: "DOF focus range", field: "dofFocusRange", setter: "setDOFFocusRange", min: 0, max: 200 },
    { id: "dof.blur", label: "DOF max blur", field: "dofMaxBlur", setter: "setDOFMaxBlur", min: 0, max: 32 },
    { id: "afterimage.damp", label: "Afterimage damp", field: "afterimageDamp", setter: "setAfterimageDamp", min: 0, max: 1 },
    { id: "pixel.size", label: "Pixel size", field: "pixelationPixelSize", setter: "setPixelSize", min: 1, max: 32 },
    { id: "ssao.radius", label: "SSAO radius", field: "ssaoRadius", setter: "setSSAORadius", min: 0, max: 4 },
    { id: "ssr.steps", label: "SSR max steps", field: "ssrMaxSteps", setter: "setSSRMaxSteps", min: 1, max: 128 },
];

const POSTFX_EFFECTS = [
    "taa", "ssao", "ssr", "dof", "motion-blur",
    "bloom", "bloom-soft", "tonemap",
    "lut", "white-balance", "channel-mixer", "split-tone",
    "fxaa", "chromatic-aberration", "lens-distortion", "sharpen", "grain",
    "sobel", "edges", "lens-flare",
    "pixelation", "gaussian-blur", "afterimage",
    "halftone", "dithering", "watercolor",
    "outline", "highlight", "glow", "ascii",
];

function postfxStack(ctx: EngineProviderContext): any {
    const r = ctx.renderer;
    return r?.postProcessStack ?? r?.getPostProcessStack?.() ?? null;
}

function collectPostFx(ctx: EngineProviderContext): PanelSnapshot {
    const stack = postfxStack(ctx);
    if (!stack) {
        return {
            status: "unsupported",
            statusMsg: "no post-process stack",
            sections: [{ kind: "lines", name: "", lines: [{ text: "PostProcessStack not present on renderer." }] }],
        };
    }
    const enabled: string[] = stack.getEnabledEffects?.() ?? [];
    const effectsSection: SnapshotSection = {
        kind: "controls",
        name: `Effects (${enabled.length} enabled)`,
        controls: POSTFX_EFFECTS.map((id) => ({
            type: "checkbox" as const,
            id: `fx.${id}`,
            label: id,
            checked: stack.isEnabled?.(id) ?? enabled.includes(id),
        })),
    };
    const sliders: SnapshotSection = {
        kind: "controls",
        name: "Parameters",
        controls: POSTFX_SLIDERS
            .filter((s) => typeof stack[s.setter] === "function" || typeof ctx.renderer?.[s.setter] === "function")
            .map((s) => ({
                type: "slider" as const,
                id: `param.${s.id}`,
                label: s.label,
                value: typeof stack[s.field] === "number" ? stack[s.field] : s.min,
                min: s.min,
                max: s.max,
            })),
    };
    return {
        sections: [
            { kind: "kv", name: "", rows: [kv("Enabled chain", enabled.join(" → ") || "(none)")] },
            effectsSection,
            sliders,
        ],
    };
}

function collectAssets(ctx: EngineProviderContext): PanelSnapshot {
    const r = ctx.renderer;
    const sections: SnapshotSection[] = [];
    const rows: SnapshotKvRow[] = [];

    try {
        const stats = r?.gpuResourceTracker?.getStats?.()
            ?? r?.getGPUResourceTracker?.()?.getStats?.();
        if (stats) {
            rows.push(kv("Textures", `${stats.textureCount} (${fmtBytes(stats.textureBytes)})`));
            rows.push(kv("Buffers", `${stats.bufferCount} (${fmtBytes(stats.bufferBytes)})`));
            const res = (stats.resources ?? []).slice(0, 100);
            if (res.length > 0) {
                sections.push({
                    kind: "table",
                    name: "GPU resources",
                    cols: ["label", "type", "size"],
                    rows: res.map((x: any) => [
                        x.label ?? "?",
                        x.type ?? "?",
                        fmtBytes(x.size ?? x.bytes),
                    ]),
                });
            }
        }
    } catch { /* */ }

    try {
        const mr = r?.modelRenderer ?? r?.getModelRenderer?.();
        const modelList = mr?.listModels?.() ?? mr?.getModelIds?.() ?? [];
        rows.push(kv("Loaded models", Array.isArray(modelList) ? modelList.length : num(modelList)));
        if (Array.isArray(modelList) && modelList.length > 0) {
            sections.push({
                kind: "table",
                name: "Models",
                cols: ["id"],
                rows: modelList.slice(0, 200).map((id: any) => [String(id)]),
            });
        }
    } catch { /* */ }

    sections.unshift({ kind: "kv", name: "", rows });
    return { sections };
}

// ── Command dispatch ──

function handleEngineCommand(ctx: EngineProviderContext, cmd: DevtoolsCommand): void {
    const r = ctx.renderer;
    switch (cmd.action) {
        case "gc": {
            const g = (globalThis as any);
            const fn = g.gc ?? g.Bun?.gc;
            if (typeof fn === "function") {
                try { fn.call(g.Bun ?? g, true); } catch { try { fn(); } catch { /* */ } }
            }
            break;
        }
        case "clear-gpu-errors":
            r?.clearGPUErrors?.();
            break;
        default:
            break;
    }
    // Sim commands routed to the worker proxy.
    const sim = ctx.simProxy;
    if (sim && cmd.action.startsWith("sim.")) {
        if (cmd.action === "sim.pause") sim.pause?.();
        else if (cmd.action === "sim.resume") sim.resume?.();
        else if (cmd.action.startsWith("sim.speed.")) {
            const v = parseFloat(cmd.action.slice("sim.speed.".length));
            if (Number.isFinite(v)) sim.setSimSpeed?.(v);
        } else {
            // Fall through to the worker's registered devtools commands.
            const proxy = sim.__devtoolsCallCommand ? sim : sim.getDevToolsProxy?.();
            proxy?.__devtoolsCallCommand?.(cmd.action.slice(4), []);
        }
    }
    // PostFX commands.
    const stack = postfxStack(ctx);
    if (cmd.action.startsWith("fx.") && stack) {
        const id = cmd.action.slice(3);
        stack.setEnabled?.(id, cmd.payload === "1");
    } else if (cmd.action.startsWith("param.") && stack) {
        const spec = POSTFX_SLIDERS.find((s) => `param.${s.id}` === cmd.action);
        const v = parseFloat(cmd.payload);
        if (spec && Number.isFinite(v)) {
            const setter = stack[spec.setter] ?? r?.[spec.setter];
            setter?.call(stack[spec.setter] ? stack : r, v);
        }
    }
}

/**
 * Register engine-generic providers + command handlers for all provider-fed
 * panels. Game-specific data registers separately on the "game" slot.
 */
export function registerEngineProviders(mirror: DevtoolsProviderTarget, ctx: EngineProviderContext): void {
    mirror.registerProvider("sim", () => collectSim(ctx));
    mirror.registerProvider("memory", () => collectMemory(ctx));
    mirror.registerProvider("render-graph", () => collectRenderGraph(ctx));
    mirror.registerProvider("materials", () => collectMaterials(ctx));
    mirror.registerProvider("doctor", () => collectDoctor(ctx));
    mirror.registerProvider("workers", () => collectWorkers(ctx));
    mirror.registerProvider("input", () => collectInput(ctx));
    mirror.registerProvider("postfx", () => collectPostFx(ctx));
    mirror.registerProvider("assets", () => collectAssets(ctx));
    mirror.registerCommandHandler("*", (cmd) => handleEngineCommand(ctx, cmd));
}
