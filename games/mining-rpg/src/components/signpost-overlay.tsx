// ============================================================================
// SignpostOverlay — renders a visual signpost marker at the surface spawn
// point so the player can see where to go to sell their inventory.
//
// Reads the signpost world position from the renderer and converts to screen
// coords using the camera transform. The signpost is drawn as a DOM element
// (a wooden post with a "SELL" sign) that stays anchored to the world position.
// ============================================================================

import { useEffect, useRef } from "react";
import { worldToScreen, type Camera2D } from "../renderer/camera";
import { useGameStore } from "../stores/game-store";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 11,
  overflow: "hidden",
};

export function SignpostOverlay() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let running = true;

    const tick = () => {
      if (!running) return;
      const container = containerRef.current;
      const store = useGameStore.getState();
      const renderer = store.renderer as
        | { getCamera?: () => Camera2D; getSignpostPos?: () => { x: number; y: number } }
        | null;

      if (container && renderer?.getCamera && renderer?.getSignpostPos) {
        const cam = renderer.getCamera();
        const pos = renderer.getSignpostPos();
        const dpr = window.devicePixelRatio || 1;
        const screen = worldToScreen(cam, pos.x, pos.y);
        const cssX = screen.x / dpr;
        const cssY = screen.y / dpr;

        // Only render if the signpost is on-screen (with some margin)
        const margin = 100;
        const onScreen =
          cssX > -margin && cssX < window.innerWidth + margin &&
          cssY > -margin && cssY < window.innerHeight + margin;

        if (onScreen) {
          // Signpost: a wooden post with a "SELL" sign board on top.
          // The post bottom is anchored at the surface Y.
          const postHeight = 40;
          const signW = 50;
          const signH = 20;
          const postTop = cssY - postHeight;
          container.innerHTML = `
            <div style="position:absolute;left:${cssX - 2}px;top:${postTop}px;width:4px;height:${postHeight}px;background:linear-gradient(to bottom,#6b4226,#4a2d1a);border-radius:1px;"></div>
            <div style="position:absolute;left:${cssX - signW / 2}px;top:${postTop - signH - 2}px;width:${signW}px;height:${signH}px;background:#8b5a2b;border:1.5px solid #5a3a1a;border-radius:3px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:11px;font-weight:bold;color:#ffd700;text-shadow:0 0 3px rgba(0,0,0,0.8);">SELL</div>
            <div style="position:absolute;left:${cssX - signW / 2}px;top:${postTop}px;width:4px;height:4px;background:#4a2d1a;"></div>
            <div style="position:absolute;left:${cssX + signW / 2 - 4}px;top:${postTop}px;width:4px;height:4px;background:#4a2d1a;"></div>
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

    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={containerRef} style={overlayStyle} />;
}
