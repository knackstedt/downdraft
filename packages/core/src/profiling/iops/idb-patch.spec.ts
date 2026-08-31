import {
    allocateProfilingSAB,
    claimSlot,
    fnv1a32,
    ProfilingSABReader,
    ProfilingSABWriter,
    RUNTIME_JS,
    STORE_IDB,
} from "../profiling-sab";
import {
    IDB_OP_OPEN,
    patchIndexedDbPrototypes,
    unpatchIndexedDbPrototypes,
} from "./idb-patch";

function setupMockIdb() {
  const mockRequest = {
    result: { name: "test-db" },
    onsuccess: null as any,
    onerror: null as any,
    error: null,
    readyState: "done",
  };
  const mockStore = {
    name: "test-store",
    get: () => mockRequest,
    put: () => mockRequest,
    add: () => mockRequest,
    delete: () => mockRequest,
    getAll: () => mockRequest,
    getAllKeys: () => mockRequest,
    count: () => mockRequest,
    openCursor: () => mockRequest,
    openKeyCursor: () => mockRequest,
    clear: () => mockRequest,
  };
  const mockTx = {
    db: { name: "test-db" },
    objectStore: () => mockStore,
  };
  const mockDb = {
    name: "test-db",
    transaction: () => mockTx,
    close: () => {},
  };

  (globalThis as any).IDBFactory = function IDBFactory() {};
  (globalThis as any).IDBFactory.prototype.open = function (name: string) { return mockRequest; };
  (globalThis as any).IDBFactory.prototype.databases = function () { return Promise.resolve([{ name: "test-db" }]); };

  (globalThis as any).IDBDatabase = function IDBDatabase() {};
  (globalThis as any).IDBDatabase.prototype.transaction = function () { return mockTx; };
  (globalThis as any).IDBDatabase.prototype.close = function () {};

  (globalThis as any).IDBTransaction = function IDBTransaction() {};
  (globalThis as any).IDBTransaction.prototype.objectStore = function () { return mockStore; };

  (globalThis as any).IDBObjectStore = function IDBObjectStore() {};
  (globalThis as any).IDBObjectStore.prototype.get = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.put = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.add = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.delete = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.getAll = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.getAllKeys = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.count = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.openCursor = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.openKeyCursor = function () { return mockRequest; };
  (globalThis as any).IDBObjectStore.prototype.clear = function () { return mockRequest; };

  return { mockRequest, mockStore, mockTx, mockDb };
}

describe("IndexedDB prototype patching", () => {
  beforeEach(() => setupMockIdb());
  afterEach(() => unpatchIndexedDbPrototypes());

  it("patches IDBFactory.open and records IOPS on request success", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);

    patchIndexedDbPrototypes({ writer, workerTag: fnv1a32("test") });

    const factory = new (globalThis as any).IDBFactory();
    const req = factory.open("test-db");
    // Set onsuccess (this installs the wrapper), then simulate the request succeeding
    req.onsuccess = () => {};
    req.onsuccess({ target: req } as any);

    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(1);
    expect(snap.slots[0].iopsRecords[0].opKind).toBe(IDB_OP_OPEN);
    expect(snap.slots[0].iopsRecords[0].store).toBe(STORE_IDB);
  });

  it("unpatch restores originals", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);

    patchIndexedDbPrototypes({ writer, workerTag: fnv1a32("test") });
    unpatchIndexedDbPrototypes();

    const factory = new (globalThis as any).IDBFactory();
    const req = factory.open("test-db");
    if (req.onsuccess) req.onsuccess({ target: req } as any);

    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(0);
  });
});
