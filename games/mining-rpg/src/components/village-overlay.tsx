// ============================================================================
// VillageOverlay — renders NPCs at the surface village near the signpost.
//
// Shows 4 NPC characters (a merchant, a miner, a blacksmith, and an elder)
// positioned around the signpost. When the player approaches, each NPC
// displays a speech bubble with dialogue. Rendered as DOM overlays using
// the camera's world-to-screen transform.
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

interface NPC {
  name: string;
  color: string;
  offsetX: number; // relative to signpost X
  offsetY: number; // relative to signpost Y (negative = above surface)
  dialogue: string;
}

const NPCS: NPC[] = [
  {
    name: "Merchant Olara",
    color: "#4caf50",
    offsetX: -12,
    offsetY: -2,
    dialogue: "Welcome, miner! Sell your ore at the signpost — I'll pay top gold for quality.",
  },
  {
    name: "Old Miner Garrick",
    color: "#b87333",
    offsetX: 10,
    offsetY: -2,
    dialogue: "I once dug to the Gold Zone... watch out for cave-ins down there, lad.",
  },
  {
    name: "Blacksmith Hilda",
    color: "#ff9800",
    offsetY: -2,
    offsetX: -18,
    dialogue: "Bring me ore and coal — I'll smelt it into bars worth twice the raw price!",
  },
  {
    name: "Elder Thorin",
    color: "#9c27b0",
    offsetX: 20,
    offsetY: -2,
    dialogue: "The depths hold treasures and dangers. Press O for the shop, F4 for achievements.",
  },
];

const NPC_INTERACT_RADIUS = 8; // cells

export function VillageOverlay() {
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
            getCamera?: () => Camera2D;
            getSignpostPos?: () => { x: number; y: number };
            getPlayerPos?: () => { x: number; y: number };
          }
        | null;

      if (container && renderer?.getCamera && renderer?.getSignpostPos && renderer?.getPlayerPos) {
        const cam = renderer.getCamera();
        const dpr = window.devicePixelRatio || 1;
        const sign = renderer.getSignpostPos();
        const player = renderer.getPlayerPos();

        let html = "";
        for (const npc of NPCS) {
          const wx = sign.x + npc.offsetX;
          const wy = sign.y + npc.offsetY;
          const s = worldToScreen(cam, wx, wy);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;

          // Only render if on-screen and player is near the surface
          if (cssX < -50 || cssX > window.innerWidth + 50 || cssY < -50 || cssY > window.innerHeight + 50) continue;

          // Check if player is close enough to show dialogue
          const dist = Math.sqrt((player.x - wx) ** 2 + (player.y - wy) ** 2);
          const showDialogue = dist < NPC_INTERACT_RADIUS;

          // NPC body — simple colored figure
          const bodyW = 6;
          const bodyH = 12;
          html += `<div style="position:absolute;left:${cssX - bodyW / 2}px;top:${cssY - bodyH}px;width:${bodyW}px;height:${bodyH}px;background:${npc.color};border-radius:3px 3px 1px 1px;opacity:0.85;"></div>`;
          // Head
          html += `<div style="position:absolute;left:${cssX - 4}px;top:${cssY - bodyH - 6}px;width:8px;height:8px;border-radius:50%;background:#d4a574;opacity:0.85;"></div>`;

          // Name tag (always visible when on screen)
          if (dist < 30) {
            html += `<div style="position:absolute;left:${cssX - 40}px;top:${cssY - bodyH - 20}px;width:80px;text-align:center;font-size:9px;font-family:monospace;color:rgba(255,255,255,0.6);text-shadow:0 0 3px rgba(0,0,0,0.8);">${npc.name}</div>`;
          }

          // Speech bubble when close
          if (showDialogue) {
            const bubbleW = 200;
            const bubbleX = cssX - bubbleW / 2;
            const bubbleY = cssY - bodyH - 50;
            html += `<div style="position:absolute;left:${bubbleX}px;top:${bubbleY}px;width:${bubbleW}px;padding:6px 10px;background:rgba(255,255,255,0.92);border-radius:6px;font-size:11px;font-family:monospace;color:#333;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);">${npc.dialogue}</div>`;
            // Bubble pointer
            html += `<div style="position:absolute;left:${cssX - 5}px;top:${bubbleY + 28}px;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid rgba(255,255,255,0.92);"></div>`;
          }
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
