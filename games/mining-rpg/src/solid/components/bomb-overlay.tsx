// ============================================================================
// BombOverlay — renders active bombs and explosion flashes as DOM elements.
//
// Reads bomb/explosion positions from the renderer each frame via
// requestAnimationFrame and positions DOM elements at the correct screen
// location using the camera's world-to-screen transform.
// ============================================================================

import type { JSX } from "solid-js";
import { onCleanup, onMount } from "solid-js";
import { worldToScreen, type Camera2D } from "../../renderer/camera";
import { rendererSnapshot } from "../stores/game-store";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  "pointer-events": "none",
  "z-index": "12",
  overflow: "hidden",
};

export function BombOverlay() {
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
        const dpr = window.devicePixelRatio || 1;
        const bombs = snap.bombs;
        const explosions = snap.explosions;
        const glowsticks = snap.glowsticks;
        const enemies = snap.enemies;

        // Build inner HTML for bombs + explosions + glowsticks
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
        for (const g of glowsticks) {
          const s = worldToScreen(cam, g.x, g.y);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;
          const r = Math.round(g.r * 255);
          const gr = Math.round(g.g * 255);
          const bl = Math.round(g.b * 255);
          // Render as a thin stick (vertical capsule) with a colored glow tip
          const stickH = 10;
          const stickW = 2;
          html += `<div style="position:absolute;left:${cssX - stickW / 2}px;top:${cssY - stickH}px;width:${stickW}px;height:${stickH}px;background:linear-gradient(to bottom,rgb(${r},${gr},${bl}) 0%,#3a3a3a 100%);border-radius:1px;box-shadow:0 0 6px 1px rgba(${r},${gr},${bl},0.7);"></div>`;
          html += `<div style="position:absolute;left:${cssX - 3}px;top:${cssY - stickH - 2}px;width:6px;height:6px;border-radius:50%;background:rgb(${r},${gr},${bl});box-shadow:0 0 8px 3px rgba(${r},${gr},${bl},0.6);"></div>`;
        }
        // Render enemies as colored circles with health bars
        for (const en of enemies) {
          const s = worldToScreen(cam, en.x, en.y);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;
          const sz = en.size;
          const healthPct = Math.max(0, en.health / en.maxHealth);
          const healthColor = healthPct > 0.5 ? "#4caf50" : healthPct > 0.25 ? "#ff9800" : "#f44336";
          // Body
          html += `<div style="position:absolute;left:${cssX - sz / 2}px;top:${cssY - sz / 2}px;width:${sz}px;height:${sz}px;border-radius:50%;background:${en.color};border:1px solid rgba(0,0,0,0.5);box-shadow:0 0 4px ${en.color}88;"></div>`;
          // Health bar above
          html += `<div style="position:absolute;left:${cssX - sz / 2}px;top:${cssY - sz / 2 - 5}px;width:${sz}px;height:2px;background:rgba(0,0,0,0.5);border-radius:1px;"></div>`;
          html += `<div style="position:absolute;left:${cssX - sz / 2}px;top:${cssY - sz / 2 - 5}px;width:${sz * healthPct}px;height:2px;background:${healthColor};border-radius:1px;"></div>`;
        }
        container.innerHTML = html;
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
