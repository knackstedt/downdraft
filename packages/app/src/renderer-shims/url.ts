// Renderer-side node:url shim — file:// URLs are meaningless in the
// sandboxed renderer (no filesystem access). URL/URLSearchParams are
// already browser globals and need no shim.

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path}`);
}

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  return decodeURIComponent(u.pathname);
}

export function fileURLWithPathIfPossible(url: string | URL): string {
  return fileURLToPath(url);
}

export default { pathToFileURL, fileURLToPath };
