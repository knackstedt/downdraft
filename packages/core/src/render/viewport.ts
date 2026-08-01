export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ViewportMode = "split" | "shared";

export class ViewportLayout {
  static compute(
    playerCount: number,
    screenW: number,
    screenH: number,
    mode: ViewportMode = "split",
  ): ViewportRect[] {
    if (playerCount <= 0) return [];
    if (mode === "shared" || playerCount === 1) {
      return fullScreen(playerCount);
    }

    if (playerCount === 2) {
      return split2(screenW, screenH);
    }

    if (playerCount <= 4) {
      return grid4(screenW, screenH, playerCount);
    }

    return gridDynamic(screenW, screenH, playerCount);
  }
}

function fullScreen(count: number): ViewportRect[] {
  const rects: ViewportRect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ x: 0, y: 0, w: 1, h: 1 });
  }
  return rects;
}

function split2(w: number, h: number): ViewportRect[] {
  if (w >= h) {
    return [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ];
  }
  return [
    { x: 0, y: 0, w: 1, h: 0.5 },
    { x: 0, y: 0.5, w: 1, h: 0.5 },
  ];
}

function grid4(w: number, h: number, count: number): ViewportRect[] {
  const rects: ViewportRect[] = [];
  const halfW = 0.5;
  const halfH = 0.5;

  const positions = [
    { x: 0, y: 0 },
    { x: halfW, y: 0 },
    { x: 0, y: halfH },
    { x: halfW, y: halfH },
  ];

  for (let i = 0; i < count; i++) {
    rects.push({
      x: positions[i].x,
      y: positions[i].y,
      w: halfW,
      h: halfH,
    });
  }
  return rects;
}

function gridDynamic(w: number, h: number, count: number): ViewportRect[] {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = 1 / cols;
  const cellH = 1 / rows;

  const rects: ViewportRect[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    rects.push({
      x: col * cellW,
      y: row * cellH,
      w: cellW,
      h: cellH,
    });
  }
  return rects;
}

export function viewportRectToPixels(
  rect: ViewportRect,
  screenW: number,
  screenH: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.floor(rect.x * screenW),
    y: Math.floor(rect.y * screenH),
    w: Math.floor(rect.w * screenW),
    h: Math.floor(rect.h * screenH),
  };
}
