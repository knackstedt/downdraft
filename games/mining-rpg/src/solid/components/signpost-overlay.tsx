// ============================================================================
// SignpostOverlay — renders a visual signpost marker at the surface spawn
// point so the player can see where to go to sell their inventory.
//
// Reads the signpost world position from the renderer and converts to screen
// coords using the camera transform. The signpost is drawn as DOM elements
// (a wooden post with a "SELL" sign) that scale with the camera zoom —
// matching the NPCs and player stickman which are all in world-space units.
// ============================================================================

import type { JSX } from "solid-js";
import { onCleanup, onMount } from "solid-js";
import { worldToScreen, type Camera2D } from "../../renderer/camera";
import { rendererSnapshot } from "../stores/game-store";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  "pointer-events": "none",
  "z-index": "11",
  overflow: "hidden",
};

// Signpost dimensions in world cells (not pixels). These scale with zoom
// so the signpost stays proportional to the terrain and NPCs.
const POST_HEIGHT_CELLS = 5;   // post sticks 5 cells above the surface
const POST_WIDTH_CELLS = 0.5;
const SIGN_W_CELLS = 6;
const SIGN_H_CELLS = 2.5;

export function SignpostOverlay() {
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    let raf = 0;
    let running = true;

    const tick = () => {
      if (!running) return;
      const container = containerRef;
      const snap = rendererSnapshot();
      if (container && snap) {
        const cam: Camera2D = { x: snap.camX, y: snap.camY, zoom: snap.camZoom, width: snap.camWidth, height: snap.camHeight };
        const pos = { x: snap.signpostX, y: snap.signpostY };
        const dpr = window.devicePixelRatio || 1;
        const scale = cam.zoom / dpr; // world cells → CSS px
        const screen = worldToScreen(cam, pos.x, pos.y);
        const cssX = screen.x / dpr;
        const cssY = screen.y / dpr;

        // Only render if the signpost is on-screen (with some margin)
        const margin = 100;
        const onScreen =
          cssX > -margin && cssX < window.innerWidth + margin &&
          cssY > -margin && cssY < window.innerHeight + margin;

        if (onScreen) {
          // Scale dimensions by zoom
          const postH = POST_HEIGHT_CELLS * scale;
          const postW = Math.max(1, POST_WIDTH_CELLS * scale);
          const signW = SIGN_W_CELLS * scale;
          const signH = SIGN_H_CELLS * scale;
          const postTop = cssY - postH;
          const fontSize = Math.max(7, Math.min(16, signH * 0.55));
          const borderWidth = Math.max(1, 1.5 * scale * 0.3);

          container.innerHTML = `
            <div style="position:absolute;left:${cssX - postW / 2}px;top:${postTop}px;width:${postW}px;height:${postH}px;background:linear-gradient(to bottom,#6b4226,#4a2d1a);border-radius:${Math.max(1, scale * 0.2)}px;"></div>
            <div style="position:absolute;left:${cssX - signW / 2}px;top:${postTop - signH - 2}px;width:${signW}px;height:${signH}px;background:#8b5a2b;border:${borderWidth}px solid #5a3a1a;border-radius:${Math.max(1, scale * 0.4)}px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:${fontSize}px;font-weight:bold;color:#ffd700;text-shadow:0 0 3px rgba(0,0,0,0.8);">SELL</div>
            <div style="position:absolute;left:${cssX - signW / 2}px;top:${postTop}px;width:${Math.max(2, postW * 1.5)}px;height:${Math.max(2, postW * 1.5)}px;background:#4a2d1a;"></div>
            <div style="position:absolute;left:${cssX + signW / 2 - Math.max(2, postW * 1.5)}px;top:${postTop}px;width:${Math.max(2, postW * 1.5)}px;height:${Math.max(2, postW * 1.5)}px;background:#4a2d1a;"></div>
          `;
        } else {
          // Off-screen: render a directional arrow pointing toward the signpost
          const clampedX = Math.max(30, Math.min(window.innerWidth - 30, cssX));
          const clampedY = Math.max(30, Math.min(window.innerHeight - 30, cssY));
          const angle = Math.atan2(cssY - clampedY, cssX - clampedX);
          const arrowSize = 16;
          container.innerHTML = `
            <div style="position:absolute;left:${clampedX - 20}px;top:${clampedY - 20}px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;">
              <div style="font-size:${arrowSize}px;color:#ffd700;transform:rotate(${angle}rad);text-shadow:0 0 4px rgba(0,0,0,0.8);">➤</div>
            </div>
            <div style="position:absolute;left:${clampedX + 15}px;top:${clampedY - 8}px;font-family:monospace;font-size:10px;color:#ffd700;text-shadow:0 0 3px rgba(0,0,0,0.8);">SELL</div>
          `;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    onCleanup(() => {
      running = false;
      cancelAnimationFrame(raf);
    });
  });

  return <div ref={containerRef} style={overlayStyle} />;
}
