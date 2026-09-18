// ============================================================================
// Renderer IndexedDB disabling — replaces window.indexedDB with a proxy that
// throws for any open/databases/cmp call unless the db name is in an allowlist.
//
// The default save path is OPFS-in-worker (unaffected). Renderer IDB is
// disabled by default to prevent accidental renderer-thread persistence.
// Games opt in via enableRendererIndexedDb(dbName).
// ============================================================================

let realIndexedDB: IDBFactory | null = null;
let patched: boolean = false;
const allowlist = new Set<string>();

/**
 * Disable window.indexedDB in the renderer. Any call to open/databases/cmp
 * throws a ReferenceError unless the db name is in the allowlist.
 * Idempotent.
 */
export function disableRendererIndexedDb(): void {
  if (patched) return;
  if (typeof window === "undefined") return; // not a renderer
  const win = window as any;
  // Capture the real indexedDB before patching
  realIndexedDB = win.indexedDB;
  if (!realIndexedDB) return;

  const proxy = new Proxy(realIndexedDB, {
    get(target, prop, receiver) {
      if (prop === "open") {
        return (name: string, ...rest: any[]): IDBOpenDBRequest => {
          if (!allowlist.has(name)) {
            throw new ReferenceError(
              `IndexedDB is disabled in the renderer by default; call enableRendererIndexedDb("${name}") to opt in.`,
            );
          }
          return target.open(name, ...rest);
        };
      }
      if (prop === "databases") {
        return () => {
          // Only return allowed dbs
          if (typeof target.databases === "function") {
            return target.databases().then((dbs: IDBDatabaseInfo[]) =>
              dbs.filter((db) => allowlist.has(db.name ?? "")),
            );
          }
          return Promise.resolve([]);
        };
      }
      if (prop === "cmp") {
        return (a: any, b: any) => target.cmp(a, b);
      }
      // Forward everything else
      return Reflect.get(target, prop, receiver);
    },
  });

  // window.indexedDB is a getter-only property on the Window prototype in
  // some environments (Electron, some browsers). Use defineProperty to
  // override it with a getter that returns our proxy.
  try {
    Object.defineProperty(win, "indexedDB", {
      get: () => proxy,
      configurable: true,
    });
  } catch {
    // If defineProperty fails (non-configurable), fall back to direct
    // assignment — works in environments where the property is writable.
    try {
      win.indexedDB = proxy;
    } catch {
      // If both fail, patch IDBFactory.prototype.open instead.
      patchPrototypeOpen(realIndexedDB);
    }
  }
  // Also patch the prototype so Object.getPrototypeOf checks still work
  try {
    Object.setPrototypeOf(proxy, Object.getPrototypeOf(realIndexedDB));
  } catch {
    // ignore — some browsers don't allow setting prototype of Proxy
  }
  patched = true;
}

/**
 * Enable a specific database name in the renderer's IndexedDB allowlist.
 * Call this before the save store factory runs.
 */
export function enableRendererIndexedDb(dbName: string): void {
  allowlist.add(dbName);
}

/** Re-enable IndexedDB fully (restores the original). For testing. */
export function enableAllRendererIndexedDb(): void {
  if (!patched || !realIndexedDB) return;
  const win = window as any;
  try {
    Object.defineProperty(win, "indexedDB", {
      get: () => realIndexedDB,
      configurable: true,
    });
  } catch {
    try {
      win.indexedDB = realIndexedDB;
    } catch {
      // Can't restore — leave patched
    }
  }
  if (protoOpenOriginal) {
    IDBFactory.prototype.open = protoOpenOriginal;
    protoOpenOriginal = null;
  }
  patched = false;
  allowlist.clear();
}

/** Check if renderer IndexedDB is currently disabled. */
export function isRendererIndexedDbDisabled(): boolean {
  return patched;
}

// ── Prototype-level fallback ──
// Used when window.indexedDB cannot be overridden (non-configurable getter).
// Patches IDBFactory.prototype.open directly.
let protoOpenOriginal: ((name: string, version?: number) => IDBOpenDBRequest) | null = null;

function patchPrototypeOpen(realIdb: IDBFactory): void {
  if (protoOpenOriginal) return; // already patched
  const proto = IDBFactory.prototype;
  protoOpenOriginal = proto.open;
  proto.open = function (name: string, version?: number): IDBOpenDBRequest {
    if (!allowlist.has(name)) {
      throw new ReferenceError(
        `IndexedDB is disabled in the renderer by default; call enableRendererIndexedDb("${name}") to opt in.`,
      );
    }
    return protoOpenOriginal!.call(this, name, version);
  };
}
