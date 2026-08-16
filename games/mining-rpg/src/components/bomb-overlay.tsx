// ============================================================================
// BombOverlay — renders active bombs and explosion flashes as DOM elements.
//
// Reads bomb/explosion positions from the renderer each frame via
// requestAnimationFrame and positions DOM elements at the correct screen
// location using the camera's world-to-screen transform.
// ============================================================================

import { useEffect, useRef } from "react";
import { worldToScreen, type Camera2D } from "../renderer/camera";
import { useGameStore } from "../stores/game-store";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 12,
  overflow: "hidden",
};

interface RenderedBomb {
  x: number;
  y: number;
  progress: number;
}

interface RenderedExplosion {
  x: number;
  y: number;
  progress: number;
}

export function BombOverlay() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let running = true;

    const tick = () => {
      if (!running) return;
      const container = containerRef.current;
      const store = useGameStore.getState();
      const renderer = store.renderer as
        | {
            getBombs?: () => RenderedBomb[];
            getExplosions?: () => RenderedExplosion[];
            getCamera?: () => Camera2D;
          }
        | null;
      if (container && renderer?.getBombs && renderer?.getExplosions && renderer?.getCamera) {
        const cam = renderer.getCamera();
        const dpr = window.devicePixelRatio || 1;
        const bombs = renderer.getBombs();
        const explosions = renderer.getExplosions();

        // Build inner HTML for bombs + explosions
        let html = "";
        for (const b of bombs) {
          const s = worldToScreen(cam, b.x, b.y);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;
          const size = 8;
          html += `<div style="position:absolute;left:${cssX - size / 2}px;top:${cssY - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;background:#1a1a1a;border:1.5px solid #4a4a4a;box-shadow:0 0 4px rgba(255,100,0,0.5);"></div>`;
        }
        for (const e of explosions) {
          const s = worldToScreen(cam, e.x, e.y);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;
          const radius = 6 * 4 * (0.3 + e.progress * 0.7); // BOMB_RADIUS * zoom-ish
          const alpha = 1 - e.progress;
          html += `<div style="position:absolute;left:${cssX - radius}px;top:${cssY - radius}px;width:${radius * 2}px;height:${radius * 2}px;border-radius:50%;background:radial-gradient(circle,rgba(255,200,0,${alpha * 0.8}) 0%,rgba(255,100,0,${alpha * 0.5}) 40%,rgba(200,50,0,0) 70%);"></div>`;
        }
        container.innerHTML = html;
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
