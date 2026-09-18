import { existsSync, promises as fs } from "node:fs";

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
    return fs.readFile(this.resolve(path), "utf-8");
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.resolve(path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }
}
