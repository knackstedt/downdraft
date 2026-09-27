// ============================================================================
// native-abi.spec.ts — ABI contract tests for libdowndraft_platform
//
// The Rust cdylib replaces the C shims while keeping identical symbol names +
// signatures — these specs dlopen it and verify the contract directly:
// every expected export resolves, and the ported groups behave correctly on
// real data. Skipped entirely when the lib isn't built (run
// `bun run build:native` from the repo root to produce it).
//
// Symbol lists mirror the FFI specs in src/ — when a port lands, its symbols
// are added here so a missing export fails in CI, not at runtime.
// ============================================================================

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dlopen, ptr } from "../src/ffi/ffi-adapter";
import { resolvePlatformLibrary } from "../src/ffi/lib-paths";
import { encodePNG } from "../src/screenshot/screenshot";

const libPath = resolvePlatformLibrary(true);
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

// Symbol groups by porting phase. `dlopen` resolves every declared symbol
// eagerly — a missing export throws at open time, which is exactly the
// contract we want to enforce.
const GROUPS: Record<string, string[]> = {
  image: [
    "image_shim_decode",
    "image_shim_decode_file",
    "image_shim_free",
    "image_shim_info",
  ],
  font: [
    "ft_shim_init",
    "ft_shim_render_text",
    "ft_shim_measure",
    "ft_shim_done",
  ],
  sdl: [
    "sdl_shim_create_window",
    "sdl_shim_get_window_subsystem",
    "sdl_shim_get_window_size",
    "sdl_shim_set_window_title",
    "sdl_shim_poll_event",
    "sdl_shim_wait_event",
    "sdl_shim_grab_input",
    "sdl_shim_start_text_input",
    "sdl_shim_stop_text_input",
    "sdl_shim_set_text_input_rect",
    "sdl_shim_destroy_window",
    "sdl_shim_delay",
    "sdl_shim_create_wgpu_surface",
    "sdl_shim_set_fullscreen",
    "sdl_shim_get_window_pos",
    "sdl_shim_set_window_pos",
    "sdl_shim_get_window_borders",
    "sdl_shim_set_window_size",
    "sdl_shim_get_display_info",
    "sdl_shim_request_quit",
    "sdl_shim_show_message_box",
    "sdl_shim_set_clipboard",
    "sdl_shim_get_clipboard",
  ],
  // Phase 5: full wgpu_shim_* surface (wgpu crate port of wgpu_shim.c).
  wgpu: [
    "wgpu_shim_create_instance",
    "wgpu_shim_request_adapter",
    "wgpu_shim_request_device",
    "wgpu_shim_device_get_queue",
    "wgpu_shim_process_events",
    "wgpu_shim_device_poll_lost",
    "wgpu_shim_create_buffer",
    "wgpu_shim_queue_write_buffer",
    "wgpu_shim_buffer_map_async",
    "wgpu_shim_buffer_read_mapped",
    "wgpu_shim_buffer_write_mapped",
    "wgpu_shim_buffer_unmap",
    "wgpu_shim_create_shader_module",
    "wgpu_shim_shader_get_compilation_info",
    "wgpu_shim_create_texture",
    "wgpu_shim_texture_create_view",
    "wgpu_shim_queue_write_texture",
    "wgpu_shim_create_sampler",
    "wgpu_shim_create_bind_group_layout",
    "wgpu_shim_create_pipeline_layout",
    "wgpu_shim_create_bind_group",
    "wgpu_shim_create_command_encoder",
    "wgpu_shim_command_encoder_finish",
    "wgpu_shim_queue_submit",
    "wgpu_shim_begin_render_pass",
    "wgpu_shim_render_pass_set_pipeline",
    "wgpu_shim_render_pass_set_bind_group",
    "wgpu_shim_render_pass_set_vertex_buffer",
    "wgpu_shim_render_pass_set_index_buffer",
    "wgpu_shim_render_pass_draw",
    "wgpu_shim_render_pass_draw_indexed",
    "wgpu_shim_render_pass_end",
    "wgpu_shim_render_pass_set_scissor_rect",
    "wgpu_shim_render_pass_set_viewport",
    "wgpu_shim_create_render_pipeline",
    "wgpu_shim_create_compute_pipeline",
    "wgpu_shim_begin_compute_pass",
    "wgpu_shim_compute_pass_set_pipeline",
    "wgpu_shim_compute_pass_set_bind_group",
    "wgpu_shim_compute_pass_dispatch",
    "wgpu_shim_compute_pass_end",
    "wgpu_shim_copy_buffer_to_buffer",
    "wgpu_shim_copy_texture_to_buffer",
    "wgpu_shim_copy_buffer_to_texture",
    "wgpu_shim_copy_texture_to_texture",
    "wgpu_shim_create_query_set",
    "wgpu_shim_destroy_query_set",
    "wgpu_shim_command_encoder_write_timestamp",
    "wgpu_shim_resolve_query_set",
    "wgpu_shim_render_pass_draw_indirect",
    "wgpu_shim_render_pass_draw_indexed_indirect",
    "wgpu_shim_compute_pass_dispatch_indirect",
    "wgpu_shim_command_encoder_clear_buffer",
    "wgpu_shim_render_pass_set_blend_constant",
    "wgpu_shim_render_pass_set_stencil_reference",
    "wgpu_shim_render_pass_begin_occlusion_query",
    "wgpu_shim_render_pass_end_occlusion_query",
    "wgpu_shim_render_pass_push_debug_group",
    "wgpu_shim_render_pass_pop_debug_group",
    "wgpu_shim_render_pass_insert_debug_marker",
    "wgpu_shim_compute_pass_push_debug_group",
    "wgpu_shim_compute_pass_pop_debug_group",
    "wgpu_shim_compute_pass_insert_debug_marker",
    "wgpu_shim_command_encoder_push_debug_group",
    "wgpu_shim_command_encoder_pop_debug_group",
    "wgpu_shim_command_encoder_insert_debug_marker",
    "wgpu_shim_device_push_error_scope",
    "wgpu_shim_device_pop_error_scope",
    "wgpu_shim_adapter_get_limits",
    "wgpu_shim_device_get_limits",
    "wgpu_shim_adapter_get_features",
    "wgpu_shim_device_get_features",
    "wgpu_shim_queue_on_submitted_work_done",
    "wgpu_shim_surface_configure",
    "wgpu_shim_surface_get_current_texture",
    "wgpu_shim_surface_present",
    "wgpu_shim_surface_unconfigure",
    "wgpu_shim_get_preferred_format",
    "wgpu_shim_release_buffer",
    "wgpu_shim_release_texture",
    "wgpu_shim_release_texture_view",
    "wgpu_shim_release_sampler",
    "wgpu_shim_release_bind_group",
    "wgpu_shim_release_bind_group_layout",
    "wgpu_shim_release_pipeline_layout",
    "wgpu_shim_release_render_pipeline",
    "wgpu_shim_release_compute_pipeline",
    "wgpu_shim_release_shader_module",
    "wgpu_shim_release_command_buffer",
    "wgpu_shim_release_command_encoder",
    "wgpu_shim_release_device",
    "wgpu_shim_release_adapter",
    "wgpu_shim_release_instance",
    "wgpu_shim_release_surface",
    "wgpu_shim_release_query_set",
    "wgpu_shim_release_render_pass",
    "wgpu_shim_release_compute_pass",
    "wgpu_shim_release_queue",
  ],
  // Phase 6: dd_wgsl_validate
};

const specFor = (symbols: string[]) =>
  Object.fromEntries(symbols.map((s) => [s, { args: [], returns: "void" }]));

// bun-types doesn't declare test.skip — it exists at runtime.
const itIf = (cond: boolean) =>
  cond ? test : (test as unknown as { skip: typeof test }).skip;

describe("downdraft_platform ABI", () => {
  for (let _i = 0, _it = Object.entries(GROUPS), _n = _it.length; _i < _n; _i++) {
    const [group, symbols] = _it[_i];
    itIf(!!libPath)(`exports all ${group} symbols`, () => {
      expect(() => dlopen(libPath!, specFor(symbols) as never)).not.toThrow();
    });
  }

  itIf(!!libPath)("image_shim_info + decode round-trip a PNG", () => {
    const { symbols } = dlopen(libPath!, {
      image_shim_info: { args: ["ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
      image_shim_decode: { args: ["ptr", "i32", "ptr", "i32", "ptr", "ptr", "ptr"], returns: "i32" },
    });

    // 2x2 RGBA → PNG → shim info → shim decode → same pixels back.
    const src = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const png = new Uint8Array(encodePNG(2, 2, src));

    const w = new Int32Array(1);
    const h = new Int32Array(1);
    const c = new Int32Array(1);
    expect(symbols.image_shim_info(ptr(png), png.byteLength, ptr(w), ptr(h), ptr(c))).toBe(0);
    expect(w[0]).toBe(2);
    expect(h[0]).toBe(2);

    const out = new Uint8Array(2 * 2 * 4);
    expect(symbols.image_shim_decode(ptr(png), png.byteLength, ptr(out), out.byteLength, ptr(w), ptr(h), ptr(c))).toBe(0);
    expect(w[0]).toBe(2);
    expect(h[0]).toBe(2);
    expect(c[0]).toBe(4);
    expect(Array.from(out)).toEqual(Array.from(src));

    // Too-small output buffer → 2, outputs untouched.
    const tiny = new Uint8Array(4);
    w[0] = -1;
    expect(symbols.image_shim_decode(ptr(png), png.byteLength, ptr(tiny), tiny.byteLength, ptr(w), ptr(h), ptr(c))).toBe(2);
    expect(w[0]).toBe(-1);

    // Garbage input → 1.
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect(symbols.image_shim_info(ptr(junk), junk.byteLength, ptr(w), ptr(h), ptr(c))).toBe(1);
  });

  itIf(!!libPath)("ft_shim renders + measures real text", () => {
    if (!existsSync(FONT_PATH)) return; // headless CI without fonts — skip
    const { symbols } = dlopen(libPath!, {
      ft_shim_init: { args: ["cstring"], returns: "i64" },
      ft_shim_render_text: { args: ["i64", "cstring", "i32", "ptr", "i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
      ft_shim_measure: { args: ["i64", "cstring", "i32"], returns: "i32" },
      ft_shim_done: { args: ["i64"], returns: "void" },
    });

    const font = symbols.ft_shim_init(FONT_PATH);
    expect(font !== 0n).toBe(true);

    const measured = symbols.ft_shim_measure(font, "Hello", 16);
    expect(measured).toBeGreaterThan(10);
    expect(measured).toBeLessThan(100);

    const out = new Uint8Array(2048 * 128 * 4);
    const w = new Int32Array(1);
    const h = new Int32Array(1);
    const n = symbols.ft_shim_render_text(font, "Hello", 16, ptr(out), out.byteLength, 2048, 128, ptr(w), ptr(h));
    expect(n).toBeGreaterThan(0);
    expect(w[0]).toBeGreaterThan(0);
    expect(h[0]).toBeGreaterThan(0);
    // Premultiplied coverage: some pixels opaque, r=g=b=a on every texel.
    let sawInk = false;
    for (let i = 0; i < n; i += 4) {
      expect(out[i]).toBe(out[i + 1]);
      expect(out[i + 1]).toBe(out[i + 2]);
      expect(out[i + 2]).toBe(out[i + 3]);
      if (out[i] > 0) sawInk = true;
    }
    expect(sawInk).toBe(true);

    symbols.ft_shim_done(font);
    // Missing font path → 0, no crash.
    expect(symbols.ft_shim_init("/nonexistent/nope.ttf")).toBe(0n);
  });

  const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  itIf(!!libPath && hasDisplay)("sdl_shim window lifecycle + quit injection", () => {
    const { symbols } = dlopen(libPath!, {
      sdl_shim_create_window: { args: ["cstring", "i32", "i32"], returns: "i32" },
      sdl_shim_get_window_subsystem: { args: [], returns: "i32" },
      sdl_shim_get_window_size: { args: ["ptr", "ptr"], returns: "void" },
      sdl_shim_set_window_title: { args: ["cstring"], returns: "void" },
      sdl_shim_poll_event: { args: ["ptr"], returns: "i32" },
      sdl_shim_wait_event: { args: ["ptr", "u32"], returns: "i32" },
      sdl_shim_request_quit: { args: [], returns: "void" },
      sdl_shim_get_display_info: { args: ["ptr", "ptr"], returns: "void" },
      sdl_shim_destroy_window: { args: [], returns: "void" },
      sdl_shim_delay: { args: ["u32"], returns: "void" },
    });

    try {
      expect(symbols.sdl_shim_create_window("abi-test", 320, 240)).toBe(0);
      // X11/Wayland/Windows/Cocoa → SDL_SYSWM tags 2/3/1/4.
      expect(symbols.sdl_shim_get_window_subsystem()).toBeGreaterThan(0);

      const w = new Int32Array(1);
      const h = new Int32Array(1);
      symbols.sdl_shim_get_window_size(ptr(w), ptr(h));
      expect(w[0]).toBeGreaterThan(0);
      expect(h[0]).toBeGreaterThan(0);
      symbols.sdl_shim_set_window_title("abi-test-2");

      const refresh = new Int32Array(1);
      const scale = new Float32Array(1);
      symbols.sdl_shim_get_display_info(ptr(refresh), ptr(scale));
      expect(scale[0]).toBeGreaterThan(0);

      // request_quit → next poll returns SDL_SHIM_EVENT_QUIT (1).
      const ev = new Int32Array(8);
      symbols.sdl_shim_request_quit();
      expect(symbols.sdl_shim_poll_event(ptr(ev))).toBe(1);
      // Queue now drains empty → NONE (0), no crash on repeats.
      for (let i = 0; i < 4; i++) symbols.sdl_shim_poll_event(ptr(ev));
      symbols.sdl_shim_delay(1);
    } finally {
      symbols.sdl_shim_destroy_window();
    }
    // After destroy, poll → NONE even if a quit was pending.
    const ev = new Int32Array(8);
    symbols.sdl_shim_request_quit();
    expect(symbols.sdl_shim_poll_event(ptr(ev))).toBe(0);
  });

  // Full swapchain path: real X11 window → wgpu surface → configure →
  // acquire → present. The path that broke most often in the C shims.
  itIf(!!libPath && hasDisplay)("window → wgpu surface acquire/present", () => {
    const { symbols: s } = dlopen(libPath!, {
      sdl_shim_create_window: { args: ["cstring", "i32", "i32"], returns: "i32" },
      sdl_shim_create_wgpu_surface: { args: ["ptr"], returns: "ptr" },
      sdl_shim_destroy_window: { args: [], returns: "void" },
    });
    const { symbols: w } = dlopen(libPath!, {
      wgpu_shim_create_instance: { args: [], returns: "ptr" },
      wgpu_shim_request_adapter: { args: ["ptr", "i32"], returns: "ptr" },
      wgpu_shim_request_device: { args: ["ptr", "ptr", "u32", "ptr", "u32"], returns: "ptr" },
      wgpu_shim_surface_configure: { args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32"], returns: "void" },
      wgpu_shim_surface_get_current_texture: { args: ["ptr", "ptr"], returns: "i32" },
      wgpu_shim_surface_present: { args: ["ptr"], returns: "void" },
      wgpu_shim_get_preferred_format: { args: [], returns: "u32" },
      wgpu_shim_release_texture: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_surface: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_device: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_adapter: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_instance: { args: ["ptr"], returns: "ptr" },
    });

    const instance = w.wgpu_shim_create_instance();
    const adapter = w.wgpu_shim_request_adapter(instance, 0);
    if (!adapter) {
      w.wgpu_shim_release_instance(instance);
      return; // no GPU — nothing to present against
    }
    const device = w.wgpu_shim_request_device(adapter, null, 0, null, 0);
    let surface: unknown = 0n;
    try {
      expect(s.sdl_shim_create_window("abi-surface", 160, 120)).toBe(0);
      surface = s.sdl_shim_create_wgpu_surface(instance);
      expect(surface).not.toBe(0n);

      const fmt = w.wgpu_shim_get_preferred_format();
      // TextureUsage: RENDER_ATTACHMENT=16.
      w.wgpu_shim_surface_configure(surface, device, fmt, 16, 160, 120, 1);

      const texOut = new BigUint64Array(1);
      const status = w.wgpu_shim_surface_get_current_texture(surface, ptr(texOut));
      // SuccessOptimal=1 or SuccessSuboptimal=2 both deliver a texture.
      expect([1, 2]).toContain(status);
      expect(texOut[0]).not.toBe(0n);
      w.wgpu_shim_surface_present(surface);
      w.wgpu_shim_release_texture(Number(texOut[0]));
    } finally {
      w.wgpu_shim_release_surface(surface);
      s.sdl_shim_destroy_window();
      w.wgpu_shim_release_device(device);
      w.wgpu_shim_release_adapter(adapter);
      w.wgpu_shim_release_instance(instance);
    }
  });

  // GPU smoke test — headless-safe (llvmpipe/lavapipe fallback). Covers the
  // async-pump contract (request_adapter/device, map_async, error scope,
  // submitted-work-done) plus buffer write/read round-trip.
  itIf(!!libPath)("wgpu_shim device + buffer map round-trip", () => {
    const { symbols: w } = dlopen(libPath!, {
      wgpu_shim_create_instance: { args: [], returns: "ptr" },
      wgpu_shim_request_adapter: { args: ["ptr", "i32"], returns: "ptr" },
      wgpu_shim_request_device: { args: ["ptr", "ptr", "u32", "ptr", "u32"], returns: "ptr" },
      wgpu_shim_device_get_queue: { args: ["ptr"], returns: "ptr" },
      wgpu_shim_device_poll_lost: { args: ["ptr", "ptr", "i32"], returns: "u32" },
      wgpu_shim_create_buffer: { args: ["ptr", "u64", "u32", "i32"], returns: "ptr" },
      wgpu_shim_queue_write_buffer: { args: ["ptr", "ptr", "u64", "ptr", "usize"], returns: "void" },
      wgpu_shim_buffer_map_async: { args: ["ptr", "u32", "u64", "u64"], returns: "u32" },
      wgpu_shim_buffer_read_mapped: { args: ["ptr", "u64", "u64", "ptr", "i32"], returns: "i32" },
      wgpu_shim_buffer_unmap: { args: ["ptr"], returns: "void" },
      wgpu_shim_create_command_encoder: { args: ["ptr"], returns: "ptr" },
      wgpu_shim_copy_buffer_to_buffer: { args: ["ptr", "ptr", "u64", "ptr", "u64", "u64"], returns: "void" },
      wgpu_shim_command_encoder_finish: { args: ["ptr"], returns: "ptr" },
      wgpu_shim_queue_submit: { args: ["ptr", "ptr", "u32"], returns: "void" },
      wgpu_shim_queue_on_submitted_work_done: { args: ["ptr"], returns: "void" },
      wgpu_shim_device_push_error_scope: { args: ["ptr", "u32"], returns: "void" },
      wgpu_shim_device_pop_error_scope: { args: ["ptr", "ptr", "i32"], returns: "u32" },
      wgpu_shim_create_shader_module: { args: ["ptr", "cstring"], returns: "ptr" },
      wgpu_shim_shader_get_compilation_info: { args: ["ptr"], returns: "cstring" },
      wgpu_shim_device_get_limits: { args: ["ptr", "ptr"], returns: "i32" },
      wgpu_shim_adapter_get_features: { args: ["ptr", "ptr", "u32"], returns: "u32" },
      wgpu_shim_get_preferred_format: { args: [], returns: "u32" },
      wgpu_shim_release_buffer: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_shader_module: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_command_encoder: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_command_buffer: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_queue: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_device: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_adapter: { args: ["ptr"], returns: "void" },
      wgpu_shim_release_instance: { args: ["ptr"], returns: "void" },
    });

    const instance = w.wgpu_shim_create_instance();
    expect(instance).not.toBe(0n);
    const adapter = w.wgpu_shim_request_adapter(instance, 0);
    if (!adapter) return; // no GPU backend at all — skip gracefully
    const device = w.wgpu_shim_request_device(adapter, null, 0, null, 0);
    expect(device).not.toBe(0n);
    const queue = w.wgpu_shim_device_get_queue(device);
    expect(queue).not.toBe(0n);

    // Device alive → poll_lost returns 0.
    const msg = new Uint8Array(512);
    expect(w.wgpu_shim_device_poll_lost(device, ptr(msg), msg.byteLength)).toBe(0);

    // BufferUsage: MAP_READ=1 | COPY_DST=8, COPY_SRC=4.
    const srcData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const src = w.wgpu_shim_create_buffer(device, 8n, 1 | 8, 0); // MAP_READ|COPY_DST — released immediately, exercises release path
    const upload = w.wgpu_shim_create_buffer(device, 8n, 8 | 4, 0); // COPY_DST|COPY_SRC
    const readback = w.wgpu_shim_create_buffer(device, 8n, 1 | 8, 0); // MAP_READ|COPY_DST
    expect(upload).not.toBe(0n);
    expect(readback).not.toBe(0n);
    w.wgpu_shim_release_buffer(src);

    w.wgpu_shim_queue_write_buffer(queue, upload, 0n, ptr(srcData), 8);

    const enc = w.wgpu_shim_create_command_encoder(device);
    expect(enc).not.toBe(0n);
    w.wgpu_shim_copy_buffer_to_buffer(enc, upload, 0n, readback, 0n, 8n);
    const cmdBuf = w.wgpu_shim_command_encoder_finish(enc);
    expect(cmdBuf).not.toBe(0n);
    const cmdArr = new BigUint64Array([BigInt(cmdBuf)]);
    w.wgpu_shim_queue_submit(queue, ptr(cmdArr), 1);
    w.wgpu_shim_queue_on_submitted_work_done(queue); // must not hang

    // map_async returns 3 (Mapped) after the synchronous pump.
    expect(w.wgpu_shim_buffer_map_async(readback, 1, 0n, 8n)).toBe(3);
    const out = new Uint8Array(8);
    expect(w.wgpu_shim_buffer_read_mapped(readback, 0n, 8n, ptr(out), 8)).toBe(0);
    expect(Array.from(out)).toEqual(Array.from(srcData));
    w.wgpu_shim_buffer_unmap(readback);

    // Error scope round-trip: clean pop → 1 (NoError).
    w.wgpu_shim_device_push_error_scope(device, 1);
    const emsg = new Uint8Array(256);
    expect(w.wgpu_shim_device_pop_error_scope(device, ptr(emsg), emsg.byteLength)).toBe(1);

    // Shader module + compile info (static "[]").
    const shader = w.wgpu_shim_create_shader_module(device, "@compute @workgroup_size(1) fn main() {}");
    expect(shader).not.toBe(0n);
    expect(w.wgpu_shim_shader_get_compilation_info(shader)).toBe("[]");

    // Limits/feature wire format.
    const limitsBuf = new Uint8Array(256);
    expect(w.wgpu_shim_device_get_limits(device, ptr(limitsBuf))).toBe(0);
    const u32s = new Uint32Array(limitsBuf.buffer, 8, 62);
    expect(u32s[0]).toBeGreaterThan(0); // maxTextureDimension1D
    expect(u32s[27]).toBeGreaterThan(0); // maxColorAttachments
    const feats = new Uint32Array(64);
    expect(w.wgpu_shim_adapter_get_features(adapter, ptr(feats), 64)).toBeGreaterThanOrEqual(0);

    expect(w.wgpu_shim_get_preferred_format()).toBe(27); // Bgra8Unorm

    w.wgpu_shim_release_shader_module(shader);
    w.wgpu_shim_release_buffer(upload);
    w.wgpu_shim_release_buffer(readback);
    w.wgpu_shim_release_command_buffer(cmdBuf);
    w.wgpu_shim_release_command_encoder(enc);
    w.wgpu_shim_release_queue(queue);
    w.wgpu_shim_release_device(device);
    w.wgpu_shim_release_adapter(adapter);
    w.wgpu_shim_release_instance(instance);
  });

  itIf(!!libPath)("dd_wgsl_validate accepts valid + reports diagnostics", () => {
    const { symbols } = dlopen(libPath!, {
      dd_wgsl_validate: { args: ["ptr", "u32", "ptr", "u32"], returns: "u32" },
    });
    const validate = symbols.dd_wgsl_validate as (
      src: Buffer, len: number, out: Buffer | null, cap: number,
    ) => number;

    const good = Buffer.from(
      "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }",
      "utf-8",
    );
    expect(validate(good, good.length, null, 0)).toBe(0);

    const bad = Buffer.from(
      "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(; }",
      "utf-8",
    );
    const needed = validate(bad, bad.length, null, 0);
    expect(needed).toBeGreaterThan(0);

    const msg = Buffer.alloc(needed);
    expect(validate(bad, bad.length, msg, needed)).toBe(needed);
    expect(msg.toString("utf-8")).toContain("expected expression");

    // Truncated output still reports the full needed length.
    const small = Buffer.alloc(8);
    expect(validate(bad, bad.length, small, 8)).toBe(needed);
  });
});
