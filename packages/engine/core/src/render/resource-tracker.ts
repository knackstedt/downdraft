/**
 * GPU resource destruction helpers.
 *
 * WebGPU objects (GPURenderPipeline, GPUBuffer, GPUTexture, GPUShaderModule,
 * GPUBindGroup, GPUSampler, GPUTextureView) should be explicitly `.destroy()`ed
 * when no longer needed. These helpers ensure all resources in a collection are
 * destroyed before the collection is cleared.
 */

/** A type representing any GPU resource that has a `destroy()` method. */
export interface Destroyable {
  destroy(): void;
}

/**
 * Calls `.destroy()` on every non-null resource in the array.
 * Swallows errors from individual destroy calls so one failure doesn't
 * prevent cleanup of remaining resources.
 */
export function destroyAll(resources: (Destroyable | null | undefined)[]): void {
  resources.forEach((res) => {
    if (res) {
      try {
        res.destroy();
      } catch {
        // Swallow — resource may already be destroyed or invalid
      }
    }
  });
}

/**
 * Destroys all values in a Map that hold destroyable resources, then clears
 * the map. Safe to call on maps with mixed value types — non-destroyable
 * values are simply removed.
 */
export function destroyMapValues<K, V>(map: Map<K, V>): void {
  for (const value of map.values()) {
    if (value && typeof (value as unknown as Destroyable).destroy === "function") {
      try {
        (value as unknown as Destroyable).destroy();
      } catch {
        // Swallow
      }
    }
  }
  map.clear();
}

/**
 * Destroys a single resource if it is non-null and has a destroy method.
 * Sets the property to null after destruction (via a setter callback).
 */
export function destroyAndNull<T extends Destroyable | null | undefined>(
  getResource: () => T,
  setResource: (v: null) => void,
): void {
  const res = getResource();
  if (res) {
    try {
      res.destroy();
    } catch {
      // Swallow
    }
  }
  setResource(null);
}
