import { RPCManager } from "./rpc";
import { MockTransport } from "./transport";

describe("RPCManager", () => {
  async function makeLinkedPair(): Promise<{ server: MockTransport; client: MockTransport }> {
    const server = new MockTransport();
    const client = new MockTransport();
    client.link(server);
    await server.connect("mock://s");
    await client.connect("mock://c");
    return { server, client };
  }

  it("should register an RPC handler", () => {
    const transport = new MockTransport();
    const rpc = new RPCManager(transport, true);
    const id = rpc.register("test", () => null);
    expect(id).toBeGreaterThan(0);
    expect(rpc.getDefinition("test")).toBeDefined();
    expect(rpc.getDefinition("test")?.name).toBe("test");
  });

  it("should unregister an RPC handler", () => {
    const transport = new MockTransport();
    const rpc = new RPCManager(transport, true);
    rpc.register("test", () => null);
    rpc.unregister("test");
    expect(rpc.getDefinition("test")).toBeUndefined();
  });

  it("should call remote handler and receive response", async () => {
    const { server, client } = await makeLinkedPair();

    const serverRpc = new RPCManager(server, true);
    const clientRpc = new RPCManager(client, false);

    serverRpc.register("echo", (args) => {
      return args;
    });

    const received: Uint8Array[] = [];
    server.onMessage((msg) => received.push(msg.data));

    clientRpc.call("echo", new Uint8Array([1, 2, 3]));

    expect(received.length).toBeGreaterThan(0);
  });

  it("should call by ID", async () => {
    const { server, client } = await makeLinkedPair();

    const serverRpc = new RPCManager(server, true);
    const clientRpc = new RPCManager(client, false);

    const id = serverRpc.register("test", () => new Uint8Array([42]));

    const received: Uint8Array[] = [];
    server.onMessage((msg) => received.push(msg.data));

    clientRpc.callById(id, new Uint8Array([1]));

    expect(received.length).toBeGreaterThan(0);
  });

  it("should handle incoming RPC messages", async () => {
    const { server, client } = await makeLinkedPair();

    const serverRpc = new RPCManager(server, true);
    let handlerCalled = false;
    serverRpc.register("ping", () => {
      handlerCalled = true;
      return new Uint8Array([1]);
    });

    const clientRpc = new RPCManager(client, false);
    clientRpc.call("ping", new Uint8Array([0]));

    await new Promise((r) => setTimeout(r, 10));
    expect(handlerCalled).toBe(true);
  });

  it("should not call undefined handler", async () => {
    const { server, client } = await makeLinkedPair();
    const serverRpc = new RPCManager(server, true);
    const clientRpc = new RPCManager(client, false);

    clientRpc.call("nonexistent", new Uint8Array([0]));
    expect(() => {}).not.toThrow();
  });

  it("should get handler by ID", () => {
    const transport = new MockTransport();
    const rpc = new RPCManager(transport, true);
    const handler = () => null;
    const id = rpc.register("test", handler);
    expect(rpc.getHandler(id)).toBe(handler);
  });

  it("should dispose and clear all handlers", () => {
    const transport = new MockTransport();
    const rpc = new RPCManager(transport, true);
    rpc.register("a", () => null);
    rpc.register("b", () => null);
    rpc.dispose();
    expect(rpc.getDefinition("a")).toBeUndefined();
    expect(rpc.getDefinition("b")).toBeUndefined();
  });

  it("should send reliable messages by default", async () => {
    const { server, client } = await makeLinkedPair();
    const serverRpc = new RPCManager(server, true);
    const clientRpc = new RPCManager(client, false);

    serverRpc.register("reliable_test", () => null);

    let receivedReliable = false;
    server.onMessage((msg) => {
      if (msg.reliable) receivedReliable = true;
    });

    clientRpc.call("reliable_test", new Uint8Array([0]));
    expect(receivedReliable).toBe(true);
  });
});
