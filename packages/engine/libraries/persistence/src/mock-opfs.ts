// ============================================================================
// Mock OPFS — in-memory implementation of the OPFS FileSystemDirectoryHandle
// / FileSystemFileHandle interfaces for testing OpfsSaveStore without a real
// browser/worker environment.
// ============================================================================

interface MockFile {
  name: string;
  data: Uint8Array;
}

class MockFileHandle {
  kind = "file" as const;
  name: string;
  file: MockFile;

  constructor(name: string, file: MockFile) {
    this.name = name;
    this.file = file;
  }

  async getFile(): Promise<{
    name: string;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }> {
    return {
      name: this.file.name,
      size: this.file.data.length,
      arrayBuffer: async () => this.file.data.buffer.slice(this.file.data.byteOffset, this.file.data.byteOffset + this.file.data.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(this.file.data),
    };
  }

  async createWritable(): Promise<{
    write(data: BufferSource | string): Promise<void>;
    close(): Promise<void>;
  }> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: BufferSource | string) => {
        if (typeof data === "string") {
          chunks.push(new TextEncoder().encode(data));
        } else {
          const buf = data as ArrayBufferView;
          chunks.push(new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        }
      },
      close: async () => {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        chunks.forEach((c) => { merged.set(c, off); off += c.length; });
        this.file.data = merged;
      },
    };
  }

  async createSyncAccessHandle(): Promise<{
    write(data: BufferSource): number;
    flush(): void;
    close(): void;
    getSize(): number;
    read(buffer: ArrayBufferView, opts?: { at?: number }): number;
  }> {
    return {
      write: (data: BufferSource) => {
        const buf = data as ArrayBufferView;
        const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        this.file.data = new Uint8Array(view);
        return view.length;
      },
      flush: () => {},
      close: () => {},
      getSize: () => this.file.data.length,
      read: () => 0,
    };
  }
}

class MockDirHandle {
  kind = "directory" as const;
  name: string;
  dirs = new Map<string, MockDirHandle>();
  files = new Map<string, MockFileHandle>();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MockDirHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new Error(`Directory '${name}' not found`);
      dir = new MockDirHandle(name);
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MockFileHandle> {
    let file = this.files.get(name);
    if (!file) {
      if (!opts?.create) throw new Error(`File '${name}' not found`);
      const mockFile: MockFile = { name, data: new Uint8Array(0) };
      file = new MockFileHandle(name, mockFile);
      this.files.set(name, file);
    }
    return file;
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const k of this.dirs.keys()) yield k;
    for (const k of this.files.keys()) yield k;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    if (this.dirs.has(name)) {
      this.dirs.delete(name);
      return;
    }
    if (this.files.has(name)) {
      this.files.delete(name);
      return;
    }
    throw new Error(`Entry '${name}' not found`);
  }

  async *values(): AsyncIterableIterator<MockDirHandle | MockFileHandle> {
    for (const d of this.dirs.values()) yield d;
    for (const f of this.files.values()) yield f;
  }
}

/** Create a fresh mock OPFS root directory for testing. */
export function createMockOpfsRoot(): MockDirHandle {
  return new MockDirHandle("root");
}

export type { MockDirHandle, MockFileHandle };
