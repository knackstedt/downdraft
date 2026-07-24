import { DebugDrawQueue } from "./queue.ts";

export class DebugPoints {
  private queue: DebugDrawQueue;

  constructor(queue: DebugDrawQueue) {
    this.queue = queue;
  }

  point(
    pos: [number, number, number],
    color?: [number, number, number, number],
    size?: number,
  ): void {
    this.queue.point(pos, color, size);
  }
}
