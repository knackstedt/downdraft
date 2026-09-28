// DORMANT — no live consumers; superseded by native FS access in
// platform-native. Retained only for the core/index.ts re-export until
// deletion (Phase 7 of docs/refactor/native-rearchitecture-plan.md).
// node:fs is imported lazily inside each method — VirtualFS is re-exported
// from the universal barrel (`core/src/index.ts`), so node builtins must not
// be evaluated at import time in browser bundles.
const fs = () => import("node:fs");

export class VirtualFS {
  private root: string;

  constructor(root: string = ".") {
    this.root = root;
  }

  getRoot(): string {
    return this.root;
  }

  resolve(path: string): string {
    if (path.startsWith("/")) return path;
    return `${this.root}/${path}`;
  }

  async readText(path: string): Promise<string> {
    return (await fs()).promises.readFile(this.resolve(path), "utf-8");
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await (await fs()).promises.readFile(this.resolve(path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  async exists(path: string): Promise<boolean> {
    return (await fs()).existsSync(this.resolve(path));
  }
}
