import { CameraMode } from "@shared/types";
import React from "react";
import { useGameStore } from "../stores/gameStore";

export type ToolAction = "build" | "delete" | "rotate" | "gun" | "shovel";

interface ReticuleProps {
  cameraMode: CameraMode;
  toolAction: ToolAction;
  isFishing: boolean;
  size: number;
}

// Each shape is 8 line segments: [x1, y1, x2, y2]
type Seg = [number, number, number, number];
type Shape = Seg[];

const CX = 20, CY = 20;
const D: Seg = [CX, CY, CX, CY]; // degenerate — zero-length at center

const SHAPES: Record<ToolAction, Shape> = {
  // Gun: 4 crosshair lines + 4 degenerate (dot rendered separately)
  gun: [
    [20, 6,  20, 14],   // top
    [20, 26, 20, 34],   // bottom
    [6, 20,  14, 20],   // left
    [26, 20, 34, 20],   // right
    [...D], [...D], [...D], [...D],
  ],
  // Builder: 4 corner brackets, 2 lines each
  build: [
    [13, 13, 13, 17],   // TL vertical
    [13, 13, 17, 13],   // TL horizontal
    [27, 13, 27, 17],   // TR vertical
    [27, 13, 23, 13],   // TR horizontal
    [27, 27, 27, 23],   // BR vertical
    [27, 27, 23, 27],   // BR horizontal
    [13, 27, 13, 23],   // BL vertical
    [13, 27, 17, 27],   // BL horizontal
  ],
  // Delete: X — 2 diagonals + 6 degenerate
  delete: [
    [15, 15, 25, 25],
    [25, 15, 15, 25],
    [...D], [...D], [...D], [...D], [...D], [...D],
  ],
  // Rotate: 270° arc (6 segments) + 2 arrowhead lines
  rotate: [
    [20,    11,    26.36, 13.64],  // arc 0°–45°
    [26.36, 13.64, 29,    20],     // arc 45°–90°
    [29,    20,    26.36, 26.36],  // arc 90°–135°
    [26.36, 26.36, 20,    29],     // arc 135°–180°
    [20,    29,    13.64, 26.36],  // arc 180°–225°
    [13.64, 26.36, 11,    20],     // arc 225°–270°
    [11,    20,    11,    16],     // arrowhead up
    [11,    20,    15,    20],     // arrowhead right
  ],
  // Shovel: diamond — 4 sides + 4 degenerate
  shovel: [
    [20, 10, 30, 20],   // top-right
    [30, 20, 20, 30],   // bottom-right
    [20, 30, 10, 20],   // bottom-left
    [10, 20, 20, 10],   // top-left
    [...D], [...D], [...D], [...D],
  ],
};

const TOOL_COLORS: Record<ToolAction, string> = {
  build:   "#fbbf24", // amber-400
  delete:  "#ef4444", // red-500
  rotate:  "#22d3ee", // cyan-400
  gun:     "#f87171", // red-400
  shovel:  "#4ade80", // green-400
};

const DURATION = 300; // tween ms

export default function Reticule({ cameraMode, toolAction, isFishing, size }: ReticuleProps) {
  const anyOverlayOpen = useGameStore((s) =>
    s.showInventory || s.showMap || s.showBuildMenu || s.showCraftMenu ||
    s.showFishingMinigame || s.showTradeMenu || s.showSettings ||
    s.showPauseMenu || s.showCharacterCustomization || s.showCredits ||
    s.showBuilderWheel || !!s.playerDied
  );
  const [segments, setSegments] = React.useState<Shape>(() =>
    (SHAPES[toolAction] ?? SHAPES.build).map(s => [...s] as Seg)
  );
  const toolRef = React.useRef<ToolAction>(toolAction);

  React.useEffect(() => { toolRef.current = toolAction; }, [toolAction]);

  // Single persistent rAF loop — handles tweening + continuous rotate spin
  React.useEffect(() => {
    let raf = 0;
    let lastTime = performance.now();
    let tweenStart = 0;
    let fromShape = (SHAPES[toolRef.current] ?? SHAPES.build).map(s => [...s] as Seg);
    let targetTool = toolRef.current;
    let isTweening = false;
    let rotateAngle = 0;
    let currentSegs = fromShape.map(s => [...s] as Seg);

    const loop = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;

      // Detect tool change → start new tween from current positions
      if (toolRef.current !== targetTool) {
        fromShape = currentSegs.map(s => [...s] as Seg);
        targetTool = toolRef.current;
        tweenStart = now;
        isTweening = true;
      }

      if (isTweening) {
        const elapsed = now - tweenStart;
        const t = Math.min(elapsed / DURATION, 1);
        // ease-in-out cubic
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const target = SHAPES[targetTool] ?? SHAPES.build;
        currentSegs = fromShape.map((from, i) => {
          const to = target[i];
          return [
            from[0] + (to[0] - from[0]) * eased,
            from[1] + (to[1] - from[1]) * eased,
            from[2] + (to[2] - from[2]) * eased,
            from[3] + (to[3] - from[3]) * eased,
          ] as Seg;
        });
        setSegments(currentSegs);
        if (t >= 1) {
          isTweening = false;
          rotateAngle = 0;
        }
      } else if (targetTool === "rotate") {
        // Continuous spin — bake rotation into line endpoints
        rotateAngle += (dt / 3000) * Math.PI * 2;
        const cos = Math.cos(rotateAngle);
        const sin = Math.sin(rotateAngle);
        currentSegs = (SHAPES.rotate).map(seg => {
          const rot = (x: number, y: number): [number, number] => {
            const dx = x - CX, dy = y - CY;
            return [CX + dx * cos - dy * sin, CY + dx * sin + dy * cos];
          };
          const [x1, y1] = rot(seg[0], seg[1]);
          const [x2, y2] = rot(seg[2], seg[3]);
          return [x1, y1, x2, y2] as Seg;
        });
        setSegments(currentSegs);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (cameraMode !== CameraMode.FirstPerson || isFishing || anyOverlayOpen) return null;

  const color = TOOL_COLORS[toolAction] ?? "#94a3b8";

  return (
    <div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
      style={{ color, transition: "color 300ms ease-in-out" }}
    >
      <style>{`
        @keyframes reticule-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
        .reticule-dot { transition: opacity 300ms ease-in-out; }
        .reticule-dot-active { animation: reticule-pulse 1.5s ease-in-out infinite; }
      `}</style>
      <svg width={size} height={size} viewBox="0 0 40 40">
        {segments.map((seg, i) => {
          const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
          if (len < 0.01) return null;
          return (
            <line
              key={i}
              x1={seg[0]} y1={seg[1]} x2={seg[2]} y2={seg[3]}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          );
        })}
        {/* Gun center dot — pulses, fades in/out */}
        <circle
          cx={CX} cy={CY} r="1.5"
          fill="currentColor"
          className={`reticule-dot ${toolAction === "gun" ? "reticule-dot-active" : ""}`}
          style={{ opacity: toolAction === "gun" ? 1 : 0 }}
        />
      </svg>
    </div>
  );
}
