// ============================================================================
// VillageOverlay — renders NPCs at the surface village near the signpost.
//
// Shows 4 NPC characters (a merchant, a miner, a blacksmith, and an elder)
// positioned around the signpost. Each NPC is drawn as a line-drawn stickman
// matching the player's StickmanPass geometry (same proportions, line-list
// style) so they look like they belong in the same world. When the player
// approaches, each NPC displays a speech bubble with dialogue.
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

// NPCs are positioned so their feet rest on the surface. The stickman's
// top (py) is 7 cells above the feet (PLAYER_H = 7), so offsetY = -7
// places the top at surfaceY - 7, with feet at surfaceY.
const NPC_TOP_OFFSET = -7; // py = surfaceY + NPC_TOP_OFFSET

const NPCS: NPC[] = [
  {
    name: "Merchant Olara",
    color: "#4caf50",
    offsetX: -12,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "Welcome, miner! Sell your ore at the signpost — I'll pay top gold for quality.",
  },
  {
    name: "Old Miner Garrick",
    color: "#b87333",
    offsetX: 10,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "I once dug to the Gold Zone... watch out for cave-ins down there, lad.",
  },
  {
    name: "Blacksmith Hilda",
    color: "#ff9800",
    offsetX: -18,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "Bring me ore and coal — I'll smelt it into bars worth twice the raw price!",
  },
  {
    name: "Elder Thorin",
    color: "#9c27b0",
    offsetX: 20,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "The depths hold treasures and dangers. Press O for the shop, F4 for achievements.",
  },
];

const NPC_INTERACT_RADIUS = 8; // cells

// Stickman proportions in world cells, matching stickman.wgsl.
// topY = py (top of bounding box). cx = center X.
//   head center: (cx, topY + 1.0), radius 0.8
//   neck:        (cx, topY + 1.8)
//   shoulder:    (cx, topY + 2.2)
//   hip:         (cx, topY + 4.5)
//   handL:       (cx + swing, topY + 3.7)   [armTopY + armLen = 2.2 + 1.5]
//   handR:       (cx - swing, topY + 3.7)
//   footL:       (cx + swing, topY + 6.5)   [hipY + legLen = 4.5 + 2.0]
//   footR:       (cx - swing, topY + 6.5)
const HEAD_CY = 1.0;
const HEAD_R = 0.8;
const NECK_Y = 1.8;
const SHOULDER_Y = 2.2;
const HIP_Y = 4.5;
const ARM_LEN = 1.5;
const LEG_LEN = 2.0;

/** Build an SVG stickman string at the given screen position + scale.
 *  `sx`/`sy` are the screen coords (CSS px) of the NPC's top (py).
 *  `scale` = zoom / dpr (world cells → CSS px).
 *  `color` is the line color.
 *  `idleSway` is the arm/leg swing offset (-1..1).
 */
function stickmanSvg(sx: number, sy: number, scale: number, color: string, idleSway: number): string {
  // Convert world-cell offsets to CSS-pixel offsets
  const px = (wx: number) => sx + wx * scale;
  const py = (wy: number) => sy + wy * scale;
  const cx = 0; // center X offset (0 = at sx)
  const sway = idleSway; // arm/leg swing

  // Joints in screen space
  const headCx = px(cx);
  const headCy = py(HEAD_CY);
  const headR = HEAD_R * scale;
  const neckX = px(cx); const neckY = py(NECK_Y);
  const shoulderX = px(cx); const shoulderY = py(SHOULDER_Y);
  const hipX = px(cx); const hipY = py(HIP_Y);
  const handLX = px(cx + sway); const handLY = py(SHOULDER_Y + ARM_LEN);
  const handRX = px(cx - sway); const handRY = py(SHOULDER_Y + ARM_LEN);
  const footLX = px(cx + sway); const footLY = py(HIP_Y + LEG_LEN);
  const footRX = px(cx - sway); const footRY = py(HIP_Y + LEG_LEN);

  const strokeW = Math.max(1, scale * 0.25);

  // Build SVG lines: head circle + spine + arms + legs + neck
  // Use a single SVG element with all lines
  const lines: string[] = [
    // Head circle
    `<circle cx="${headCx}" cy="${headCy}" r="${headR}" fill="none" stroke="${color}" stroke-width="${strokeW}"/>`,
    // Neck (head bottom → neck)
    `<line x1="${headCx}" y1="${headCy + headR}" x2="${neckX}" y2="${neckY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
    // Spine (neck → hip)
    `<line x1="${neckX}" y1="${neckY}" x2="${hipX}" y2="${hipY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
    // Left arm (shoulder → handL)
    `<line x1="${shoulderX}" y1="${shoulderY}" x2="${handLX}" y2="${handLY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
    // Right arm (shoulder → handR)
    `<line x1="${shoulderX}" y1="${shoulderY}" x2="${handRX}" y2="${handRY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
    // Left leg (hip → footL)
    `<line x1="${hipX}" y1="${hipY}" x2="${footLX}" y2="${footLY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
    // Right leg (hip → footR)
    `<line x1="${hipX}" y1="${hipY}" x2="${footRX}" y2="${footRY}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`,
  ];

  // SVG bounds: head top to feet
  const svgTop = headCy - headR - strokeW;
  const svgBot = footLY + strokeW;
  const svgLeft = Math.min(handLX, footLX, headCx - headR) - strokeW;
  const svgRight = Math.max(handRX, footRX, headCx + headR) + strokeW;
  const svgW = svgRight - svgLeft;
  const svgH = svgBot - svgTop;

  return `<svg style="position:absolute;left:${svgLeft}px;top:${svgTop}px;width:${svgW}px;height:${svgH}px;overflow:visible;" xmlns="http://www.w3.org/2000/svg">${lines.join("")}</svg>`;
}

export function VillageOverlay() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let running = true;
    let frame = 0;

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
        const scale = cam.zoom / dpr; // world cells → CSS px
        const sign = renderer.getSignpostPos();
        const player = renderer.getPlayerPos();
        frame++;

        let html = "";
        for (const npc of NPCS) {
          const wx = sign.x + npc.offsetX;
          const wy = sign.y + npc.offsetY; // top of bounding box (like player py)
          const s = worldToScreen(cam, wx, wy);
          const cssX = s.x / dpr;
          const cssY = s.y / dpr;

          // Only render if on-screen
          if (cssX < -100 || cssX > window.innerWidth + 100 || cssY < -100 || cssY > window.innerHeight + 100) continue;

          // Check if player is close enough to show dialogue
          const dist = Math.sqrt((player.x - wx) ** 2 + (player.y - wy) ** 2);
          const showDialogue = dist < NPC_INTERACT_RADIUS;

          // Idle sway — gentle arm/leg oscillation (matches shader's idle pose)
          const idleSway = Math.sin(frame * 0.05) * 0.05;

          // Draw stickman SVG
          html += stickmanSvg(cssX, cssY, scale, npc.color, idleSway);

          // Name tag (visible when player is within 30 cells)
          if (dist < 30) {
            const nameY = cssY + (HEAD_CY - HEAD_R) * scale - 14;
            html += `<div style="position:absolute;left:${cssX - 50}px;top:${nameY}px;width:100px;text-align:center;font-size:9px;font-family:monospace;color:rgba(255,255,255,0.6);text-shadow:0 0 3px rgba(0,0,0,0.8);pointer-events:none;">${npc.name}</div>`;
          }

          // Speech bubble when close
          if (showDialogue) {
            const bubbleW = 200;
            const bubbleX = cssX - bubbleW / 2;
            const bubbleY = cssY + (HEAD_CY - HEAD_R) * scale - 45;
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
