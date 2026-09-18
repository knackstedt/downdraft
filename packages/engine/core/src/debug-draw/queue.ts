export interface DebugLine {
  from: [number, number, number];
  to: [number, number, number];
  color: [number, number, number, number];
  duration: number;
}

export interface DebugPoint {
  pos: [number, number, number];
  color: [number, number, number, number];
  size: number;
  duration: number;
}

export interface DebugText {
  pos: [number, number, number];
  text: string;
  color: [number, number, number, number];
  screenSpace: boolean;
  duration: number;
}

export class DebugDrawQueue {
  private lines: DebugLine[] = [];
  private points: DebugPoint[] = [];
  private texts: DebugText[] = [];
  private frameCount: number = 0;
  private static readonly MAX_LINES = 10000;
  private static readonly MAX_POINTS = 10000;
  private static readonly MAX_TEXTS = 1000;

  line(
    from: [number, number, number],
    to: [number, number, number],
    color: [number, number, number, number] = [1, 0, 0, 1],
    duration: number = 0,
  ): void {
    if (this.lines.length >= DebugDrawQueue.MAX_LINES) this.lines.shift();
    this.lines.push({ from, to, color, duration });
  }

  point(
    pos: [number, number, number],
    color: [number, number, number, number] = [1, 1, 0, 1],
    size: number = 4,
    duration: number = 0,
  ): void {
    if (this.points.length >= DebugDrawQueue.MAX_POINTS) this.points.shift();
    this.points.push({ pos, color, size, duration });
  }

  text(
    pos: [number, number, number],
    text: string,
    color: [number, number, number, number] = [1, 1, 1, 1],
    screenSpace: boolean = false,
    duration: number = 0,
  ): void {
    if (this.texts.length >= DebugDrawQueue.MAX_TEXTS) this.texts.shift();
    this.texts.push({ pos, text, color, screenSpace, duration });
  }

  aabb(
    min: [number, number, number],
    max: [number, number, number],
    color: [number, number, number, number] = [0, 1, 0, 1],
    duration: number = 0,
  ): void {
    const [minX, minY, minZ] = min;
    const [maxX, maxY, maxZ] = max;
    const corners: [number, number, number][] = [
      [minX, minY, minZ], [maxX, minY, minZ],
      [maxX, maxY, minZ], [minX, maxY, minZ],
      [minX, minY, maxZ], [maxX, minY, maxZ],
      [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ];
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (let i = 0; i < edges.length; i++) {
      this.line(corners[edges[i][0]], corners[edges[i][1]], color, duration);
    }
  }

  getLines(): DebugLine[] {
    return this.lines;
  }

  getPoints(): DebugPoint[] {
    return this.points;
  }

  getTexts(): DebugText[] {
    return this.texts;
  }

  clearFrame(): void {
    this.frameCount++;

    // Keep items with duration > 0 (persistent), decrement their remaining frames.
    // Items with duration === 0 are one-shot (this frame only) — remove them.
    this.lines = this.lines.filter((l) => {
      if (l.duration === 0) return false;
      l.duration--;
      return l.duration > 0;
    });
    this.points = this.points.filter((p) => {
      if (p.duration === 0) return false;
      p.duration--;
      return p.duration > 0;
    });
    this.texts = this.texts.filter((t) => {
      if (t.duration === 0) return false;
      t.duration--;
      return t.duration > 0;
    });
  }

  isEmpty(): boolean {
    return this.lines.length === 0 && this.points.length === 0 && this.texts.length === 0;
  }
}
