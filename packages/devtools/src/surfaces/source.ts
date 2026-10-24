// ============================================================================
// source.ts — read-only source viewer: syntax highlighted, line numbers,
// jump-to-line via store.sourceRequest (console links, profiler frames,
// sources list all land here).
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import type { GpuTextPass } from "../text/gpu-text";
import type { RunCache } from "../text/run-cache";
import { TextSurface, MONO } from "./text-surface";
import { hex, tokens } from "../app/theme";
import type { PanelCtx } from "../ui/panels";
import { EditorView } from "./editor";
import { store } from "../app/store";

const LINE_H_ = 16;

export class SourceSurface extends TextSurface {
  private pctx: PanelCtx;
  private viewer: EditorView;
  private loadedUrl = "";
  private lastReq: { url: string; line: number; col: number } | null = null;
  private loadError = "";
  private loading = false;

  constructor(ctx: RendererModuleContext, cache: RunCache, pctx: PanelCtx) {
    super(ctx, cache);
    this.pctx = pctx;
    this.viewer = new EditorView(cache, {
      lineHeight: this.z(LINE_H_), padX: 10, padY: 8, gutterW: 52, readonly: true, lineNumbers: true,
    });
  }

  private async load(url: string, line: number): Promise<void> {
    const s = this.pctx.session();
    if (!s) { this.loadError = "no target"; return; }
    this.loading = true;
    this.loadError = "";
    try {
      // Try CDP Debugger.getScriptSource via matching script.
      const scriptId = [...s.scripts.entries()].find(([, v]) => v.url === url)?.[0];
      if (scriptId && s.cdp?.connected) {
        const res = await s.cdp.call<{ scriptSource?: string }>("Debugger.getScriptSource", { scriptId });
        if (res.scriptSource !== undefined) {
          this.viewer.model.setText(res.scriptSource);
          this.loadedUrl = url;
          this.jumpTo(line);
          return;
        }
      }
      // Fall back to a local file read (file:// or absolute path).
      const path = url.replace(/^file:\/\//, "");
      if (path.startsWith("/")) {
        const { readFileSync } = await import("node:fs");
        this.viewer.model.setText(readFileSync(path, "utf-8"));
        this.loadedUrl = url;
        this.jumpTo(line);
        return;
      }
      this.loadError = `can't fetch ${url}`;
    } catch (e) {
      this.loadError = String(e);
    } finally {
      this.loading = false;
    }
  }

  /** Scroll so `line` sits a few rows below the top and mark it. The jump
   *  must live on the surface scroll — draw() pushes this.scrollY into the
   *  viewer each frame, so writing viewer.scrollY alone is overwritten. */
  private jumpTo(line: number): void {
    const y = Math.max(0, (line - 6) * this.z(LINE_H_));
    this.scrollY = this.scrollTarget = y;
    this.viewer.scrollY = y;
    const row = Math.max(0, Math.min(this.viewer.model.lines.length - 1, line - 1));
    this.viewer.model.anchor = { row, col: 0 };
    this.viewer.model.cursor = { row, col: this.viewer.model.lines[row]!.length };
  }

  protected contentHeight(): number {
    // 26px header + the editor's line count — lets the base clamp keep
    // scrollY (which we hand to the viewer) inside bounds.
    return this.z(26) + this.viewer.contentHeight();
  }

  protected draw(pass: GpuTextPass): void {
    const t = tokens();
    const r = this.rect;
    pass.rect(r.x, r.y, r.w, r.h, hex(t.bgSunken));

    const req = store.getState().sourceRequest;
    if (req && req !== this.lastReq) {
      this.lastReq = req;
      void this.load(req.url, req.line);
    }

    // Header: path + status.
    this.drawText(pass, MONO(600), 10,
      this.loadedUrl ? this.loadedUrl.slice(-90) : (this.loading ? "loading…" : (this.loadError || "no source — click a link in console/profiler")),
      r.x + 12, r.y + 16, hex(this.loadError ? t.err : t.textDim));
    pass.rect(r.x, r.y + 24, r.w, 1, hex(t.borderSoft));

    this.rangePre = pass.quadCount;
    if (this.loadedUrl) {
      this.viewer.scrollY = this.scrollY;
      this.viewer.render(pass, r.x, r.y + 26, r.w, r.h - 26, this.time * 1000);
      this.scrollY = this.viewer.scrollY;
    }
    this.rangePost = pass.quadCount;
  }

  private rangePre = 0;
  private rangePost = 0;
  protected scissorRanges(): { start: number; end: number; scissor: [number, number, number, number] }[] {
    const r = this.rect;
    const full: [number, number, number, number] = [r.x, r.y, r.w, r.h];
    if (this.rangePost <= this.rangePre) return [{ start: 0, end: this.pass.quadCount, scissor: full }];
    const band: [number, number, number, number] = [r.x, r.y + 26, r.w, Math.max(0, r.h - 26)];
    return [
      { start: 0, end: this.rangePre, scissor: full },
      { start: this.rangePre, end: this.rangePost, scissor: band },
      { start: this.rangePost, end: this.pass.quadCount, scissor: full },
    ];
  }
}
