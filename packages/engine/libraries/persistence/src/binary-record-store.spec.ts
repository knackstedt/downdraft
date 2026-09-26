// ============================================================================
// BinaryRecordStore tests — versioned keyed binary records over OPFS.
// ============================================================================

import { beforeEach, describe, expect, it } from "bun:test";
import { BinaryRecordStore } from "./binary-record-store";
import { createMockOpfsRoot, type MockDirHandle } from "./mock-opfs";

const MAGIC = 0x4f424353; // "OBCS"

function makeStore(root: MockDirHandle, opts: Partial<ConstructorParameters<typeof BinaryRecordStore>[0]> = {}) {
  return new BinaryRecordStore({
    fileName: "records.bin",
    magic: MAGIC,
    version: 1,
    root: root as unknown as FileSystemDirectoryHandle,
    ...opts,
  });
}

describe("BinaryRecordStore", () => {
  let root: MockDirHandle;

  beforeEach(() => {
    root = createMockOpfsRoot();
  });

  it("returns an empty map when no file exists", async () => {
    const store = makeStore(root);
    expect((await store.readAll()).size).toBe(0);
  });

  it("round-trips keyed binary records", async () => {
    const store = makeStore(root);
    await store.write([
      ["1,2", new Uint8Array([1, 2, 3])],
      ["-4,7", new Uint8Array([9])],
    ]);
    const all = await store.readAll();
    expect(all.size).toBe(2);
    expect([...all.get("1,2")!]).toEqual([1, 2, 3]);
    expect([...all.get("-4,7")!]).toEqual([9]);
  });

  it("merge-writes preserve untouched records", async () => {
    const store = makeStore(root);
    await store.write([["a", new Uint8Array([1])], ["b", new Uint8Array([2])]]);
    await store.write([["b", new Uint8Array([7])], ["c", new Uint8Array([3])]]);
    const all = await store.readAll();
    expect(all.size).toBe(3);
    expect([...all.get("a")!]).toEqual([1]);
    expect([...all.get("b")!]).toEqual([7]);
    expect([...all.get("c")!]).toEqual([3]);
  });

  it("delete removes keys and preserves the rest", async () => {
    const store = makeStore(root);
    await store.write([["a", new Uint8Array([1])], ["b", new Uint8Array([2])]]);
    expect(await store.delete(["a"])).toBe(1);
    const all = await store.readAll();
    expect(all.has("a")).toBe(false);
    expect(all.has("b")).toBe(true);
    expect(await store.delete(["missing"])).toBe(0);
  });

  it("deleteAll removes the file", async () => {
    const store = makeStore(root);
    await store.write([["a", new Uint8Array([1])]]);
    await store.deleteAll();
    expect((await store.readAll()).size).toBe(0);
  });

  it("rejects a foreign magic", async () => {
    await makeStore(root).write([["a", new Uint8Array([1])]]);
    const foreign = makeStore(root, { magic: 0xdeadbeef });
    expect((await foreign.readAll()).size).toBe(0);
    // A foreign-magic write discards the old records rather than merging.
    await foreign.write([["x", new Uint8Array([9])]]);
    expect((await foreign.readAll()).has("a")).toBe(false);
    expect((await foreign.readAll()).has("x")).toBe(true);
  });

  it("discards version-mismatched files when no migrate is provided", async () => {
    await makeStore(root, { version: 1 }).write([["a", new Uint8Array([1])]]);
    const v2 = makeStore(root, { version: 2 });
    expect((await v2.readAll()).size).toBe(0);
  });

  it("migrates version-mismatched records", async () => {
    await makeStore(root, { version: 1 }).write([["a", new Uint8Array([1])]]);
    const v2 = makeStore(root, {
      version: 2,
      migrate: (from, records) => {
        expect(from).toBe(1);
        const out = new Map<string, Uint8Array>();
        for (const [k, v] of records.entries()) out.set(`${k}-migrated`, v);
        return out;
      },
    });
    const all = await v2.readAll();
    expect(all.has("a-migrated")).toBe(true);
    // Migrated records persist under the new version on the next write.
    await v2.write([["b", new Uint8Array([2])]]);
    const after = await makeStore(root, { version: 2 }).readAll();
    expect(after.has("a-migrated")).toBe(true);
    expect(after.has("b")).toBe(true);
  });

  it("tolerates truncated files", async () => {
    const store = makeStore(root);
    await store.write([["a", new Uint8Array([1])], ["b", new Uint8Array([2])]]);
    // Truncate mid-second-record via a direct file poke.
    const handle = await (root as unknown as FileSystemDirectoryHandle).getFileHandle("records.bin");
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(buf.slice(0, buf.byteLength - 3)));
    await writable.close();
    const all = await store.readAll();
    expect(all.size).toBe(1);
    expect(all.has("a")).toBe(true);
  });
});
