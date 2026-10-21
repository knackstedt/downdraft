// ============================================================================
// text-surface.ts — base class for GPU text panels.
//
// Owns GpuTextPass + RunCache plumbing: subclass implements draw(pass) which
// pushes quads for the frame; render() flushes the batch scissored to the
// panel rect. Input via ctx.getInputBus() subscriptions gated by rect.
// ============================================================================

import type { RendererModuleContext, ScreenUiCompositor } from "@downdraft/engine/module/renderer-module";
import { GpuTextPass, type Rgba } from "../text/gpu-text";
import { RunCache } from "../text/run-cache";
import { store, type Rect } from "../app/store";
import { faceKey, resolveWeight } from "../text/fonts";

export const MONO = (w = 400) => faceKey("jetbrains", resolveWeight("jetbrains", w), "normal");
export const MONO_I = (w = 400) => faceKey("jetbrains", resolveWeight("jetbrains", w), "italic");
export const UI = (w = 400) => faceKey("inter", resolveWeight("inter", w), "normal");

export abstract class TextSurface implements ScreenUiCompositor {
  order = 0;
  protected ctx: RendererModuleContext;
  protected pass: GpuTextPass;
  protected cache: RunCache;
  protected rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  protected active = true;
  protected dirty = true;
  protected time = 0;
  protected unsubs: (() => void)[] = [];
  scrollY = 0;
  scrollTarget = 0;

  constructor(ctx: RendererModuleContext, cache: RunCache) {
    this.ctx = ctx;
    this.pass = new GpuTextPass(ctx.getDevice(), ctx.getFormat());
    this.cache = cache;
    this.installInput();
  }

  get ready(): boolean { return this.cache.ready; }

  /** Global UI zoom — scales font sizes + layout metrics (Ctrl+= / Ctrl+-). */
  protected get zoom(): number { return store.getState().uiZoom; }
  /** Scale a layout px value by zoom. */
  protected z(v: number): number { return v * this.zoom; }

  setRect(r: Rect): void {
    if (r.x === this.rect.x && r.y === this.rect.y && r.w === this.rect.w && r.h === this.rect.h) return;
    this.rect = r;
    this.dirty = true;
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.dirty = true;
  }

  protected installInput(): void {
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onWheel((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      ctrl.stopPropagation();
      this.onWheel(e.deltaY, e.clientX, e.clientY);
    }, 30));
  }

  protected inRect(x: number, y: number): boolean {
    const r = this.rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  protected onWheel(dy: number, _x: number, _y: number): void {
    this.scrollTarget = Math.max(0, this.scrollTarget + dy);
    this.dirty = true;
  }

  /** Subclass hook — returns content height for scroll clamping. */
  protected contentHeight(): number { return 0; }

  tick(dt: number): void {
    this.time += dt;
    // Direct scroll — easing adds input latency and the fractional offsets
    // make rasterized glyph quads shimmer ("boiling").
    this.scrollY = Math.round(this.scrollTarget);
  }

  hasContent(): boolean {
    return this.active && this.rect.w > 0 && this.rect.h > 0;
  }

  /** Subclass draws quads into the batch (surface px space, y-down). */
  protected abstract draw(pass: GpuTextPass): void;

  /** Measure a text run's advance (size is zoom-scaled). */
  protected measure(face: string, size: number, text: string): number {
    return this.cache.getRun(face, size * this.zoom, text)?.advance ?? 0;
  }

  /** Outline rect (1px). */
  protected outline(pass: GpuTextPass, x: number, y: number, w: number, h: number, color: Rgba): void {
    pass.rect(x, y, w, 1, color);
    pass.rect(x, y + h - 1, w, 1, color);
    pass.rect(x, y, 1, h, color);
    pass.rect(x + w - 1, y, 1, h, color);
  }

  /** Rounded rect with an optional 1px border (border behind, fill inset). */
  protected rrect(pass: GpuTextPass, x: number, y: number, w: number, h: number, radius: number, fill: Rgba, border?: Rgba): void {
    if (border) pass.roundedRect(x, y, w, h, radius, border);
    const i = border ? 1 : 0;
    pass.roundedRect(x + i, y + i, w - 2 * i, h - 2 * i, Math.max(0, radius - i), fill);
  }

  /** Baseline y that visually centers a `fontPx`-size run inside a box of
   *  height `h` starting at `y` (cap-height centering, ~0.36em). */
  protected vcenter(y: number, h: number, fontPx: number): number {
    return y + h / 2 + this.z(fontPx) * 0.36;
  }

  /** Draw a text run at (x, baselineY) in surface px. Returns advance.
   *  `size` is zoom-scaled; positions are pixel-snapped so cached glyph
   *  bitmaps land on whole pixels (fractional offsets shimmer). */
  protected drawText(pass: GpuTextPass, face: string, size: number, text: string, x: number, baselineY: number, color: Rgba, maxW?: number): number {
    if (!text) return 0;
    const px = Math.round(x);
    const by0 = Math.round(baselineY);
    const sz = size * this.zoom;
    const run = this.cache.getRun(face, sz, text);
    if (!run) return 0;
    const max = (maxW ?? Infinity) * this.zoom;
    // Chunk the run into atlas bitmaps — whole run when it fits.
    const chunk = this.cache.getChunk(face, sz, text);
    if (chunk?.region && chunk.w <= max) {
      const bx = px + chunk.inkX;
      const by = by0 - chunk.baselineInBitmap;
      pass.text(bx, by, chunk.w, chunk.h, { region: chunk.region, atlasSize: this.cache.atlas.size }, color);
      return run.advance;
    }
    // Fallback: per-character chunks (long runs / clip).
    let pen = px;
    for (let i = 0; i < text.length && pen - px < max; i++) {
      const ch = text[i]!;
      const c = this.cache.getChunk(face, sz, ch);
      const w = this.cache.getRun(face, sz, ch)?.advance ?? sz * 0.6;
      if (c?.region) {
        const bx = pen + c.inkX;
        const by = by0 - c.baselineInBitmap;
        pass.text(bx, by, c.w, c.h, { region: c.region, atlasSize: this.cache.atlas.size }, color);
      }
      pen += w;
    }
    return pen - px;
  }

  /** Scissored quad ranges — subclasses override to clip sub-regions. */
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    return [{ start: 0, end: this.pass.quadCount, scissor: [this.rect.x, this.rect.y, this.rect.w, this.rect.h] }];
  }

  render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
    if (!this.hasContent()) return;
    // Clamp scroll — integer offsets only (glyph bitmaps are pixel-snap).
    const max = Math.max(0, Math.round(this.contentHeight() - this.rect.h));
    this.scrollTarget = Math.round(Math.min(max, Math.max(0, this.scrollTarget)));
    this.scrollY = Math.round(Math.min(max, this.scrollY));
    this.pass.begin();
    this.draw(this.pass);
    this.drawScrollbar();
    this.pass.renderRanges(pass, surfaceW, surfaceH, this.cache.atlas, this.time, this.scissorRanges());
  }

  /** Right-edge scrollbar thumb when content overflows — makes
   *  scrollable regions discoverable. Surfaces with their own scrollbar
   *  (console) may skip via `scrollHint` = false. */
  protected scrollHint = true;
  private drawScrollbar(): void {
    if (!this.scrollHint) return;
    const ch = this.contentHeight();
    const r = this.rect;
    if (ch <= r.h + 2) return;
    const thumbH = Math.max(this.z(20), Math.round(r.h * (r.h / ch)));
    const frac = this.scrollY / Math.max(1, ch - r.h);
    const ty = r.y + Math.round((r.h - thumbH) * frac);
    this.pass.rect(r.x + r.w - 3, ty, 3, thumbH, [0.62, 0.68, 0.76, 0.35]);
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.pass.destroy();
  }
}
