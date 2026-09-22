// ============================================================================
// blob-urls.ts — URL.createObjectURL / revokeObjectURL polyfill
//
// Browsers mint `blob:<uuid>` handles for in-memory Blobs; Node/Bun's URL
// class doesn't. The registry here backs those URLs so `img.src = blob:...`
// (thumbnail pipeline), `fetch(blob:...)`, and engine code that round-trips
// object URLs all work on the native host.
// ============================================================================

import { randomUUID } from "node:crypto";

const registry = new Map<string, Blob>();

/** Resolve a `blob:` URL to its Blob, or null if unknown/revoked. */
export function resolveBlobUrl(url: string): Blob | null {
  return registry.get(url) ?? null;
}

/**
 * Install createObjectURL/revokeObjectURL on the global URL class. Idempotent
 * and only fills in what's missing (Bun may provide its own).
 */
export function installBlobUrls(): void {
  const urlCtor = URL as unknown as Record<string, unknown>;
  if (typeof urlCtor.createObjectURL !== "function") {
    urlCtor.createObjectURL = (blob: Blob): string => {
      const url = `blob:dd-native://${randomUUID()}`;
      registry.set(url, blob);
      return url;
    };
  }
  if (typeof urlCtor.revokeObjectURL !== "function") {
    urlCtor.revokeObjectURL = (url: string): void => {
      registry.delete(url);
    };
  }
}
