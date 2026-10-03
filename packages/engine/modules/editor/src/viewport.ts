// ============================================================================
// EditorViewport — viewport-side editor input: TransformGizmo wiring,
// click-to-select via the scene adapter, and editor hotkeys.
//
// Input priority: pointer handlers run at 45 — after Blitz UI panels (-10,
// which stopPropagation on panel hits) and the gizmo's own drags, but
// before the game camera (~100). Hotkeys run at 90 so focused panel inputs
// (which stopPropagation while editing) keep their keys.
//
// Gizmo drags dispatch `transform.set` per update inside a journal
// transaction — one drag = one undo entry, and the live ECS value drives
// the adapter's visuals every frame.
// ============================================================================

import { createLogger, type RendererModuleContext } from "@downdraft/engine";
import { TransformGizmo } from "@downdraft/engine/modules/devtools";

import type { EditorContext } from "./editor-context";
import type { EditorShell, GizmoModeName } from "./shell";

const log = createLogger("info");

const MODE_KEYS: Record<string, GizmoModeName> = {
  KeyW: "translate", KeyE: "rotate", KeyR: "scale",
};

export class EditorViewport {
  readonly gizmo: TransformGizmo;
  private ctx: RendererModuleContext;
  private editor: EditorContext;
  private shell: EditorShell | null = null;
  private dragging = false;
  private lastCamera: Parameters<TransformGizmo["hitTest"]>[4] | null = null;
  private canvasW = 0;
  private canvasH = 0;

  constructor(ctx: RendererModuleContext, editor: EditorContext) {
    this.ctx = ctx;
    this.editor = editor;
    this.gizmo = new TransformGizmo(ctx.getDevice(), ctx.getFormat());
  }

  attachShell(shell: EditorShell): void {
    this.shell = shell;
    shell.onGizmoMode = (mode) => this.gizmo.setMode(mode);
  }

  start(): void {
    const bus = this.ctx.getInputBus();
    const canvas = this.ctx.getSurface();
    const editor = this.editor;
    const gizmo = this.gizmo;

    gizmo.onTransformUpdate = (t) => {
      const key = editor.selection.primary();
      if (!key || !this.dragging) return;
      const params: Record<string, unknown> = { entity: key };
      if (t.position) params.position = t.position;
      if (t.rotation) params.rotation = t.rotation;
      if (t.scale) params.scale = t.scale;
      void editor.commands.dispatch("transform.set", params, "ui")
        .catch((e) => log.error("editor", `gizmo drag: ${e}`));
    };

    bus.onPointerDown((e: PointerEvent, ctrl) => {
      if (!this.lastCamera) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // 1) Gizmo hit-test first when an entity is selected.
      if (gizmo.isVisible()) {
        const part = gizmo.hitTest(mx, my, this.canvasW, this.canvasH, this.lastCamera);
        if (part) {
          const key = editor.selection.primary()!;
          const t = this.readTransform(key);
          gizmo.startDrag(part, mx, my, this.canvasW, this.canvasH, this.lastCamera, t);
          this.dragging = true;
          editor.commands.beginTransaction(`Drag ${editor.document.label(key)}`, "ui");
          ctrl.stopPropagation();
          return;
        }
      }

      // 2) Scene picking via the adapter.
      if (e.button !== 0) return;
      const hit = editor.adapter?.pickAt?.(mx, my, this.canvasW, this.canvasH) ?? null;
      if (hit) {
        const shift = e.shiftKey;
        void editor.commands.dispatch(
          shift ? "selection.add" : "selection.set",
          shift ? { entity: hit } : { entities: [hit] },
          "ui",
        ).catch(() => {});
        ctrl.stopPropagation();
      } else {
        void editor.commands.dispatch("selection.clear", {}, "ui").catch(() => {});
      }
    }, 45);

    bus.onPointerMove((e: PointerEvent, ctrl) => {
      if (!this.dragging || !this.lastCamera) return;
      const rect = canvas.getBoundingClientRect();
      gizmo.updateDrag(e.clientX - rect.left, e.clientY - rect.top, this.canvasW, this.canvasH, this.lastCamera);
      ctrl.stopPropagation();
    }, 45);

    bus.onPointerUp(() => {
      if (!this.dragging) return;
      gizmo.endDrag();
      this.dragging = false;
      editor.commands.endTransaction();
    }, 45);

    // Hotkeys — after panels (which consume keys while an input is focused).
    bus.onKeyDown((e: KeyboardEvent) => {
      const d = (id: string, params: Record<string, unknown> = {}) =>
        editor.commands.dispatch(id, params, "ui").catch((err) => log.error("editor", `${id}: ${err}`));

      if (e.ctrlKey || e.metaKey) {
        switch (e.code) {
          case "KeyZ": void (e.shiftKey ? d("editor.redo") : d("editor.undo")); return;
          case "KeyY": void d("editor.redo"); return;
          case "KeyS": void d("scene.save"); e.preventDefault?.(); return;
          case "KeyD": {
            const key = editor.selection.primary();
            if (key) void d("entity.duplicate", { entity: key });
            return;
          }
        }
        return;
      }

      const mode = MODE_KEYS[e.code];
      if (mode) {
        this.gizmo.setMode(mode);
        this.shell?.setGizmoMode(mode);
        return;
      }
      switch (e.code) {
        case "Delete":
        case "Backspace": {
          const key = editor.selection.primary();
          if (key) void d("entity.remove", { entity: key });
          return;
        }
        case "Escape":
          void d("selection.clear");
          return;
      }
    }, 90);

    // Gizmo follows the primary selection.
    this.editor.selection.onChange(() => this.syncGizmo());
    this.editor.document.onChange(() => this.syncGizmo());

    this.ctx.onRenderPass((pass, camera, viewportIdx) => {
      if (viewportIdx !== 0) return;
      this.lastCamera = camera;
      this.canvasW = canvas.width;
      this.canvasH = canvas.height;
      if (this.gizmo.isVisible()) this.gizmo.render(pass, camera);
    });

    this.ctx.onDispose(() => {
      if (this.dragging) {
        this.dragging = false;
        this.editor.commands.abortTransaction();
        this.gizmo.endDrag();
      }
    });
  }

  private readTransform(key: string): {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  } {
    const e = this.editor.parseEntity(key);
    const cid = e ? this.editor.engine.getComponentIdByName(this.editor.transformComponent) : -1;
    const t = e ? this.editor.engine.ecsWorld.getComponent<Record<string, unknown>>(e, cid) : null;
    return {
      position: (t?.["position"] as [number, number, number]) ?? [0, 0, 0],
      rotation: (t?.["rotation"] as [number, number, number, number]) ?? [0, 0, 0, 1],
      scale: (t?.["scale"] as [number, number, number]) ?? [1, 1, 1],
    };
  }

  private syncGizmo(): void {
    const key = this.editor.selection.primary();
    if (!key || !this.editor.isAliveKey(key)) {
      this.gizmo.setVisible(false);
      return;
    }
    const t = this.readTransform(key);
    this.gizmo.setPosition(t.position);
    this.gizmo.setVisible(true);
  }
}
