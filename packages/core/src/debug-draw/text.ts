import { DebugDrawQueue } from "./queue.ts";

export class DebugText {
  private queue: DebugDrawQueue;

  constructor(queue: DebugDrawQueue) {
    this.queue = queue;
  }

  world(
    pos: [number, number, number],
    text: string,
    color?: [number, number, number, number],
  ): void {
    this.queue.text(pos, text, color, false);
  }

  screen(
    pos: [number, number, number],
    text: string,
    color?: [number, number, number, number],
  ): void {
    this.queue.text(pos, text, color, true);
  }
}
