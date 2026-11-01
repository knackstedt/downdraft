// native-surface.spec.ts — the acquired surface texture's native handle must
// be released at present(). Before this fix the wrapper was simply nulled, so
// every frame's boxed Texture clone stayed alive — wgpu's texture id space
// ratcheted ~60+/s/surface and its index-keyed tracker Vecs grew without
// bound (the long-session RSS/FPS leak).
import { describe, expect, it, mock } from "bun:test";

const releasedTextures: bigint[] = [];
const presents: number[] = [];
let nextTexturePtr = 0x1000n;
// >0 → acquire returns Outdated (each frame consumes 2 decrements — the
// attempt-0 failure reconfigures then attempt-1 fails too).
let acquireOutdated = 0;

mock.module("../gpu/wgpu-ffi", () => ({
  wgpu: {
    wgpu_shim_surface_pick_format: () => 2, // Rgba8Unorm-ish — nonzero = usable
    wgpu_shim_surface_configure: () => {},
    wgpu_shim_surface_unconfigure: () => {},
    wgpu_shim_surface_get_current_texture: (_s: number, out: BigUint64Array) => {
      out[0] = 0n; // the real shim nulls the out-param before attempting
      if (acquireOutdated > 0) {
        acquireOutdated--;
        return 4; // Outdated
      }
      out[0] = nextTexturePtr;
      return 1; // Success
    },
    wgpu_shim_surface_present: (surface: number) => {
      presents.push(surface);
    },
    wgpu_shim_release_texture: (p: bigint) => {
      releasedTextures.push(p);
    },
  },
}));

const { NativeSurface } = await import("./native-surface");

function makeConfiguredContext() {
  const surface = new NativeSurface(64, 64, 7 as never);
  const ctx = surface.getContext("webgpu")!;
  ctx.configure({ device: { ptr: 11, adapterPtr: 22 } as never, format: "rgba8unorm" });
  ctx.resize(64, 64);
  return ctx;
}

describe("NativeCanvasContext surface texture lifecycle", () => {
  it("present() releases the acquired texture handle", () => {
    const ctx = makeConfiguredContext();
    releasedTextures.length = 0;
    presents.length = 0;

    const tex = ctx.getCurrentTexture()!;
    expect(tex).not.toBeNull();
    (tex as any).__ddWritten = true;
    ctx.present();

    expect(presents).toEqual([7]);
    expect(releasedTextures).toEqual([0x1000n]);
    expect(ctx.getCurrentTexture()).not.toBe(tex); // next acquire is a fresh handle
  });

  it("unwritten textures are retained, not presented or released", () => {
    const ctx = makeConfiguredContext();
    releasedTextures.length = 0;
    presents.length = 0;

    ctx.getCurrentTexture()!; // acquired but __ddWritten stays false
    ctx.present();

    expect(presents).toEqual([]);
    expect(releasedTextures).toEqual([]);
  });

  it("peekCurrentTexture reflects the in-flight frame without acquiring", () => {
    const ctx = makeConfiguredContext();
    presents.length = 0;

    // Nothing acquired → null (overlay passes must not start a frame).
    expect(ctx.peekCurrentTexture()).toBeNull();

    // Acquired → returns the same texture; a present-less frame that
    // acquired-but-never-wrote retains it for the next frame's peek.
    const tex = ctx.getCurrentTexture()!;
    expect(ctx.peekCurrentTexture()).toBe(tex);
    ctx.present(); // unwritten → retained, still outstanding
    expect(ctx.peekCurrentTexture()).toBe(tex);

    // Written + presented → consumed; peek is back to null.
    (tex as any).__ddWritten = true;
    ctx.present();
    expect(ctx.peekCurrentTexture()).toBeNull();
  });

  it("fires onSwapchainDead on a sustained outdated streak, capped per episode", () => {
    const ctx = makeConfiguredContext();
    releasedTextures.length = 0;
    let deadCalls = 0;
    ctx.onSwapchainDead = () => { deadCalls++; };

    // A brief outdated burst heals through the normal reconfigure retry —
    // no escalation.
    acquireOutdated = 4; // 2 failed frames
    expect(ctx.getCurrentTexture()).toBeNull();
    expect(ctx.getCurrentTexture()).toBeNull();
    const healed = ctx.getCurrentTexture();
    expect(healed).not.toBeNull();
    (healed as any).__ddWritten = true;
    ctx.present(); // release the outstanding texture so the next acquire runs
    expect(deadCalls).toBe(0);

    // A persistent streak escalates. Frames 1-8 consume 2 acquires (the
    // reconfigure-and-retry path), frames 9+ consume 1 (dead-surface
    // backoff skips the retry) — 20 outdated acquires = 12 failed frames,
    // the 12th firing the hook.
    acquireOutdated = 20;
    for (let i = 0; i < 12; i++) expect(ctx.getCurrentTexture()).toBeNull();
    expect(deadCalls).toBe(1);
    const recreated = ctx.getCurrentTexture();
    expect(recreated).not.toBeNull();
    (recreated as any).__ddWritten = true;
    ctx.present();
    expect(deadCalls).toBe(1);

    // A streak that survives recreation keeps escalating — bounded at 3
    // attempts per wedge episode (and the >1.5s spacing means only the
    // first lands in this burst).
    acquireOutdated = 10_000;
    for (let i = 0; i < 12; i++) expect(ctx.getCurrentTexture()).toBeNull();
    expect(deadCalls).toBe(2);
    for (let i = 0; i < 40; i++) expect(ctx.getCurrentTexture()).toBeNull();
    expect(deadCalls).toBe(2); // spaced out, not per-frame
  });
});
