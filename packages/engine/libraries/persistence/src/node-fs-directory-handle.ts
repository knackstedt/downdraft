// ============================================================================
// node-fs-directory-handle.ts — FileSystemDirectoryHandle over node:fs
//
// OPFS doesn't exist on the native runtime (Bun workers have direct fs
// access instead). This adapter presents a real directory on disk through
// the subset of the Web File System Access API that the persistence stores
// use — getDirectoryHandle / getFileHandle / removeEntry / getFile /
// createWritable — so OPFS-backed stores work unmodified on native.
//
// Node/Bun only — export it from the index barrel, never from browser.ts.
// ============================================================================

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

function notFound(name: string): Error {
  const e = new Error(`NotFound: ${name}`);
  e.name = "NotFoundError";
  return e;
}

/** Minimal File stand-in — the stores only consume arrayBuffer(). */
class NodeFsFile implements Partial<File> {
  readonly name: string;
  readonly lastModified: number;
  private buf: Buffer;
  constructor(name: string, buf: Buffer, mtimeMs: number) {
    this.name = name;
    this.buf = buf;
    this.lastModified = mtimeMs;
  }
  get size(): number { return this.buf.byteLength; }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.buf.buffer.slice(this.buf.byteOffset, this.buf.byteOffset + this.buf.byteLength) as ArrayBuffer;
  }
}

class NodeFsWritable {
  private chunks: Buffer[] = [];
  constructor(private path: string) {}
  async write(data: unknown): Promise<void> {
    // BinaryRecordStore writes a single Uint8Array then closes — accumulate
    // and flush atomically on close (matches keepExistingData: false).
    if (data instanceof ArrayBuffer) this.chunks.push(Buffer.from(data));
    else if (ArrayBuffer.isView(data)) {
      this.chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } else if (typeof data === "string") this.chunks.push(Buffer.from(data));
    else if (data && typeof data === "object" && "data" in (data as Record<string, unknown>)) {
      // FileSystemWriteChunkType write({type:"write", data}) form.
      const inner = (data as { data: unknown }).data;
      await this.write(inner);
    }
  }
  async close(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, Buffer.concat(this.chunks));
  }
  async abort(): Promise<void> { this.chunks = []; }
}

class NodeFsFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  constructor(private path: string) {
    this.name = basename(path);
  }
  async getFile(): Promise<File> {
    try {
      const st = await fs.stat(this.path);
      if (!st.isFile()) throw notFound(this.path);
      return new NodeFsFile(this.name, await fs.readFile(this.path), st.mtimeMs) as unknown as File;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw notFound(this.path);
      throw e;
    }
  }
  async createWritable(): Promise<NodeFsWritable> {
    return new NodeFsWritable(this.path);
  }
}

export class NodeFsDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  constructor(private path: string) {
    this.name = basename(path);
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<NodeFsDirectoryHandle> {
    const p = join(this.path, name);
    if (opts?.create) {
      await fs.mkdir(p, { recursive: true });
      return new NodeFsDirectoryHandle(p);
    }
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw notFound(p);
    return new NodeFsDirectoryHandle(p);
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<NodeFsFileHandle> {
    const p = join(this.path, name);
    if (opts?.create) {
      await fs.mkdir(this.path, { recursive: true });
      await fs.writeFile(p, Buffer.alloc(0), { flag: "a" }); // create only if absent
      return new NodeFsFileHandle(p);
    }
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) throw notFound(p);
    return new NodeFsFileHandle(p);
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = join(this.path, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st) throw notFound(p);
    if (st.isDirectory() && !opts?.recursive) {
      // OPFS requires {recursive:true} for non-empty dirs; mirror that.
      const entries = await fs.readdir(p);
      if (entries.length) {
        const e = new Error(`InvalidModification: ${p} is not empty`);
        e.name = "InvalidModificationError";
        throw e;
      }
      await fs.rmdir(p);
      return;
    }
    await fs.rm(p, { recursive: !!opts?.recursive, force: false });
  }

  // The rest of the FileSystemDirectoryHandle surface isn't needed by the
  // persistence stores — present as throwing stubs to satisfy the interface.
  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const e of await fs.readdir(this.path, { withFileTypes: true })) {
      yield [e.name, e.isDirectory()
        ? (new NodeFsDirectoryHandle(join(this.path, e.name)) as unknown as FileSystemHandle)
        : (new NodeFsFileHandle(join(this.path, e.name)) as unknown as FileSystemHandle)];
    }
  }
  keys(): AsyncIterableIterator<string> { return this.iterKeys(); }
  private async *iterKeys(): AsyncIterableIterator<string> {
    for (const e of await fs.readdir(this.path)) yield e;
  }
  values(): AsyncIterableIterator<FileSystemHandle> {
    const self = this;
    return (async function* () {
      for await (const [, h] of self.entries()) yield h;
    })();
  }
  [Symbol.asyncIterator]() { return this.entries(); }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof NodeFsDirectoryHandle && other.path === this.path;
  }
}

/**
 * Wrap `basePath` as a FileSystemDirectoryHandle-compatible root. The
 * directory is created lazily on first write (`{create:true}` calls mkdir);
 * reads on a missing path reject with NotFoundError like OPFS does.
 */
export function createNodeFsDirectoryHandle(basePath: string): FileSystemDirectoryHandle {
  return new NodeFsDirectoryHandle(basePath) as unknown as FileSystemDirectoryHandle;
}
