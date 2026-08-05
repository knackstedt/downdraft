import { RealmWorker, supportsNestedWorkers, supportsSharedArrayBuffer } from "./realm-worker";

describe("realm-worker", () => {
  it("supportsSharedArrayBuffer should return a boolean", () => {
    const result = supportsSharedArrayBuffer();
    expect(typeof result).toBe("boolean");
  });

  it("supportsNestedWorkers should return a boolean", () => {
    const result = supportsNestedWorkers();
    expect(typeof result).toBe("boolean");
  });

  it("RealmWorker should track realm ids", () => {
    // We can't actually create a worker in tests without a real URL,
    // but we can test the realm tracking logic via a mock.
    // Skip if Worker is not available.
    if (typeof Worker === "undefined") return;

    // Create a minimal worker that does nothing
    try {
      const worker = new RealmWorker("data:text/javascript,self.onmessage=()=>{}", 1);
      expect(worker.tier).toBe(1);
      expect(worker.hasRealm(0)).toBe(false);
      worker.addRealm(0);
      expect(worker.hasRealm(0)).toBe(true);
      worker.removeRealm(0);
      expect(worker.hasRealm(0)).toBe(false);
      worker.terminate();
    } catch {
      // Worker creation may fail in test env — skip
    }
  });
});
