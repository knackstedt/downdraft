// Renderer-side path shim — stubs for Node.js `path` module.
// The real `path` module is only used inside Node.js detection branches
// (e.g. draco3dgltf's `if (typeof process.versions.node)` blocks) which
// never execute in the browser. These stubs satisfy the import without
// pulling in Node.js builtins.

export function normalize(p: string): string { return p; }
export function dirname(p: string): string { return "."; }
export function join(...paths: string[]): string { return paths.join("/"); }
export function resolve(...paths: string[]): string { return paths.join("/"); }
export function extname(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i) : "";
}
export function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export default { normalize, dirname, join, resolve, extname, basename };
