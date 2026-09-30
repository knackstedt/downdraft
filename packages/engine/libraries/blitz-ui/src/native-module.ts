// ============================================================================
// createBlitzUiNativeModule — native (winit/SDL) Blitz UI renderer module.
//
// The native runtime can't attach winit-web + WebGL2 to a DOM canvas, so this
// module drives the headless wasm build instead: DioxusDocument + vello_cpu
// rasterize the UI into an RGBA8 buffer on ui_frame(), which is uploaded to
// a GPUTexture and composited over the swapchain with UiBlitPass (the same
// premultiplied-alpha blit pixi-ui-native uses).
//
// Input, state, and action bridging are identical to the web build — the
// window-level event polyfills feed the engine's InputManager → BlitzUiRouter
// → ui_pointer/ui_key, and store snapshots flow through ui_set_state.
//
// Frame cadence: the module hooks "afterFrame" (runs after the game's custom
// render, before present). ui_tick() drains queued input/snapshots and
// reports dirtiness; only then is ui_frame() rasterized + uploaded. The blit
// itself runs every frame — the swapchain is re-cleared each frame while the
// UI texture persists.
// ============================================================================

import { UIInputRouter, type RendererModule, type UIRoot } from "@downdraft/engine";
import { UiBlitPass } from "@downdraft/engine/libraries/pixi-ui-native";
import { createLogger } from "@downdraft/engine/util/logger";
import { captureScreenshot } from "@downdraft/platform-native";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BlitzUiRouter, type BlitzWasmInput } from "./router";

const log = createLogger("info");

/** The wasm-bindgen module surface a game's generated pkg must provide. */
export interface BlitzWasmModule extends BlitzWasmInput {
    initSync(input: { module: Uint8Array }): unknown;
    ui_init_headless(width: number, height: number, scale: number, onAction: (action: string, payload: string) => void): void;
    ui_resize(width: number, height: number, scale: number): void;
    ui_shutdown(): void;
    ui_tick(): boolean;
    ui_frame(): Uint8Array;
    ui_set_state(json: string): unknown;
    ui_dump(): string;
}

/** Structural subset of the game renderer the module touches. */
export interface BlitzHostRenderer {
    getUIInputRouter(): UIInputRouter | null;
    getInputManager(): { setUIInputRouter(router: UIInputRouter): void };
    uiInputRouter: UIInputRouter | null;
    getUIRoot(): UIRoot | null;
}

export interface BlitzUiNativeOptions<S> {
    /** Module name (defaults to "blitz-ui-native"). */
    name?: string;
    /** Dynamic import of the game's wasm-bindgen JS glue. */
    loadModule(): Promise<BlitzWasmModule>;
    /** URL of the generated `*_bg.wasm` binary. */
    wasmUrl: URL;
    /** The game renderer (owns the input manager + router slot). */
    renderer: BlitzHostRenderer;
    /** Zustand-shaped store — snapshots are pushed on subscribe. */
    store: { getState(): S; subscribe(cb: () => void): () => void };
    /** Serialize a store snapshot into the game's UiSnapshot object. */
    snapshot(state: S): unknown;
    /** Route a UI action back into the game (button clicks etc.). */
    dispatch(action: string, payload: string): void;
    /** Escape-key handler (menus etc.). */
    onEscape?(): void;
    /** Continuous-animation hook — return true to re-push state each frame
     * (e.g. while a countdown is animating). */
    shouldRepush?(state: S): boolean;
    /** Env var name that triggers a composited-frame PNG capture on frame 4. */
    debugScreenshotEnv?: string;
}

export function createBlitzUiNativeModule<S>(options: BlitzUiNativeOptions<S>): RendererModule {
    let started: Promise<{ wasm: BlitzWasmModule }> | null = null;

    const start = async (width: number, height: number, scale: number) => {
        const wasm = await options.loadModule();
        // Bun can't fetch() a file:// URL inside wasm-bindgen's async init —
        // load the binary from disk and initialize synchronously instead.
        wasm.initSync({ module: readFileSync(fileURLToPath(options.wasmUrl)) });
        wasm.ui_init_headless(width, height, scale, (action, payload) => {
            options.dispatch(action, payload);
        });
        log.info(options.name ?? "blitz-ui-native", "started");
        return { wasm };
    };

    return {
        name: options.name ?? "blitz-ui-native",
        version: "1.0.0",
        register(ctx) {
            let disposed = false;
            let router: BlitzUiRouter | null = null;
            let prevRouter: UIInputRouter | null = null;
            let unsubscribe: (() => void) | null = null;
            let blitPass: UiBlitPass | null = null;
            let uiTexture: GPUTexture | null = null;
            let uiTextureView: GPUTextureView | null = null;
            let wasmRef: BlitzWasmModule | null = null;

            const canvas = ctx.getSurface();
            const renderer = options.renderer;

            const push = (wasm: BlitzWasmModule) => {
                try {
                    wasm.ui_set_state(JSON.stringify(options.snapshot(options.store.getState())));
                } catch (e) {
                    log.warn("blitz-ui-native", `ui_set_state failed: ${e}`);
                }
            };

            const onKeyDown = (e: KeyboardEvent) => {
                if (e.key === "Escape") options.onEscape?.();
            };

            void (async () => {
                try {
                    const scale = (window.devicePixelRatio as number | undefined) || 1;
                    started ??= start(canvas.width, canvas.height, scale);
                    const { wasm } = await started;
                    if (disposed) return;
                    wasmRef = wasm;

                    const device = ctx.getDevice();
                    blitPass = new UiBlitPass(device, ctx.getFormat());

                    prevRouter = renderer.getUIInputRouter();
                    router = new BlitzUiRouter(wasm);
                    renderer.getInputManager().setUIInputRouter(router);
                    renderer.uiInputRouter = router;
                    router.attachKeyboard();
                    window.addEventListener("keydown", onKeyDown);

                    push(wasm);
                    unsubscribe = options.store.subscribe(() => push(wasm));

                    (globalThis as Record<string, unknown>).__blitzDump = wasm.ui_dump;
                } catch (e) {
                    log.error("blitz-ui-native", `failed to start — UI will be unavailable: ${e}`);
                }
            })();

            const ensureTexture = (device: GPUDevice): GPUTextureView | null => {
                const w = canvas.width;
                const h = canvas.height;
                if (uiTexture && uiTexture.width === w && uiTexture.height === h) return uiTextureView;
                uiTexture?.destroy();
                uiTexture = device.createTexture({
                    size: { width: Math.max(1, w), height: Math.max(1, h) },
                    format: "rgba8unorm",
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });
                uiTextureView = uiTexture.createView();
                return uiTextureView;
            };

            // Debug: <ENV>=path.png captures the composited frame on frame 4
            // (the surface texture is still acquired inside afterFrame, and
            // must be read back with the *renderer* device — the host's
            // device is a different wgpu device).
            const shotPath = options.debugScreenshotEnv ? process.env[options.debugScreenshotEnv] : undefined;
            let frameCount = 0;

            ctx.onFrame("afterFrame", () => {
                ++frameCount;
                const wasm = wasmRef;
                if (!wasm || disposed || !blitPass) return;
                const device = ctx.getDevice();
                const view = ensureTexture(device);
                const context = ctx.getSurface().getContext("webgpu");
                const targetTex = context?.getCurrentTexture();
                const target = targetTex?.createView();
                if (!view || !target || !targetTex) return;

                if (options.shouldRepush?.(options.store.getState())) push(wasm);

                if (wasm.ui_tick()) {
                    const rgba = wasm.ui_frame();
                    device.queue.copyExternalImageToTexture(
                        // vello_cpu output is already premultiplied — pass
                        // it through (premultipliedAlpha would double-multiply).
                        { source: { data: rgba, width: canvas.width, height: canvas.height } } as unknown as GPUCopyExternalImageSourceInfo,
                        { texture: uiTexture } as unknown as GPUCopyExternalImageDestInfo,
                        { width: canvas.width, height: canvas.height },
                    );
                }
                const encoder = device.createCommandEncoder();
                blitPass.execute(encoder, target, view);
                device.queue.submit([encoder.finish()]);

                if (shotPath && frameCount === 4) {
                    captureScreenshot(device as any, targetTex as any, canvas.width, canvas.height, shotPath, ctx.getFormat());
                    log.info("blitz-ui-native", `screenshot → ${shotPath}`);
                }
            });

            ctx.onResize(() => {
                const scale = (window.devicePixelRatio as number | undefined) || 1;
                wasmRef?.ui_resize(canvas.width, canvas.height, scale);
            });

            ctx.onDispose(() => {
                disposed = true;
                window.removeEventListener("keydown", onKeyDown);
                unsubscribe?.();
                router?.detachKeyboard();
                const restore = prevRouter ?? new UIInputRouter();
                if (!prevRouter) {
                    const root = renderer.getUIRoot();
                    if (root) restore.setRoot(root);
                }
                renderer.getInputManager().setUIInputRouter(restore);
                renderer.uiInputRouter = restore;
                uiTexture?.destroy();
                blitPass?.dispose();
                // Tear down the Dioxus document and drop the module-level
                // singleton so a re-register boots a fresh instance.
                wasmRef?.ui_shutdown();
                wasmRef = null;
                started = null;
            });
        },
    };
}
