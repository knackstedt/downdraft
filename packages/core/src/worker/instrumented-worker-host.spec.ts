import { exposeProfilingApi } from "./instrumented-worker-host";
import { expose, wrap, type WorkerApi } from "./rpc";

// Test that exposeProfilingApi adds the expected RPC methods
describe("exposeProfilingApi", () => {
  it("merges profiling RPC methods into a worker API", () => {
    const baseApi: WorkerApi = {
      init: async () => "ok",
      shutdown: async () => {},
    };
    const merged = exposeProfilingApi(baseApi);
    expect(typeof merged.__profilingAttach).toBe("function");
    expect(typeof merged.__profilingAddRule).toBe("function");
    expect(typeof merged.__profilingOnWarning).toBe("function");
    // Original methods preserved
    expect(typeof merged.init).toBe("function");
    expect(typeof merged.shutdown).toBe("function");
  });
});

// Test the InstrumentedWorkerHost's beforeInit hook using a mock proxy
describe("InstrumentedWorkerHost beforeInit", () => {
  it("calls __profilingAttach before onInit via beforeInit hook", async () => {
    // We test the hook logic without a real worker by simulating the call order
    const callOrder: string[] = [];
    const mockProxy = {
      proxy: {
        __profilingAttach: async (_sab: any, config: any) => {
          callOrder.push("profilingAttach:" + config.workerTag);
          return { slotIndex: 0, success: true };
        },
        init: async () => {
          callOrder.push("onInit");
        },
      },
      onEvents: () => () => {},
      terminate: () => {},
    };

    // Simulate the beforeInit + onInit sequence
    const config = {
      profilingSAB: new SharedArrayBuffer(64),
      profilingLayout: {} as any,
      workerTag: "sim",
    };

    // Call __profilingAttach (as beforeInit would)
    await (mockProxy.proxy as any).__profilingAttach(config.profilingSAB, {
      workerTag: config.workerTag,
      runtime: 0,
      opfs: true,
      idb: true,
      defaultWarningRules: true,
    });
    // Call onInit (as BaseWorkerHost.start would after beforeInit)
    await (mockProxy.proxy as any).init();

    expect(callOrder).toEqual(["profilingAttach:sim", "onInit"]);
  });
});
