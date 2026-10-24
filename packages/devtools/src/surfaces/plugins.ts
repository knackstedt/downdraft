// ============================================================================
// plugins.ts — downdraft plugin detection + provider panel launcher.
// Shows: detected plugins (via target MCP plugin_*), provider panels
// (mirror hello), inspector methods available, and channel capabilities.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens, chroma } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import { dockAdd } from "../ui/drawer";

const LINE_H_ = 20;

export class PluginsSurface extends TextSurface {
  private pctx: PanelCtx;
  private hit: { x: number; y: number; w: number; h: number; act: () => void }[] = [];
  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    const bus = this.ctx.getInputBus();
    this.unsubs.push(bus.onPointerDown((e, ctrl) => {
      if (!this.active || !this.inRect(e.clientX, e.clientY)) return;
      const hz = this.hit.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hz) { ctrl.stopPropagation(); hz.act(); return; }
    }, -20));
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));
    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + 14, r.y + 26, hex(t.textFaint));
      return;
    }
    let y = r.y + 10 - this.scrollY;
    let x = r.x + 14;

    // Header + refresh.
    this.drawText(pass, MONO(600), 10, "PLUGINS", x, y + 12, hex(t.textFaint));
    const rw = 64;
    pass.rect(r.x + r.w - rw - 12, y, rw, 18, hex(t.bgRaised));
    this.outline(pass, r.x + r.w - rw - 12, y, rw, 18, hex(t.borderSoft));
    this.drawText(pass, MONO(), 10, "refresh", r.x + r.w - rw - 4, y + 13, hex(t.textDim));
    this.hit.push({ x: r.x + r.w - rw - 12, y, w: rw, h: 18, act: () => { void s.refreshPlugins(); } });
    y += 24;

    if (!s.plugins.length) {
      this.drawText(pass, MONO(), 11,
        s.caps.has("plugins") ? "no plugins detected (plugin_list returned empty)" : "target has no plugin tools — needs MCP plugin_* tools",
        x, y + 10, hex(t.textFaint));
      y += 30;
    } else {
      s.plugins.forEach((p) => {
        if (y + this.z(LINE_H_) > r.y && y < r.y + r.h) {
          const stateClr = p.state === "error" ? t.err : p.state === "loaded" ? t.ok : t.warn;
          pass.rect(x, y + 2, 8, 8, hex(stateClr));
          this.drawText(pass, MONO(600), 11, `${p.name} ${p.version ? `v${p.version}` : ""}`, x + 14, y + this.z(LINE_H_) - 6, hex(t.text));
          this.drawText(pass, MONO(), 10, [p.format, p.tier, p.state, p.error].filter(Boolean).join(" · "),
            x + 14 + this.measure(MONO(600), 11, p.name) + 20, y + this.z(LINE_H_) - 6, hex(t.textDim), r.w - 280);
        }
        y += this.z(LINE_H_);
      });
      y += 8;
    }

    // Provider panels (custom app panels via mirror).
    this.drawText(pass, MONO(600), 10, "PROVIDER PANELS (app-fed)", x, y + 12, hex(t.textFaint));
    y += 20;
    if (!s.providers.length) {
      this.drawText(pass, MONO(), 11, "none — apps expose providers via initDevTools({providers})", x, y + 10, hex(t.textFaint));
      y += 24;
    } else {
      s.providers.forEach((p) => {
        if (y + 26 > r.y && y < r.y + r.h) {
          pass.rect(x, y, Math.min(340, r.w - 40), 24, hex(t.bgRaised));
          this.outline(pass, x, y, Math.min(340, r.w - 40), 24, hex(t.borderSoft));
          this.drawText(pass, MONO(600), 11, p.name, x + 10, y + 16, hex(t.text));
          this.drawText(pass, MONO(), 9, `slot ${p.slot}${p.lastPush ? " · live" : ""}`, x + 14 + this.measure(MONO(600), 11, p.name), y + 16, hex(t.textFaint));
          const py = y;
          this.hit.push({
            x, y: py, w: Math.min(340, r.w - 40), h: 24,
            act: () => {
              // Open the provider panel in the bottom dock.
              dockAdd("bottom", `panel:${p.slot}`, true);
            },
          });
        }
        y += 30;
      });
      y += 6;
    }

    // Capabilities + inspector methods.
    this.drawText(pass, MONO(600), 10, "CAPABILITIES", x, y + 12, hex(t.textFaint));
    y += 20;
    const caps = [...s.caps].sort();
    caps.forEach((c) => {
      const w = this.measure(MONO(), 10, c) + 12;
      if (x + w > r.x + r.w - 20) { x = r.x + 14; y += 24; }
      if (y + 20 > r.y && y < r.y + r.h) {
        pass.rect(x, y, w, 18, chroma(t.ok, 0.12));
        this.outline(pass, x, y, w, 18, chroma(t.ok, 0.5));
        this.drawText(pass, MONO(), 10, c, x + 6, y + 13, hex(t.ok));
      }
      x += w + 6;
    });
    y += 34; x = r.x + 14;

    if (s.inspectorMethods.length) {
      this.drawText(pass, MONO(600), 10, `INSPECTOR METHODS (${s.inspectorMethods.length})`, x, y + 12, hex(t.textFaint));
      y += 20;
      s.inspectorMethods.forEach((m) => {
        if (y + 16 > r.y && y < r.y + r.h) {
          this.drawText(pass, MONO(), 10, m, x + 8, y + 12, hex(t.textDim));
        }
        y += 16;
      });
    }
    this.contentH = y + this.scrollY - r.y + 16;
  }

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }
}
