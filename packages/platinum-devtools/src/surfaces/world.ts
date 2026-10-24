// ============================================================================
// world.ts — the "World" tab. Rolls the engine's sim/scene/game provider
// panels into one coherent surface: sim speed + control row up top, world
// stats, entity/state inspectors, and any bespoke game sections below.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { MONO } from "./text-surface";
import { SnapSurface, type SectionHit } from "./snapshot-view";
import { hex, tokens } from "../app/theme";
import { drawSeries, fmtValue, laneColor } from "./charts";
import type { PanelCtx } from "../ui/panels";
import type { TargetSession } from "../targets/session";

/** Provider names that roll up here instead of getting their own tab. */
const WORLD_PANELS = ["sim", "scene", "target-state", "game"] as const;

export class WorldSurface extends SnapSurface {
  private pctx: PanelCtx;
  private hit: SectionHit[] = [];
  private lastPoll = 0;
  private statePoll = 0;
  private worldState: unknown = null;
  private worldErr = "";
  private worldAt = 0;
  private collapsed = new Set<string>();

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    this.setHistScope("world");
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
    if (this.lastPoll >= 800) {
      this.lastPoll = 0;
      const s = this.pctx.session();
      if (s?.mirror?.connected) {
        WORLD_PANELS.forEach((n) => {
          if (s.provider(n)) void s.pollProvider(n).catch(() => {});
        });
      }
    }
    // World inspector — the target's get_world_state MCP tool (games expose
    // entities/state through it). 2s cadence.
    this.statePoll += dt * 1000;
    if (this.statePoll >= 2000) {
      this.statePoll = 0;
      const s = this.pctx.session();
      if (s && s.mcp && !this.stateInflight) {
        this.stateInflight = true;
        void s.mcpCall<Record<string, unknown>>("get_world_state")
          .then((res) => {
            this.stateInflight = false;
            if (res && typeof res === "object" && "error" in res) {
              this.worldErr = String((res as { error: unknown }).error);
            } else { this.worldState = res; this.worldErr = ""; this.worldAt = Date.now(); }
            this.dirty = true;
          })
          .catch(() => { this.stateInflight = false; });
      }
    }
  }

  private stateInflight = false;

  private contentH = 0;
  protected contentHeight(): number { return this.contentH; }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    this.hit = [];
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgPanel));

    const s = this.pctx.session();
    if (!s) {
      this.drawText(pass, MONO(), 11, "no target attached", r.x + this.z(14), r.y + this.z(26), hex(t.textFaint));
      return;
    }

    let y = r.y + this.z(14) - this.scrollY;
    let drew = false;

    // Frame pacing strip — the sim's own fps/frame series when published.
    const pacing = [...s.series.values()].filter((m) => /fps|frame|tick/i.test(m.id + m.label));
    if (pacing.length) {
      drew = true;
      this.drawText(pass, MONO(700), 12, "FRAME PACING", r.x + this.z(14), y + this.z(10), hex(t.accent));
      y += this.z(24);
      pacing.slice(0, 3).forEach((m, i) => {
        const ch = this.z(46);
        if (y + ch > r.y && y < r.y + r.h) {
          pass.rect(r.x + this.z(10), y, r.w - this.z(20), ch, hex(t.bgRaised));
          this.drawText(pass, MONO(700), 10, `${m.label}  ${fmtValue(m.v[m.v.length - 1] ?? 0, m.unit)}`,
            r.x + this.z(18), y + this.z(14), hex(t.text));
          drawSeries(pass, m, r.x + this.z(14), y + this.z(18), r.w - this.z(28), ch - this.z(20), { color: laneColor(i), windowSec: 60 });
        }
        y += ch + this.z(6);
      });
      y += this.z(8);
    }

    // ── World inspector — target's get_world_state MCP tool ──
    if (this.worldState || this.worldErr || s.mcp) {
      if (y > r.y - this.z(20) && y < r.y + r.h) {
        this.drawText(pass, MONO(700), 12, "WORLD INSPECTOR", r.x + this.z(14), y + this.z(10), hex(t.accent));
        const note = this.worldErr ? this.worldErr
          : this.worldAt ? `get_world_state · ${((Date.now() - this.worldAt) / 1000).toFixed(0)}s ago` : "get_world_state · …";
        this.drawText(pass, MONO(), 9, note, r.x + this.z(14) + this.measure(MONO(700), 12, "WORLD INSPECTOR") + this.z(10),
          y + this.z(11), hex(this.worldErr ? t.err : t.textFaint), r.w * 0.6);
      }
      y += this.z(24);
      drew = true;
      y = this.drawJson(pass, this.worldState, "world", r.x + this.z(20), y, r.w - this.z(40), 0);
      y += this.z(10);
    }

    WORLD_PANELS.forEach((name) => {
      const p = s.provider(name);
      if (!p) return;
      drew = true;
      if (y > r.y - this.z(20) && y < r.y + r.h) {
        this.drawText(pass, MONO(700), 12, name.toUpperCase(), r.x + this.z(14), y + this.z(10), hex(t.accent));
        this.drawText(pass, MONO(), 9, `slot ${p.slot}${p.lastPush ? ` · updated ${((Date.now() - p.lastPush) / 1000).toFixed(0)}s ago` : " · waiting"}`,
          r.x + this.z(14) + this.measure(MONO(700), 12, name.toUpperCase()) + this.z(10), y + this.z(11), hex(t.textFaint));
      }
      y += this.z(24);
      if (!p.lastSnapshot) {
        if (y < r.y + r.h) this.drawText(pass, MONO(), 10, "waiting for snapshot…", r.x + this.z(20), y + this.z(10), hex(t.textFaint));
        y += this.z(24);
        return;
      }
      y = this.drawSections(pass, p.lastSnapshot, p.slot, r.x + this.z(20), y, r.w - this.z(40), p.lastPush ?? 0);
      y += this.z(10);
      pass.rect(r.x + this.z(10), y, r.w - this.z(20), 1, hex(t.borderSoft));
      y += this.z(10);
    });

    if (!drew) {
      this.drawText(pass, MONO(), 11,
        s.mirror?.connected
          ? "target exposes no world providers (sim/scene/game)"
          : "no mirror channel — world view needs the devtools mirror",
        r.x + this.z(14), y + this.z(10), hex(t.textFaint));
    }
    this.contentH = y - (r.y + this.z(14)) + this.scrollY + this.z(14) + this.z(20);
  }

  /** Recursive key/value tree for the world inspector (click ▸ to collapse). */
  private drawJson(pass: GpuTextPass, val: unknown, path: string, x: number, y: number, w: number, depth: number): number {
    const t = tokens();
    const r = this.rect;
    const LH = this.z(17);
    if (val === null || val === undefined) return y;
    if (typeof val !== "object") {
      if (y + LH > r.y && y < r.y + r.h) {
        this.drawText(pass, MONO(), 10, String(val), x, y + LH - 5, hex(t.text), w);
      }
      return y + LH;
    }
    const entries = Array.isArray(val)
      ? val.slice(0, 60).map((v, i) => [String(i), v] as const)
      : Object.entries(val as Record<string, unknown>);
    entries.forEach(([k, v]) => {
      const id = `${path}.${k}`;
      const isObj = v !== null && typeof v === "object";
      const open = !this.collapsed.has(id);
      if (y + LH <= r.y || y >= r.y + r.h) {
        if (isObj && open) y = this.drawJson(pass, v, id, x, y, w, depth + 1);
        else y += LH;
        return;
      }
      if (isObj) {
        const count = Array.isArray(v) ? `${(v as unknown[]).length} items` : `${Object.keys(v).length} keys`;
        this.drawText(pass, MONO(600), 10, `${open ? "▾" : "▸"} ${k}`, x, y + LH - 5, hex(t.text));
        this.drawText(pass, MONO(), 9, count, x + this.measure(MONO(600), 10, `▸ ${k}`) + this.z(10), y + LH - 5, hex(t.textFaint));
        this.pushHit({ x: x - 4, y, w: w - 4, h: LH, act: () => { if (open) this.collapsed.add(id); else this.collapsed.delete(id); } });
        y += LH;
        if (open && depth < 6) y = this.drawJson(pass, v, id, x + this.z(14), y, w - this.z(14), depth + 1);
      } else {
        this.drawText(pass, MONO(), 10, k, x, y + LH - 5, hex(t.textDim));
        const vs = String(v);
        this.drawText(pass, MONO(), 10, vs.length > 120 ? vs.slice(0, 120) + "…" : vs,
          x + this.z(160), y + LH - 5, hex(t.text), w - this.z(160));
        y += LH;
      }
    });
    return y;
  }
}
