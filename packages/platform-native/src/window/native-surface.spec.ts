// native-surface.spec.ts — the acquired surface texture's native handle must
// be released at present(). Before this fix the wrapper was simply nulled, so
// every frame's boxed Texture clone stayed alive — wgpu's texture id space
// ratcheted ~60+/s/surface and its index-keyed tracker Vecs grew without
// bound (the long-session RSS/FPS leak).
import { describe, expect, it, mock } from "bun:test";

const releasedTextures: bigint[] = [];
const presents: number[] = [];
let nextTexturePtr = 0x1000n;

mock.module("../gpu/wgpu-ffi", () => ({
  wgpu: {
    wgpu_shim_surface_pick_format: () => 2, // Rgba8Unorm-ish — nonzero = usable
    wgpu_shim_surface_configure: () => {},
    wgpu_shim_surface_unconfigure: () => {},
    wgpu_shim_surface_get_current_texture: (_s: number, out: BigUint64Array) => {
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
});
