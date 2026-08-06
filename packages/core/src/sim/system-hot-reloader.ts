// ============================================================================
// SystemHotReloader — runtime ECS system swapping for hot-reload.
//
// Tracks system factory functions by module path. When a module changes:
//   1. Dynamic-imports the new module (busting the cache with ?t=)
//   2. Calls the factory to get a new System
//   3. Removes the old system from the Schedule (by name)
//   4. Adds the new system to the Schedule
//
// Entity state, component data, and queries all persist across the swap.
// Only the system function (the tick logic) is replaced.
//
// Two paths:
//   - Vite HMR: import.meta.hot.accept() in the worker calls swap() directly
//   - RPC fallback: main thread calls hotSwapModule() with the file path,
//     worker dynamic-imports the new module and swaps
// ============================================================================

import type { Schedule } from "../ecs/schedule";
import type { System } from "../ecs/system";

export type SystemFactory = () => System;

interface RegisteredSystem {
  name: string;
  factory: SystemFactory;
  modulePath: string;
}

export class SystemHotReloader {
  private schedule: Schedule;
  private systems: Map<string, RegisteredSystem> = new Map();
  // Map: module path → system names produced by that module
  private moduleToSystems: Map<string, string[]> = new Map();

  constructor(schedule: Schedule) {
    this.schedule = schedule;
  }

  /**
   * Register a system factory for hot-reload tracking.
   * The factory is called immediately to create the system, and again on swap.
   * The modulePath is used to match against Vite HMR / RPC hot-swap requests.
   */
  register(modulePath: string, factory: SystemFactory): System {
    const sys = factory();
    this.schedule.addSystem(sys);

    this.systems.set(sys.name, { name: sys.name, factory, modulePath });
    const names = this.moduleToSystems.get(modulePath) ?? [];
    names.push(sys.name);
    this.moduleToSystems.set(modulePath, names);

    return sys;
  }

  /**
   * Swap all systems from a given module path.
   * Called when the module has already been updated (Vite HMR path).
   * The caller provides the new factory functions.
   */
  swapByModule(modulePath: string, newFactories: SystemFactory[]): void {
    const names = this.moduleToSystems.get(modulePath);
    if (!names || names.length === 0) {
      console.warn(`[SystemHotReloader] No systems registered for module: ${modulePath}`);
      return;
    }

    for (const name of names) {
      this.schedule.removeSystem(name);
    }

    // Clear old registrations for this module
    for (const name of names) {
      this.systems.delete(name);
    }
    this.moduleToSystems.delete(modulePath);

    // Re-register with new factories
    for (const factory of newFactories) {
      this.register(modulePath, factory);
    }

    console.log(`[SystemHotReloader] Swapped ${names.length} system(s) from ${modulePath}`);
  }

  /**
   * Hot-swap by module path using dynamic import.
   * This is the RPC fallback path (approach 2) — used when Vite HMR
   * isn't available but the main thread can tell the worker which file changed.
   *
   * The module must export a `__hotReloadSystems` function that returns
   * an array of SystemFactory functions.
   */
  async swapByDynamicImport(modulePath: string, cacheBust: number): Promise<boolean> {
    const names = this.moduleToSystems.get(modulePath);
    if (!names || names.length === 0) {
      // Not a tracked system module — caller should fall back to full reload
      return false;
    }

    try {
      const url = `${modulePath}?t=${cacheBust}`;
      const mod = await import(url);
      if (typeof mod.__hotReloadSystems !== "function") {
        console.warn(`[SystemHotReloader] Module ${modulePath} does not export __hotReloadSystems — falling back`);
        return false;
      }
      const factories: SystemFactory[] = mod.__hotReloadSystems();
      this.swapByModule(modulePath, factories);
      return true;
    } catch (err) {
      console.error(`[SystemHotReloader] Dynamic import failed for ${modulePath}: ${err}`);
      return false;
    }
  }

  /**
   * Check if any registered system comes from the given module path.
   */
  hasModule(modulePath: string): boolean {
    return this.moduleToSystems.has(modulePath);
  }

  /**
   * Get all registered system names.
   */
  getSystemNames(): string[] {
    return Array.from(this.systems.keys());
  }
}
