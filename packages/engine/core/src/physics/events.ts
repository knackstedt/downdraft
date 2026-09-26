import type { Entity } from "../ecs/entity";
import type { ContactManifold, IntersectionPair } from "./interface";

export interface CollisionStartedEvent {
  entityA: Entity;
  entityB: Entity;
  normal: [number, number, number];
  penetrationDepth: number;
  contactPoints: Array<[number, number, number]>;
}

export interface CollisionStoppedEvent {
  entityA: Entity;
  entityB: Entity;
}

export interface ContactEvent {
  entityA: Entity;
  entityB: Entity;
  normal: [number, number, number];
  penetrationDepth: number;
  contactPoints: Array<[number, number, number]>;
}

export interface TriggerEnterEvent {
  entityA: Entity;
  entityB: Entity;
}

export interface TriggerExitEvent {
  entityA: Entity;
  entityB: Entity;
}

export const COLLISION_STARTED_CHANNEL = "physics:collision_started";
export const COLLISION_STOPPED_CHANNEL = "physics:collision_stopped";
export const CONTACT_CHANNEL = "physics:contact";
export const TRIGGER_ENTER_CHANNEL = "physics:trigger_enter";
export const TRIGGER_EXIT_CHANNEL = "physics:trigger_exit";

export function manifoldToStartedEvent(manifold: ContactManifold): CollisionStartedEvent {
  return {
    entityA: manifold.entityA,
    entityB: manifold.entityB,
    normal: manifold.normal,
    penetrationDepth: manifold.penetrationDepth,
    contactPoints: manifold.points,
  };
}

export function computeCollisionEvents(
  currentContacts: ContactManifold[],
  previousContacts: ContactManifold[],
): {
  started: CollisionStartedEvent[];
  stopped: CollisionStoppedEvent[];
  contacts: ContactEvent[];
} {
  const started: CollisionStartedEvent[] = [];
  const stopped: CollisionStoppedEvent[] = [];
  const contacts: ContactEvent[] = [];

  const prevPairs = new Set<string>();
  previousContacts.forEach((m) => {
    const key = pairKey(m.entityA, m.entityB);
    prevPairs.add(key);
  });

  const currPairs = new Set<string>();
  currentContacts.forEach((m) => {
    const key = pairKey(m.entityA, m.entityB);
    currPairs.add(key);
    contacts.push({
      entityA: m.entityA,
      entityB: m.entityB,
      normal: m.normal,
      penetrationDepth: m.penetrationDepth,
      contactPoints: m.points,
    });
    if (!prevPairs.has(key)) {
      started.push(manifoldToStartedEvent(m));
    }
  });

  previousContacts.forEach((m) => {
    const key = pairKey(m.entityA, m.entityB);
    if (!currPairs.has(key)) {
      stopped.push({ entityA: m.entityA, entityB: m.entityB });
    }
  });

  return { started, stopped, contacts };
}

export function computeTriggerEvents(
  currentIntersections: IntersectionPair[],
  previousIntersections: IntersectionPair[],
): {
  entered: TriggerEnterEvent[];
  exited: TriggerExitEvent[];
} {
  const entered: TriggerEnterEvent[] = [];
  const exited: TriggerExitEvent[] = [];

  const prevPairs = new Set<string>();
  previousIntersections.forEach((p) => {
    prevPairs.add(pairKey(p.entityA, p.entityB));
  });

  const currPairs = new Set<string>();
  currentIntersections.forEach((p) => {
    const key = pairKey(p.entityA, p.entityB);
    currPairs.add(key);
    if (!prevPairs.has(key)) {
      entered.push({ entityA: p.entityA, entityB: p.entityB });
    }
  });

  previousIntersections.forEach((p) => {
    const key = pairKey(p.entityA, p.entityB);
    if (!currPairs.has(key)) {
      exited.push({ entityA: p.entityA, entityB: p.entityB });
    }
  });

  return { entered, exited };
}

function pairKey(a: Entity, b: Entity): string {
  const i1 = a.index < b.index ? a : b;
  const i2 = a.index < b.index ? b : a;
  return `${i1.index}:${i1.generation}-${i2.index}:${i2.generation}`;
}
