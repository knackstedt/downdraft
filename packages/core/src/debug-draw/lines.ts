import { DebugDrawQueue } from "./queue";

export class DebugLines {
  private queue: DebugDrawQueue;

  constructor(queue: DebugDrawQueue) {
    this.queue = queue;
  }

  line(
    from: [number, number, number],
    to: [number, number, number],
    color?: [number, number, number, number],
  ): void {
    this.queue.line(from, to, color);
  }

  ray(
    origin: [number, number, number],
    dir: [number, number, number],
    length: number,
    color?: [number, number, number, number],
  ): void {
    this.queue.line(
      origin,
      [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length],
      color,
    );
  }

  grid(
    center: [number, number, number],
    size: number,
    divisions: number,
    color?: [number, number, number, number],
  ): void {
    const half = size / 2;
    const step = size / divisions;
    for (let i = 0; i <= divisions; i++) {
      const offset = -half + i * step;
      this.queue.line(
        [center[0] + offset, center[1], center[2] - half],
        [center[0] + offset, center[1], center[2] + half],
        color,
      );
      this.queue.line(
        [center[0] - half, center[1], center[2] + offset],
        [center[0] + half, center[1], center[2] + offset],
        color,
      );
    }
  }

  cross(
    pos: [number, number, number],
    size: number,
    color?: [number, number, number, number],
  ): void {
    const s = size / 2;
    this.queue.line([pos[0] - s, pos[1], pos[2]], [pos[0] + s, pos[1], pos[2]], color);
    this.queue.line([pos[0], pos[1] - s, pos[2]], [pos[0], pos[1] + s, pos[2]], color);
    this.queue.line([pos[0], pos[1], pos[2] - s], [pos[0], pos[1], pos[2] + s], color);
  }
}
