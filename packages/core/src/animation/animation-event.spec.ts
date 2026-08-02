import { describe, expect, it, mock } from "bun:test";
import {
    type AnimationEvent,
    createAnimationEventTrack,
    getEventsInRange,
} from "./animation-event.ts";
import { AnimationClip } from "./clip.ts";
import { AnimationPlayer } from "./player.ts";
import type { Bone, SkeletonData } from "./skeleton.ts";
import { Skeleton } from "./skeleton.ts";

function makeMockSkeleton(): Skeleton {
  const bones: Bone[] = [
    { name: "root", nodeIndex: 0, parentIndex: -1, childrenIndices: [1], inverseBindMatrix: new Float32Array(16), bindPosition: [0, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
    { name: "child", nodeIndex: 1, parentIndex: 0, childrenIndices: [], inverseBindMatrix: new Float32Array(16), bindPosition: [1, 0, 0], bindRotation: [0, 0, 0, 1], bindScale: [1, 1, 1] },
  ];
  const data: SkeletonData = { name: "test", bones, rootBoneIndex: 0 };
  return new Skeleton(data);
}

function makeClipWithEvents(events: AnimationEvent[], duration: number): AnimationClip {
  return new AnimationClip({
    name: "test",
    duration,
    tracks: [],
    eventTrack: createAnimationEventTrack(events),
  });
}

describe("AnimationEvent", () => {
  it("should create sorted event track", () => {
    const events = [
      { time: 2, type: "b" },
      { time: 1, type: "a" },
      { time: 0.5, type: "early" },
    ];
    const track = createAnimationEventTrack(events);
    expect(track.events[0].time).toBe(0.5);
    expect(track.events[1].time).toBe(1);
    expect(track.events[2].time).toBe(2);
  });

  it("should get events in forward range", () => {
    const track = createAnimationEventTrack([
      { time: 0.5, type: "a" },
      { time: 1.0, type: "b" },
      { time: 1.5, type: "c" },
    ]);
    const events = getEventsInRange(track, 0, 1.0, 2.0);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("a");
    expect(events[1].type).toBe("b");
  });

  it("should get events in backward range", () => {
    const track = createAnimationEventTrack([
      { time: 0.5, type: "a" },
      { time: 1.5, type: "b" },
    ]);
    const events = getEventsInRange(track, 1.5, 0.5, 2.0);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("a");
  });

  it("should handle loop wraparound", () => {
    const track = createAnimationEventTrack([
      { time: 0.1, type: "start" },
      { time: 1.9, type: "end" },
    ]);
    const events = getEventsInRange(track, 1.5, 0.5, 2.0);
    expect(events.length).toBe(2);
  });
});

describe("AnimationPlayer events", () => {
  it("should fire events during forward playback", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.5, type: "footstep" },
    ], 2.0);
    player.play("walk", clip);

    const handler = mock(() => {});
    player.onEvent("footstep", handler);

    player.update(0.6);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should fire events during loop wraparound", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.1, type: "loop_start" },
    ], 1.0);
    player.play("walk", clip, { weight: 1 });

    const handler = mock(() => {});
    player.onEvent("loop_start", handler);

    player.update(0.9);
    expect(handler).toHaveBeenCalledTimes(1);

    player.update(0.3);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("should support multiple events in single frame", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.3, type: "a" },
      { time: 0.5, type: "b" },
    ], 2.0);
    player.play("walk", clip);

    const handlerA = mock(() => {});
    const handlerB = mock(() => {});
    player.onEvent("a", handlerA);
    player.onEvent("b", handlerB);

    player.update(0.6);
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("should support handler unregistration", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.5, type: "hit" },
    ], 2.0);
    player.play("attack", clip);

    const handler = mock(() => {});
    player.onEvent("hit", handler);
    player.offEvent("hit", handler);

    player.update(0.6);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should store pending events for polling", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.5, type: "hit", payload: { damage: 10 } },
    ], 2.0);
    player.play("attack", clip);

    player.update(0.6);
    const events = player.getPendingEvents();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("hit");
    expect(events[0].payload).toEqual({ damage: 10 });

    player.clearPendingEvents();
    expect(player.getPendingEvents().length).toBe(0);
  });

  it("should pass payload to handler", () => {
    const skeleton = makeMockSkeleton();
    const player = new AnimationPlayer(skeleton);
    const clip = makeClipWithEvents([
      { time: 0.5, type: "attack", payload: { power: 42 } },
    ], 2.0);
    player.play("attack", clip);

    let receivedPayload: Record<string, unknown> | undefined;
    player.onEvent("attack", (e) => {
      receivedPayload = e.payload;
    });

    player.update(0.6);
    expect(receivedPayload).toEqual({ power: 42 });
  });
});
