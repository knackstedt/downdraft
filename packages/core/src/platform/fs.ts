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
    return Bun.file(this.resolve(path)).text();
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return Bun.file(this.resolve(path)).arrayBuffer();
  }

  async exists(path: string): Promise<boolean> {
    return await Bun.file(this.resolve(path)).exists();
  }
}
