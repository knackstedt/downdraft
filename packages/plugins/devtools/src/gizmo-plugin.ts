// ============================================================================
// TransformGizmoPlugin — RendererPlugin adapter for TransformGizmo
//
// Wires a `TransformGizmo` instance to the renderer plugin system's input bus
// and render-pass hook. The game creates the gizmo (with device/format and
// game-specific `onTransformUpdate` callback) and passes it to
// `createTransformGizmoPlugin(gizmo)`. The plugin handles:
//  - pointerdown → hitTest → startDrag (with capture priority so a gizmo drag
//    blocks the camera controller via stopPropagation)
//  - pointermove → updateDrag (if dragging)
//  - pointerup → endDrag
//  - render-pass hook → gizmo.render(passEncoder, camera)
// ============================================================================

import type { RendererPlugin } from "@downdraft/core";
import type { TransformGizmo } from "./transform-gizmo";

export interface TransformGizmoPluginOptions {
  /**
   * Whether the gizmo is eligible to capture input. When true (default), a
   * successful hitTest on pointerdown calls stopPropagation so the camera
   * controller doesn't also rotate. Set to false if you want the camera to
   * still respond while dragging the gizmo.
   */
  captureInput?: boolean;
  /**
   * Priority for input bus subscriptions. Lower = earlier. Default 50
   * (higher priority than the camera controller's default 100).
   */
  inputPriority?: number;
  /**
   * Returns the current transform of the entity being manipulated, used as
   * the starting state for `startDrag`. If not provided, falls back to the
   * gizmo's position + identity rotation/scale.
   */
  getTransform?: () => {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
}

/**
 * Creates a `RendererPlugin` that wires a `TransformGizmo` to the renderer
 * plugin system's input bus and render-pass hook.
 */
export function createTransformGizmoPlugin(
  gizmo: TransformGizmo,
  opts: TransformGizmoPluginOptions = {},
): RendererPlugin {
  const capture = opts.captureInput ?? true;
  const priority = opts.inputPriority ?? 50;

  let dragging = false;
  // Cached camera + canvas size from the last render-pass hook, used by
  // pointer handlers for hitTest/screenToRay.
  let lastCamera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number; near: number; far: number; aspect: number } | null = null;
  let lastCanvasW = 0;
  let lastCanvasH = 0;

  return {
    name: "devtools:gizmo",
    version: "0.1.0",

    register(ctx) {
      const bus = ctx.getInputBus();
      const canvas = ctx.getCanvas();

      const onPointerDown = (e: PointerEvent, ctrl: { stopPropagation: () => void }) => {
        if (!gizmo.isVisible()) return;
        if (lastCamera === null) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const part = gizmo.hitTest(mx, my, lastCanvasW, lastCanvasH, lastCamera);
        if (part) {
          // Get the current transform of the entity being manipulated.
          // Falls back to the gizmo's position + identity rotation/scale.
          const transform = opts.getTransform
            ? opts.getTransform()
            : {
                position: gizmo.getPosition(),
                rotation: [0, 0, 0, 1] as [number, number, number, number],
                scale: [1, 1, 1] as [number, number, number],
              };
          gizmo.startDrag(
            part,
            mx, my,
            lastCanvasW, lastCanvasH,
            lastCamera,
            transform,
          );
          dragging = true;
          if (capture) ctrl.stopPropagation();
        }
      };

      const onPointerMove = (e: PointerEvent, ctrl: { stopPropagation: () => void }) => {
        if (!dragging || !lastCamera) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        gizmo.updateDrag(mx, my, lastCanvasW, lastCanvasH, lastCamera);
        if (capture) ctrl.stopPropagation();
      };

      const onPointerUp = (_e: PointerEvent, _ctrl: { stopPropagation: () => void }) => {
        if (dragging) {
          gizmo.endDrag();
          dragging = false;
        }
      };

      bus.onPointerDown(onPointerDown, priority);
      bus.onPointerMove(onPointerMove, priority);
      bus.onPointerUp(onPointerUp, priority);

      // Render-pass hook: render the gizmo inside the scene pass and cache
      // camera/canvas info for the pointer handlers.
      ctx.onRenderPass((passEncoder, camera, viewportIdx) => {
        if (viewportIdx !== 0) return; // gizmo only on first viewport
        lastCamera = camera;
        lastCanvasW = canvas.width;
        lastCanvasH = canvas.height;
        if (gizmo.isVisible()) {
          gizmo.render(passEncoder, camera);
        }
      });

      ctx.onDispose(() => {
        dragging = false;
        gizmo.endDrag();
      });
    },
  };
}
