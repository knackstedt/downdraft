import type { Entity } from "../ecs/entity";
import { COLLISION_STARTED_CHANNEL, COLLISION_STOPPED_CHANNEL, computeCollisionEvents, computeTriggerEvents, CONTACT_CHANNEL, TRIGGER_ENTER_CHANNEL, TRIGGER_EXIT_CHANNEL } from "./events";
import type { ContactManifold, IntersectionPair } from "./interface";

function makeEntity(index: number, generation: number = 0): Entity {
  return { index, generation };
}

function makeManifold(a: Entity, b: Entity, normal: [number, number, number] = [0, 1, 0]): ContactManifold {
  return {
    entityA: a,
    entityB: b,
    normal,
    points: [[0, 0, 0]],
    penetrationDepth: 0.1,
  };
}

function makeIntersection(a: Entity, b: Entity): IntersectionPair {
  return { entityA: a, entityB: b };
}

describe("computeCollisionEvents", () => {
  it("detects new collisions as started events", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const current = [makeManifold(e1, e2)];
    const previous: ContactManifold[] = [];

    const result = computeCollisionEvents(current, previous);

    expect(result.started.length).toBe(1);
    expect(result.started[0].entityA).toEqual(e1);
    expect(result.started[0].entityB).toEqual(e2);
    expect(result.stopped.length).toBe(0);
    expect(result.contacts.length).toBe(1);
  });

  it("detects ended collisions as stopped events", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const manifold = makeManifold(e1, e2);
    const previous = [manifold];
    const current: ContactManifold[] = [];

    const result = computeCollisionEvents(current, previous);

    expect(result.started.length).toBe(0);
    expect(result.stopped.length).toBe(1);
    expect(result.stopped[0].entityA).toEqual(e1);
    expect(result.stopped[0].entityB).toEqual(e2);
    expect(result.contacts.length).toBe(0);
  });

  it("reports ongoing contacts without started/stopped", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const manifold = makeManifold(e1, e2);
    const previous = [manifold];
    const current = [manifold];

    const result = computeCollisionEvents(current, previous);

    expect(result.started.length).toBe(0);
    expect(result.stopped.length).toBe(0);
    expect(result.contacts.length).toBe(1);
  });

  it("handles multiple pairs independently", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const e3 = makeEntity(3);
    const m1 = makeManifold(e1, e2);
    const m2 = makeManifold(e2, e3);

    const previous = [m1];
    const current = [m2];

    const result = computeCollisionEvents(current, previous);

    expect(result.started.length).toBe(1);
    expect(result.stopped.length).toBe(1);
    expect(result.contacts.length).toBe(1);
  });

  it("uses consistent channel names", () => {
    expect(COLLISION_STARTED_CHANNEL).toBe("physics:collision_started");
    expect(COLLISION_STOPPED_CHANNEL).toBe("physics:collision_stopped");
    expect(CONTACT_CHANNEL).toBe("physics:contact");
  });
});

describe("computeTriggerEvents", () => {
  it("detects new intersections as entered events", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const current = [makeIntersection(e1, e2)];
    const previous: IntersectionPair[] = [];

    const result = computeTriggerEvents(current, previous);

    expect(result.entered.length).toBe(1);
    expect(result.entered[0].entityA).toEqual(e1);
    expect(result.entered[0].entityB).toEqual(e2);
    expect(result.exited.length).toBe(0);
  });

  it("detects ended intersections as exited events", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const pair = makeIntersection(e1, e2);
    const previous = [pair];
    const current: IntersectionPair[] = [];

    const result = computeTriggerEvents(current, previous);

    expect(result.entered.length).toBe(0);
    expect(result.exited.length).toBe(1);
    expect(result.exited[0].entityA).toEqual(e1);
    expect(result.exited[0].entityB).toEqual(e2);
  });

  it("reports ongoing intersections without enter/exit", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const pair = makeIntersection(e1, e2);
    const previous = [pair];
    const current = [pair];

    const result = computeTriggerEvents(current, previous);

    expect(result.entered.length).toBe(0);
    expect(result.exited.length).toBe(0);
  });

  it("handles multiple pairs independently", () => {
    const e1 = makeEntity(1);
    const e2 = makeEntity(2);
    const e3 = makeEntity(3);
    const p1 = makeIntersection(e1, e2);
    const p2 = makeIntersection(e2, e3);

    const previous = [p1];
    const current = [p2];

    const result = computeTriggerEvents(current, previous);

    expect(result.entered.length).toBe(1);
    expect(result.exited.length).toBe(1);
  });

  it("uses consistent channel names", () => {
    expect(TRIGGER_ENTER_CHANNEL).toBe("physics:trigger_enter");
    expect(TRIGGER_EXIT_CHANNEL).toBe("physics:trigger_exit");
  });
});
