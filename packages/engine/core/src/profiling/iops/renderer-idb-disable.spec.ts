import {
    disableRendererIndexedDb,
    enableAllRendererIndexedDb,
    enableRendererIndexedDb,
    isRendererIndexedDbDisabled,
} from "./renderer-idb-disable";

describe("Renderer IndexedDB disabling", () => {
  // Save + restore window.indexedDB around each test
  let originalIndexedDB: any;

  function setIndexedDB(value: any): void {
    const win = (globalThis as any).window;
    if (win) {
      Object.defineProperty(win, "indexedDB", {
        get: () => value,
        configurable: true,
      });
    }
    (globalThis as any).indexedDB = value;
  }

  beforeEach(() => {
    originalIndexedDB = (globalThis as any).window?.indexedDB ?? (globalThis as any).indexedDB;
    // Set up a mock window.indexedDB for testing
    const mockFactory = {
      open: (name: string) => ({ name, result: {}, onsuccess: null, onerror: null }),
      databases: () => Promise.resolve([{ name: "test-db" }]),
      cmp: (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0),
    };
    if (typeof (globalThis as any).window === "undefined") {
      (globalThis as any).window = {};
    }
    setIndexedDB(mockFactory);
  });

  afterEach(() => {
    enableAllRendererIndexedDb();
    if (originalIndexedDB !== undefined) {
      setIndexedDB(originalIndexedDB);
    }
  });

  it("disableRendererIndexedDb replaces window.indexedDB with a proxy", () => {
    disableRendererIndexedDb();
    expect(isRendererIndexedDbDisabled()).toBe(true);
  });

  it("open throws ReferenceError for non-allowlisted db", () => {
    disableRendererIndexedDb();
    expect(() => {
      (globalThis as any).window.indexedDB.open("disallowed-db");
    }).toThrow(ReferenceError);
  });

  it("open works for allowlisted db", () => {
    disableRendererIndexedDb();
    enableRendererIndexedDb("allowed-db");
    expect(() => {
      (globalThis as any).window.indexedDB.open("allowed-db");
    }).not.toThrow();
  });

  it("enableAllRendererIndexedDb restores the original", () => {
    disableRendererIndexedDb();
    expect(isRendererIndexedDbDisabled()).toBe(true);
    enableAllRendererIndexedDb();
    expect(isRendererIndexedDbDisabled()).toBe(false);
    // Should be able to open any db now
    expect(() => {
      (globalThis as any).window.indexedDB.open("any-db");
    }).not.toThrow();
  });

  it("is idempotent — calling disable twice doesn't break", () => {
    disableRendererIndexedDb();
    disableRendererIndexedDb();
    expect(isRendererIndexedDbDisabled()).toBe(true);
  });
});
