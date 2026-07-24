import type { Entity } from "../ecs/entity.ts";

export type WorkerMessageType =
  | "init"
  | "init-ack"
  | "step"
  | "step-ack"
  | "command"
  | "query"
  | "query-result"
  | "crash"
  | "heartbeat";

export interface WorkerMessage {
  type: WorkerMessageType;
  id: number;
  payload?: unknown;
}

export interface InitPayload {
  sabBuffers: Record<string, SharedArrayBuffer>;
  config: Record<string, unknown>;
}

export interface StepPayload {
  dt: number;
}

export interface StepAckPayload {
  tick: number;
  entityCount: number;
  frameTime: number;
}

export interface CommandPayload {
  op: "spawn" | "despawn" | "addComponent" | "removeComponent" | "setResource";
  entity?: Entity;
  componentId?: number;
  data?: unknown;
  resourceName?: string;
  resourceValue?: unknown;
}

export interface QueryPayload {
  queryType: "entity-state" | "scene-tree" | "count";
  entity?: Entity;
}

export interface HeartbeatPayload {
  tick: number;
  memoryUsage: number;
  gcPauseTotal: number;
}

export function createMessage(type: WorkerMessageType, id: number, payload?: unknown): WorkerMessage {
  return { type, id, payload };
}

let messageIdCounter = 0;
export function nextMessageId(): number {
  return ++messageIdCounter;
}
