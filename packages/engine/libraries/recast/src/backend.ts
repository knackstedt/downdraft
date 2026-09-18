// ============================================================================
// RecastBackend — WASM loader + navmesh generation/query wrapper
//
// Mirrors the loadPhysicsLib() pattern from @downdraft/engine/libraries/physics-rapier:
//   - cached + coalesced async load (hot-reload/dispose cycles can retry)
//   - WASM import isolated to one module so the rest of the library stays
//     WASM-agnostic and testable.
//
// recast-navigation ships as ESM with the .wasm loaded via
// `new URL(..., import.meta.url)`. It must be excluded from Vite dep
// pre-bundling (see packages/engine/app/src/vite/index.ts optimizeDeps.exclude).
// ============================================================================

import { createLogger } from "@downdraft/engine";
import type { Crowd, NavMesh, NavMeshQuery } from "recast-navigation";
import type { RecastNavMeshConfig } from "./types";

const log = createLogger();

// ── WASM loader (cached + coalesced) ──

interface RecastModule {
  init: () => Promise<void>;
  NavMesh: typeof import("recast-navigation").NavMesh;
  NavMeshQuery: typeof import("recast-navigation").NavMeshQuery;
  Crowd: typeof import("recast-navigation").Crowd;
}

interface GeneratorsModule {
  generateSoloNavMesh: typeof import("recast-navigation/generators").generateSoloNavMesh;
}

let cachedModule: RecastModule | null = null;
let cachedGenerators: GeneratorsModule | null = null;
let loadingPromise: Promise<RecastModule> | null = null;

/**
 * Loads + initializes the recast-navigation WASM module. Idempotent after the
 * first successful call (recast's `init()` also short-circuits if already
 * initialized). Concurrent callers share the in-flight load; a failed load
 * clears the promise so a retry is possible (important for dev hot-reload).
 */
export function loadRecastLib(): Promise<RecastModule> {
  if (cachedModule) return Promise.resolve(cachedModule);
  if (loadingPromise) return loadingPromise;
  const p = doLoadRecastLib();
  loadingPromise = p;
  p.then(() => { if (loadingPromise === p) loadingPromise = null; })
   .catch(() => { if (loadingPromise === p) loadingPromise = null; });
  return p;
}

async function doLoadRecastLib(): Promise<RecastModule> {
  const mod = await import("recast-navigation");
  await mod.init();
  cachedModule = mod as unknown as RecastModule;
  cachedGenerators = await import("recast-navigation/generators");
  log.info("recast", "recast-navigation WASM initialized");
  return cachedModule;
}

/** Returns the generators submodule (generateSoloNavMesh, etc.). */
export function getRecastGenerators(): GeneratorsModule {
  if (!cachedGenerators) throw new Error("recast-navigation not loaded. Call loadRecastLib() first.");
  return cachedGenerators;
}

// ── RecastBackend ──

/**
 * Wraps a generated recast {@link NavMesh} + a {@link NavMeshQuery}. Created
 * by {@link RecastLib.sim.create} and exposed via the {@link RecastNavMeshTok}
 * DI token. Games call `buildNavMesh(positions, indices, config)` once
 * (typically in `onReady`) to populate the mesh from terrain/level geometry.
 */
export class RecastBackend {
  private mod: RecastModule | null = null;
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private destroyed = false;

  /** Asynchronously loads the WasM module. Must be called before buildNavMesh. */
  async init(): Promise<void> {
    if (this.mod) return;
    this.mod = await loadRecastLib();
  }

  private ensureMod(): RecastModule {
    if (!this.mod || this.destroyed) {
      throw new Error("RecastBackend not initialized or destroyed. Call init() first.");
    }
    return this.mod;
  }

  /**
   * Builds a solo (single-tile) navmesh from triangle input.
   *
   * @param positions flat array of vertex positions: [x0,y0,z0, x1,y1,z1, ...]
   * @param indices   flat array of triangle indices: [i0,i1,i2, i3,i4,i5, ...]
   * @param config    optional recast generation config (cell size, agent
   *                  radius, walkable slope, etc.)
   * @returns `true` on success. On failure, logs the recast error + returns false.
   */
  buildNavMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, config?: RecastNavMeshConfig): boolean {
    this.ensureMod(); // ensures WASM is loaded
    const generators = getRecastGenerators();
    const result = generators.generateSoloNavMesh(positions, indices, config);
    if (!result.success) {
      log.error("recast", `generateSoloNavMesh failed: ${result.error}`);
      return false;
    }
    this.navMesh = result.navMesh;
    this.query = new this.mod!.NavMeshQuery(this.navMesh);
    return true;
  }

  /** The generated navmesh. Throws if buildNavMesh hasn't succeeded. */
  getNavMesh(): NavMesh {
    if (!this.navMesh) throw new Error("RecastBackend: navmesh not built. Call buildNavMesh() first.");
    return this.navMesh;
  }

  /** A NavMeshQuery over the built navmesh. Throws if not built. */
  getQuery(): NavMeshQuery {
    if (!this.query) throw new Error("RecastBackend: navmesh not built. Call buildNavMesh() first.");
    return this.query;
  }

  /** Whether buildNavMesh has succeeded and the mesh is usable. */
  isBuilt(): boolean {
    return this.navMesh !== null;
  }

  /** The loaded recast-navigation module (for Crowd construction etc.). */
  getModule(): RecastModule {
    return this.ensureMod();
  }

  /** Releases the navmesh + query. The WASM module itself stays cached. */
  destroy(): void {
    this.destroyed = true;
    // recast NavMesh/NavMeshQuery are GC'd; no explicit destroy on the JS wrappers.
    this.navMesh = null;
    this.query = null;
    this.mod = null;
  }
}

// Re-export the Crowd type for the crowd-system wrapper's type annotations.
export type { Crowd };
