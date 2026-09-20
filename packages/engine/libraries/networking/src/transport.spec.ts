import { MockTransport, createTransport, type NetMessage, type TransportType } from "./transport";

describe("MockTransport", () => {
  it("should start disconnected", () => {
    const t = new MockTransport();
    expect(t.isConnected()).toBe(false);
  });

  it("should connect", async () => {
    const t = new MockTransport();
    await t.connect("mock://test");
    expect(t.isConnected()).toBe(true);
  });

  it("should disconnect", async () => {
    const t = new MockTransport();
    await t.connect("mock://test");
    await t.disconnect();
    expect(t.isConnected()).toBe(false);
  });

  it("should fire onConnect handler", async () => {
    const t = new MockTransport();
    let connected = false;
    t.onConnect(() => { connected = true; });
    await t.connect("mock://test");
    expect(connected).toBe(true);
  });

  it("should fire onDisconnect handler", async () => {
    const t = new MockTransport();
    let disconnected = false;
    t.onDisconnect(() => { disconnected = true; });
    await t.connect("mock://test");
    await t.disconnect();
    expect(disconnected).toBe(true);
  });

  it("should send messages between linked peers", async () => {
    const server = new MockTransport();
    const client = new MockTransport();
    client.link(server);

    await server.connect("mock://s");
    await client.connect("mock://c");

    const received: NetMessage[] = [];
    server.onMessage((msg) => received.push(msg));

    client.send({ type: 1, data: new Uint8Array([1, 2, 3]), reliable: true, ordered: true, channel: 0 });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe(1);
    expect(received[0].data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("should not send when disconnected", async () => {
    const server = new MockTransport();
    const client = new MockTransport();
    client.link(server);

    await server.connect("mock://s");

    const received: NetMessage[] = [];
    server.onMessage((msg) => received.push(msg));

    client.send({ type: 1, data: new Uint8Array([1]), reliable: true, ordered: true, channel: 0 });

    expect(received.length).toBe(0);
  });

  it("should support multiple message handlers", async () => {
    const server = new MockTransport();
    const client = new MockTransport();
    client.link(server);

    await server.connect("mock://s");
    await client.connect("mock://c");

    let count = 0;
    server.onMessage(() => { count++; });
    server.onMessage(() => { count++; });

    client.send({ type: 1, data: new Uint8Array([1]), reliable: true, ordered: true, channel: 0 });

    expect(count).toBe(2);
  });

  it("should report RTT", () => {
    const t = new MockTransport();
    t.setRTT(50);
    expect(t.getRTT()).toBe(50);
  });

  it("should report packet loss", () => {
    const t = new MockTransport();
    t.setPacketLoss(0.05);
    expect(t.getPacketLoss()).toBe(0.05);
  });
});

describe("createTransport", () => {
  it("should create mock transport", () => {
    const t = createTransport("mock");
    expect(t.type).toBe("mock");
  });

  it("should create websocket transport", () => {
    const t = createTransport("websocket");
    expect(t.type).toBe("websocket");
  });

  it("should default to mock for unknown types", () => {
    const t = createTransport("carrier-pigeon" as TransportType);
    expect(t.type).toBe("mock");
  });
});
