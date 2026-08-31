import {
  patchOpfsPrototypes,
  unpatchOpfsPrototypes,
  OPFS_OP_GET_FILE_HANDLE,
  OPFS_OP_GET_FILE,
} from "./opfs-patch";
import {
  allocateProfilingSAB,
  claimSlot,
  ProfilingSABWriter,
  ProfilingSABReader,
  fnv1a32,
  RUNTIME_JS,
  STORE_OPFS,
} from "../profiling-sab";
import { WarningEngine, METRIC_IOPS_LATENCY, SEVERITY_WARN } from "../warnings";

// Minimal mock OPFS for testing prototype patching
function setupMockOpfs() {
  const mockFile = { name: "test.dat", data: new Uint8Array([1, 2, 3, 4]) };
  const mockFileHandle = {
    kind: "file" as const,
    name: "test.dat",
    file: mockFile,
    async getFile() {
      return {
        name: mockFile.name,
        size: mockFile.data.length,
        arrayBuffer: async () => mockFile.data.buffer,
        text: async () => new TextDecoder().decode(mockFile.data),
      };
    },
    async createWritable() {
      const chunks: Uint8Array[] = [];
      return {
        write: async (data: any) => {
          if (typeof data === "string") chunks.push(new TextEncoder().encode(data));
          else chunks.push(new Uint8Array(data));
        },
        close: async () => {},
      };
    },
  };
  const mockDirHandle = {
    kind: "directory" as const,
    name: "root",
    async getFileHandle(name: string) { return mockFileHandle; },
    async getDirectoryHandle(name: string) { return mockDirHandle; },
  };

  // Set up prototypes on globalThis
  (globalThis as any).FileSystemDirectoryHandle = function FileSystemDirectoryHandle() {};
  (globalThis as any).FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (name: string) { return mockDirHandle; };
  (globalThis as any).FileSystemDirectoryHandle.prototype.getFileHandle = async function (name: string) { return mockFileHandle; };

  (globalThis as any).FileSystemFileHandle = function FileSystemFileHandle() {};
  (globalThis as any).FileSystemFileHandle.prototype.getFile = async function () {
    return {
      name: mockFile.name,
      size: mockFile.data.length,
      arrayBuffer: async () => mockFile.data.buffer,
    };
  };
  (globalThis as any).FileSystemFileHandle.prototype.createWritable = async function () {
    return { write: async () => {}, close: async () => {} };
  };

  return { mockDirHandle, mockFileHandle, mockFile };
}

describe("OPFS prototype patching", () => {
  beforeEach(() => {
    setupMockOpfs();
  });
  afterEach(() => {
    unpatchOpfsPrototypes();
  });

  it("patches prototypes and records IOPS", async () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    const warningEngine = new WarningEngine(writer);
    warningEngine.setWorkerTag(fnv1a32("test"));

    patchOpfsPrototypes({
      writer,
      warningEngine,
      workerTag: fnv1a32("test"),
    });

    // Call a patched method
    const dirHandle = new (globalThis as any).FileSystemDirectoryHandle();
    await dirHandle.getFileHandle("test.dat");

    // Read back IOPS
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(1);
    expect(snap.slots[0].iopsRecords[0].opKind).toBe(OPFS_OP_GET_FILE_HANDLE);
    expect(snap.slots[0].iopsRecords[0].store).toBe(STORE_OPFS);
    expect(snap.slots[0].iopsRecords[0].latencyUs).toBeGreaterThanOrEqual(0);
  });

  it("records bytes for getFile", async () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);

    patchOpfsPrototypes({ writer, workerTag: fnv1a32("test") });

    const fileHandle = new (globalThis as any).FileSystemFileHandle();
    await fileHandle.getFile();

    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(1);
    expect(snap.slots[0].iopsRecords[0].bytes).toBe(4); // mock file size
  });

  it("fires warningEngine.checkInstant for slow IOPS", async () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    const warningEngine = new WarningEngine(null);
    warningEngine.setWorkerTag(fnv1a32("test"));
    warningEngine.addRule({
      id: "test:iops",
      severity: SEVERITY_WARN,
      metric: METRIC_IOPS_LATENCY,
      compare: ">",
      threshold: 0, // any latency triggers
      cooldownMs: 0,
    });
    const fired: any[] = [];
    warningEngine.onWarning((rec) => fired.push(rec));

    patchOpfsPrototypes({ writer, warningEngine, workerTag: fnv1a32("test") });

    const dirHandle = new (globalThis as any).FileSystemDirectoryHandle();
    await dirHandle.getFileHandle("test.dat");

    expect(fired.length).toBe(1);
    expect(fired[0].metricKind).toBe(METRIC_IOPS_LATENCY);
  });

  it("unpatchOpfsPrototypes restores originals", async () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);

    patchOpfsPrototypes({ writer, workerTag: fnv1a32("test") });
    unpatchOpfsPrototypes();

    // After unpatching, calls should still work but not record IOPS
    const dirHandle = new (globalThis as any).FileSystemDirectoryHandle();
    await dirHandle.getFileHandle("test.dat");

    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(0);
  });
});
