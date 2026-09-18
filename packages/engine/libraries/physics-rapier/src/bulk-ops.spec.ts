import { bulkReadTransforms, bulkWriteTransforms, bulkReadMultiRealm } from "./bulk-ops";
import type { PhysicsBackend } from "@downdraft/engine";

function makeMockBackend(): PhysicsBackend {
  return {
    readTransforms: (_realmId: number, buffer: Float32Array, count: number) => {
      // Fill with test data
      for (let i = 0; i < count; i++) {
        const offset = i * 8;
        buffer[offset] = i; // pos.x = entity index
        buffer[offset + 6] = 1; // rot.w = 1
      }
    },
    syncTransforms: (_realmId: number, buffer: Float32Array, count: number) => {
      // Mock write — just verify it doesn't throw
      void buffer; void count;
    },
  } as unknown as PhysicsBackend;
}

describe("bulk-ops", () => {
  it("should read transforms in one pass", () => {
    const backend = makeMockBackend();
    const buf = new Float32Array(10 * 8);
    bulkReadTransforms(backend, 0, buf, 5);
    // Entity 0: pos.x = 0
    expect(buf[0]).toBe(0);
    // Entity 1: pos.x = 1
    expect(buf[8]).toBe(1);
    // Entity 4: pos.x = 4
    expect(buf[32]).toBe(4);
    // rot.w = 1 for all
    expect(buf[6]).toBe(1);
    expect(buf[14]).toBe(1);
  });

  it("should write transforms in one pass", () => {
    const backend = makeMockBackend();
    const buf = new Float32Array(10 * 8);
    buf[0] = 5; // pos.x for entity 0
    expect(() => bulkWriteTransforms(backend, 0, buf, 5)).not.toThrow();
  });

  it("should read transforms for multiple realms", () => {
    const backend = makeMockBackend();
    const buf = new Float32Array(3 * 10 * 8); // 3 realms × 10 entities × 8 floats
    const results = bulkReadMultiRealm(backend, [1, 2, 3], buf, 10);
    expect(results).toHaveLength(3);
    expect(results[0].realmId).toBe(1);
    expect(results[1].realmId).toBe(2);
    expect(results[2].realmId).toBe(3);
    // Each realm should have written data at its offset
    expect(results[0].offset).toBe(0);
    expect(results[1].offset).toBe(80);
    expect(results[2].offset).toBe(160);
  });
});
