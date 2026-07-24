import { createMessage, nextMessageId, type WorkerMessage, type WorkerMessageType } from "./protocol.ts";

describe("Worker Protocol", () => {
  it("should create a message with type and id", () => {
    const msg = createMessage("init", 1);
    expect(msg.type).toBe("init");
    expect(msg.id).toBe(1);
    expect(msg.payload).toBeUndefined();
  });

  it("should create a message with payload", () => {
    const msg = createMessage("step", 2, { dt: 0.016 });
    expect(msg.type).toBe("step");
    expect(msg.id).toBe(2);
    expect(msg.payload).toEqual({ dt: 0.016 });
  });

  it("nextMessageId should return incrementing IDs", () => {
    const id1 = nextMessageId();
    const id2 = nextMessageId();
    expect(id2).toBe(id1 + 1);
  });

  it("should support all message types", () => {
    const types: WorkerMessageType[] = ["init", "init-ack", "step", "step-ack", "command", "query", "query-result", "crash", "heartbeat"];
    for (const type of types) {
      const msg = createMessage(type, 0);
      expect(msg.type).toBe(type);
    }
  });
});
