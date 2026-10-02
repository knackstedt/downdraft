// ============================================================================
// UI Bake-off — native test bed comparing the engine's UI stacks.
//
// Renders the SAME interactive component gallery in each renderer, one tab
// per stack. Keys 1-5 (or Left/Right arrows) switch stacks; each stack draws
// its own tab bar with itself highlighted.
//
//   Stacks: 1) imui  2) Dioxus/Blitz wasm  3) HTML/CSS (Blitz OSR)
//           4) Canvas2D (NativeCanvas2D)  5) HtmlUI (Blitz html-ui)
//
// Run:      bun run test-beds/ui-bakeoff/main.ts
// Tour:     BAKEOFF_TOUR=test-beds/ui-bakeoff/shots bun run ... — renders each
//           stack for ~30 frames and writes shots/<id>.png (no window needed
//           for verification; the loop stays up afterwards).
// Start tab: BAKEOFF_TAB=3
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native";
import type { StackCtx, UiStack } from "./stack";
import { createCanvas2dStack } from "./stacks/canvas2d";
import { createDioxusStack } from "./stacks/dioxus";
import { createHtmlStack } from "./stacks/html";
import { createHtmlUiStack } from "./stacks/htmlui";
import { createImuiStack } from "./stacks/imui";

const log = createLogger("info");

const WIDTH = 1280;
const HEIGHT = 800;

const host = await createNativeHost({
    window: { title: "Downdraft UI Bake-off", width: WIDTH, height: HEIGHT },
    services: "inline",
});

const { surface, device, adapter, window: win } = host;
const gpuCtx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat() as GPUTextureFormat;
const CLEAR = { r: 0.063, g: 0.078, b: 0.102, a: 1 };

// ── Stacks ──
// Order matches the tab indices shown in each gallery's tab bar.

const factories = [createImuiStack, createDioxusStack, createHtmlStack, createCanvas2dStack, createHtmlUiStack];
const stacks: (UiStack | null)[] = new Array(factories.length).fill(null);
const stackErrors: (string | null)[] = new Array(factories.length).fill(null);

let active = Math.max(0, Math.min(4, Number(process.env.BAKEOFF_TAB ?? 0) || 0));
let switching = false;

function stackCtx(): StackCtx {
    return {
        device: device as unknown as GPUDevice,
        format,
        width: surface.width,
        height: surface.height,
        onAction: (action, payload) => {
            if (action === "tab") {
                try { setActive(JSON.parse(payload).index); } catch { /* ignore */ }
            } else {
                log.info("bakeoff", `action ${action} ${payload}`);
            }
        },
    };
}

async function ensureStack(i: number): Promise<boolean> {
    if (stacks[i]) return true;
    if (stackErrors[i]) return false;
    try {
        const s = factories[i]();
        await s.init(stackCtx());
        stacks[i] = s;
        log.info("bakeoff", `stack ${s.id} ready`);
        return true;
    } catch (e) {
        stackErrors[i] = String(e);
        log.error("bakeoff", `stack ${i} failed: ${e}`);
        return false;
    }
}

async function setActive(i: number): Promise<void> {
    if (i === active || i < 0 || i > NTABS - 1 || switching) return;
    switching = true;
    active = i;
    switching = false;
    log.info("bakeoff", `→ ${TABCODES[i]}`);
}

const TABCODES = ["imui", "dioxus", "html", "canvas2d", "htmlui"];
const NTABS = TABCODES.length;

// ── Input routing ──

surface.addEventListener("mousedown", (e: any) => {
    stacks[active]?.pointerDown?.(e.clientX, e.clientY, e.button ?? 0);
});
surface.addEventListener("mouseup", (e: any) => {
    stacks[active]?.pointerUp?.(e.clientX, e.clientY, e.button ?? 0);
});
surface.addEventListener("mousemove", (e: any) => {
    stacks[active]?.pointerMove?.(e.clientX, e.clientY);
});
surface.addEventListener("wheel", (e: any) => {
    stacks[active]?.wheel?.(e.clientX, e.clientY, e.deltaX ?? 0, e.deltaY ?? 0);
});

win.addEventListener("keydown", (e: any) => {
    if (e.repeat) return;
    const code = e.code ?? "";
    // Give the active stack first claim — a focused <input> eats digits/arrows.
    if (stacks[active]?.key?.(true, e.key ?? "", code, e.keyCode ?? 0, modBits(e))) return;
    if (/^Digit[1-6]$/.test(code)) { void setActive(Number(code[5]) - 1); return; }
    if (code === "ArrowRight") { void setActive((active + 1) % NTABS); return; }
    if (code === "ArrowLeft") { void setActive((active + NTABS - 1) % NTABS); return; }
});
win.addEventListener("keyup", (e: any) => {
    stacks[active]?.key?.(false, e.key ?? "", e.code ?? "", e.keyCode ?? 0, modBits(e));
});

function modBits(e: any): number {
    return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

// ── Frame loop ──

const tourDir = process.env.BAKEOFF_TOUR;
const pendingShots: string[] = [];
let tourIdx = -1;
let warmup = 0;

// Tour mode: walk every stack, capture <id>.png after warmup frames.
if (tourDir) {
    tourIdx = 0;
    active = 0;
    warmup = 0;
    // Pre-init all stacks so failures are known up front.
    for (let i = 0; i < factories.length; i++) await ensureStack(i);
} else {
    await ensureStack(active);
    // Warm the rest in the background so switching is instant.
    void Promise.all(factories.map((_, i) => i === active ? null : ensureStack(i)));
}

function frame(): void {
    const tex = gpuCtx.getCurrentTexture();
    if (!tex) { requestAnimationFrame(frame); return; }
    const target = tex.createView();
    const encoder = (device as unknown as GPUDevice).createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: "clear", clearValue: CLEAR, storeOp: "store" }],
    });
    pass.end();
    (device as unknown as GPUDevice).queue.submit([encoder.finish()]);

    const stack = stacks[active];
    stack?.frame(target);

    // Screenshot tour: after warmup, capture then advance.
    if (tourDir && tourIdx >= 0 && stacks[tourIdx]) {
        if (++warmup === 30) {
            const id = stacks[tourIdx]!.id;
            host.captureScreenshot(`${tourDir}/${id}.png`, tex);
            log.info("bakeoff", `tour shot → ${id}.png`);
        } else if (warmup > 30 + 8) {
            // Advance to the next stack.
            tourIdx++;
            warmup = 0;
            while (tourIdx < stacks.length && !stacks[tourIdx]) tourIdx++;
            if (tourIdx >= stacks.length) {
                tourIdx = -1;
                active = Number(process.env.BAKEOFF_TAB ?? 0) || 0;
                log.info("bakeoff", "tour complete");
            } else {
                active = tourIdx;
            }
        }
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

await new Promise<void>((resolve) => {
    win.addEventListener("close", () => resolve());
});
host.destroy();
