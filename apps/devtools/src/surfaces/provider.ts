// ============================================================================
// provider.ts — renders a target's custom provider panel (PanelSnapshot):
// kv / table / series / lines / controls sections via the shared
// SnapSurface renderer. Polls on a cadence, dispatches control commands
// back. This is how applications feed custom devtools panels and metrics.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { MONO } from "./text-surface";
import { SnapSurface, type SectionHit } from "./snapshot-view";
import { hex, tokens } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import type { TargetSession } from "../targets/session";

export class ProviderSurface extends SnapSurface {
  private pctx: PanelCtx;
  private slot: number;
  private name: string;
  private hit: SectionHit[] = [];
  private lastPoll = 0;
  private pollMs = 750;

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx, slot: number, name: string) {
    super(ctx, cache);
    this.pctx = pctx;
    this.slot = slot;
    this.name = name;
    this.setHistScope(`panel-${slot}`);
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation(); hz.act(); return; }
    }, 30));
  }

  protected pctxSession(): TargetSession | null { return this.pctx.session(); }
  protected pushHit(h: SectionHit): void { this.hit.push(h); }
  protected sendControl(slot: number | string, id: string, payload: string): void {
    void this.pctx.session()?.panelCommand(slot, id, payload);
  }

  tick(dt: number): void {
    super.tick(dt);
    this.lastPoll += dt * 1000;
    if (this.lastPoll >= this.pollMs) {
      this.lastPoll = 0;
      const s = this.pctx.session();
      if (s?.mirror?.connected) void s.pollProvider(this.slot).catch(() => {});
    }
  }

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    this.rangePre = 0;
    this.rangePost = 0;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));

    const s = this.pctx.session();
    const p = s?.providers.find((x) => x.slot === this.slot);
    const snap = p?.lastSnapshot;
    // Resolve the name live — dock panels restored before the mirror hello
    // would otherwise show "slot N" forever.
    if (p?.name) this.name = p.name;
    const hdr = `PROVIDER · ${this.name.toUpperCase()}`;
    this.drawText(pass, MONO(700), 10, hdr, r.x + this.z(12), r.y + this.z(16), hex(t.textFaint));
    pass.rect(r.x, r.y + this.z(24), r.w, 1, hex(t.borderSoft));
    if (!snap) {
      this.drawText(pass, MONO(), 11,
        s?.mirror?.connected ? "waiting for snapshot…" : "no mirror channel — provider panels need the devtools mirror",
        r.x + this.z(12), r.y + this.z(42), hex(t.textFaint));
      this.contentH = this.z(60);
      return;
    }
    if (snap.status === "error") {
      this.drawText(pass, MONO(), 11, `provider error: ${snap.statusMsg ?? "unknown"}`,
        r.x + this.z(12), r.y + this.z(42), hex(t.err));
    }
    this.rangePre = pass.quadCount;
    const endY = this.drawSections(pass, snap, this.slot,
      r.x + this.z(12), r.y + this.z(32) - this.scrollY, r.w - this.z(24), p?.lastPush ?? 0);
    this.contentH = endY - (r.y + this.z(32)) + this.z(32) + this.z(20);
    this.rangePost = pass.quadCount;
  }

  private rangePre = 0;
  private rangePost = 0;
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    const band: [number, number, number, number] = [r.x, r.y + this.z(26), r.w, Math.max(0, r.h - this.z(26))];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }
}
