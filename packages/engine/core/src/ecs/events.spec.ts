import { EventBus, EventChannel } from "./events";

interface TestEvent {
  type: string;
  value: number;
}

describe("EventBus", () => {
  it("should create channels on demand", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");
    expect(ch).toBeDefined();
  });

  it("should return the same channel instance for the same name", () => {
    const bus = new EventBus();
    const ch1 = bus.channel<TestEvent>("test");
    const ch2 = bus.channel<TestEvent>("test");
    expect(ch1).toBe(ch2);
  });

  it("should buffer events: sent events are not readable until swap", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");

    ch.send({ type: "a", value: 1 });
    ch.send({ type: "b", value: 2 });

    const events = ch.read();
    expect(events.length).toBe(0);
  });

  it("should make events readable after swap", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");

    ch.send({ type: "a", value: 1 });
    ch.send({ type: "b", value: 2 });

    bus.swapAll();

    const events = ch.read();
    expect(events.length).toBe(2);
    expect(events[0].value).toBe(1);
    expect(events[1].value).toBe(2);
  });

  it("should clear events after read", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");

    ch.send({ type: "a", value: 1 });
    bus.swapAll();
    ch.read();

    const events = ch.read();
    expect(events.length).toBe(0);
  });

  it("should double-buffer: new sends after swap go to next buffer", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");

    ch.send({ type: "a", value: 1 });
    bus.swapAll();

    ch.send({ type: "b", value: 2 });
    bus.swapAll();

    const events = ch.read();
    expect(events.length).toBe(1);
    expect(events[0].value).toBe(2);
  });

  it("swapAll should swap all channels", () => {
    const bus = new EventBus();
    const ch1 = bus.channel<TestEvent>("ch1");
    const ch2 = bus.channel<TestEvent>("ch2");

    ch1.send({ type: "a", value: 10 });
    ch2.send({ type: "b", value: 20 });

    bus.swapAll();

    expect(ch1.read().length).toBe(1);
    expect(ch2.read().length).toBe(1);
  });

  it("clearAll should clear all channels", () => {
    const bus = new EventBus();
    const ch1 = bus.channel<TestEvent>("ch1");
    const ch2 = bus.channel<TestEvent>("ch2");

    ch1.send({ type: "a", value: 10 });
    ch2.send({ type: "b", value: 20 });
    bus.swapAll();

    bus.clearAll();

    expect(ch1.read().length).toBe(0);
    expect(ch2.read().length).toBe(0);
  });

  it("should handle high-volume events", () => {
    const bus = new EventBus();
    const ch = bus.channel<TestEvent>("test");

    for (let i = 0; i < 1000; i++) {
      ch.send({ type: "n", value: i });
    }
    bus.swapAll();

    const events = ch.read();
    expect(events.length).toBe(1000);
    expect(events[0].value).toBe(0);
    expect(events[999].value).toBe(999);
  });
});
