import { World } from "../ecs/world.ts";
import { component } from "../ecs/component.ts";
import { ChangeTracker } from "./tracker.ts";

const Position = component("Position", { x: 0, y: 0, lastChanged: 0 });

describe("ChangeTracker", () => {
  it("should track changes via write()", () => {
    const world = new World();
    const tracker = new ChangeTracker(world);
    const entity = world.spawn(new Map([[Position.id, { x: 1, y: 2, lastChanged: 0 }]]));

    world.step(0); // tick = 1

    tracker.write(entity, Position.id, (data) => {
      data.x = 10;
    });

    expect(tracker.wasChanged(entity, Position.id, 1)).toBe(true);
  });

  it("should return false for unchanged components", () => {
    const world = new World();
    const tracker = new ChangeTracker(world);
    const entity = world.spawn(new Map([[Position.id, { x: 1, y: 2, lastChanged: 0 }]]));

    world.step(0); // tick = 1

    expect(tracker.wasChanged(entity, Position.id, 1)).toBe(false);
  });

  it("should return false for non-existent entity", () => {
    const world = new World();
    const tracker = new ChangeTracker(world);

    expect(tracker.wasChanged({ index: 999, generation: 0 }, Position.id, 0)).toBe(false);
  });

  it("should not throw when writing to non-existent component", () => {
    const world = new World();
    const tracker = new ChangeTracker(world);
    const entity = world.spawn(new Map());

    tracker.write(entity, Position.id, (data) => {
      data.x = 10;
    });
    // Should not throw
    expect(true).toBe(true);
  });
});
