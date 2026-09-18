import { DebugDrawQueue } from "./queue";
import { DebugLines } from "./lines";

describe("DebugDrawQueue", () => {
  it("should queue lines and points", () => {
    const queue = new DebugDrawQueue();
    queue.line([0, 0, 0], [1, 1, 1]);
    queue.point([2, 2, 2]);
    queue.text([3, 3, 3], "hello");

    expect(queue.getLines().length).toBe(1);
    expect(queue.getPoints().length).toBe(1);
    expect(queue.getTexts().length).toBe(1);
    expect(queue.isEmpty()).toBe(false);
  });

  it("should remove one-shot items (duration=0) on clearFrame", () => {
    const queue = new DebugDrawQueue();
    queue.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1], 0); // one-shot
    expect(queue.getLines().length).toBe(1);

    queue.clearFrame();
    expect(queue.getLines().length).toBe(0);
  });

  it("should keep persistent items (duration>0) for N frames", () => {
    const queue = new DebugDrawQueue();
    queue.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1], 3); // 3 frames

    queue.clearFrame();
    expect(queue.getLines().length).toBe(1); // 2 remaining

    queue.clearFrame();
    expect(queue.getLines().length).toBe(1); // 1 remaining

    queue.clearFrame();
    expect(queue.getLines().length).toBe(0); // expired
  });

  it("should draw AABB with 12 lines", () => {
    const queue = new DebugDrawQueue();
    queue.aabb([0, 0, 0], [1, 1, 1]);
    expect(queue.getLines().length).toBe(12);
  });

  it("should draw grid with correct line count", () => {
    const queue = new DebugDrawQueue();
    const lines = new DebugLines(queue);
    lines.grid([0, 0, 0], 10, 5);
    // (divisions+1) * 2 lines = 12
    expect(queue.getLines().length).toBe(12);
  });
});
