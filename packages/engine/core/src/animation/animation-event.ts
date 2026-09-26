export interface AnimationEvent {
  time: number;
  type: string;
  payload?: Record<string, unknown>;
}

export interface AnimationEventTrack {
  events: AnimationEvent[];
}

export function createAnimationEventTrack(events: AnimationEvent[]): AnimationEventTrack {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  return { events: sorted };
}

export function getEventsInRange(
  track: AnimationEventTrack,
  fromTime: number,
  toTime: number,
  duration: number,
): AnimationEvent[] {
  const result: AnimationEvent[] = [];

  if (toTime > fromTime) {
    // Forward playback: events in (fromTime, toTime]
    track.events.forEach((e) => {
      if (e.time > fromTime && e.time <= toTime) {
        result.push(e);
      }
    });
  } else if (toTime < fromTime) {
    // Backward or wraparound: events in (fromTime, duration] ∪ [0, toTime]
    track.events.forEach((e) => {
      if (e.time > fromTime || e.time <= toTime) {
        result.push(e);
      }
    });
  }

  return result;
}
