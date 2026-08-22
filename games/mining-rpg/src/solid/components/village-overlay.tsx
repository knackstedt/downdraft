// ============================================================================
// VillageOverlay — renders NPCs at the surface village near the signpost.
//
// Shows 4 NPC characters (a merchant, a miner, a blacksmith, and an elder)
// positioned around the signpost. Each NPC is drawn as a line-drawn stickman
// matching the player's StickmanPass geometry (same proportions, line-list
// style) so they look like they belong in the same world. When the player
// approaches, each NPC displays a speech bubble with dialogue.
// ============================================================================

import {
    ARM_LEN,
    HEAD_CY,
    HEAD_R,
    HIP_Y,
    LEG_LEN,
    NECK_Y,
    PLAYER_H,
    SHOULDER_Y,
} from "@downdraft/library-stickman";
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

interface NPC {
  name: string;
  color: string;
  offsetX: number; // relative to signpost X
  offsetY: number; // relative to signpost Y (negative = above surface)
  dialogue: string;
}

// NPCs are positioned so their feet rest on the surface. The stickman's
// top (py) is PLAYER_H cells above the feet, so offsetY = -PLAYER_H
// places the top at surfaceY - PLAYER_H, with feet at surfaceY.
const NPC_TOP_OFFSET = -PLAYER_H; // py = surfaceY + NPC_TOP_OFFSET

const NPCS: NPC[] = [
  {
    name: "Merchant Olara",
    color: "#4caf50",
    offsetX: -22,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "Welcome, miner! Sell your ore at the signpost — I'll pay top gold for quality.",
  },
  {
    name: "Old Miner Garrick",
    color: "#b87333",
    offsetX: 16,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "I once dug to the Gold Zone... watch out for cave-ins down there, lad.",
  },
  {
    name: "Blacksmith Hilda",
    color: "#ff9800",
    offsetX: -32,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "Bring me ore and coal — I'll smelt it into bars worth twice the raw price!",
  },
  {
    name: "Elder Thorin",
    color: "#9c27b0",
    offsetX: 28,
    offsetY: NPC_TOP_OFFSET,
    dialogue: "The depths hold treasures and dangers. Press O for the shop, F4 for achievements.",
  },
];

const NPC_INTERACT_RADIUS = 8; // cells

// Stickman proportions in world cells, imported from @downdraft/library-stickman
// (single source of truth shared with the WGSL player shader).
//   head center: (cx, topY + HEAD_CY), radius HEAD_R
//   neck:        (cx, topY + NECK_Y)
//   shoulder:    (cx, topY + SHOULDER_Y)
//   hip:         (cx, topY + HIP_Y)
//   handL:       (cx + swing, topY + SHOULDER_Y + ARM_LEN)
//   handR:       (cx - swing, topY + SHOULDER_Y + ARM_LEN)
//   footL:       (cx + swing, topY + HIP_Y + LEG_LEN)
//   footR:       (cx - swing, topY + HIP_Y + LEG_LEN)

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

  // SVG coordinate system: (0,0) = top-left of the SVG element. We position
  // the SVG at (0,0) covering the full screen so that SVG coordinates = page
  // (CSS) coordinates. If we positioned the SVG at (svgLeft, svgTop) instead,
  // the internal coordinates would be double-offsetted (svgLeft + headCx in
  // page space), making the stickman appear at ~2x the intended position and
  // slide at 2x speed when the camera moves.
  return `<svg style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;" xmlns="http://www.w3.org/2000/svg">${lines.join("")}</svg>`;
}

export function VillageOverlay() {
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    let raf = 0;
    let running = true;
    let frame = 0;

    const tick = () => {
      if (!running) return;
      const container = containerRef;
      const snap = rendererSnapshot();

      if (container && snap && snap.npcSurfaceYs.length >= NPCS.length) {
        const cam: Camera2D = { x: snap.camX, y: snap.camY, zoom: snap.camZoom, width: snap.camWidth, height: snap.camHeight };
        const dpr = window.devicePixelRatio || 1;
        const scale = cam.zoom / dpr; // world cells → CSS px
        const sign = { x: snap.signpostX, y: snap.signpostY };
        const player = { x: snap.playerX, y: snap.playerY };
        frame++;

        let html = "";
        // Only render NPCs when the player is near the surface (within 50 cells
        // vertically). When the player is deep underground, the NPCs would be
        // far away with no terrain context around them, looking like floating
        // stickmen that parallax against the empty background.
        const playerSurfaceY = snap.npcSurfaceYs[0]; // approximate using first NPC's surface
        const playerDepth = Math.abs(player.y - playerSurfaceY);
        if (playerDepth > 50) {
          container.innerHTML = "";
          raf = requestAnimationFrame(tick);
          return;
        }

        for (let ni = 0; ni < NPCS.length; ni++) {
          const npc = NPCS[ni];
          const wx = sign.x + npc.offsetX;
          // Use the ACTUAL surface height at this NPC's X position, not the
          // signpost's Y. The surface has rolling hills (fBm noise), so each
          // NPC must be placed at its own column's surface height — otherwise
          // they float above/below the terrain and appear to parallax when
          // the camera moves vertically.
          const surfaceYAtNpc = snap.npcSurfaceYs[ni];
          const wy = surfaceYAtNpc + npc.offsetY; // top of bounding box (like player py)
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

    onCleanup(() => {
      running = false;
      cancelAnimationFrame(raf);
    });
  });

  return <div ref={containerRef} style={overlayStyle} />;
}
