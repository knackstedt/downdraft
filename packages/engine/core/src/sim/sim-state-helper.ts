// ============================================================================
// SimStateHelper — worker-side helper that wraps ISimulation and adds
// transient state management to save/restore operations.
//
// During save: calls sim.serializeState(), then strips transient flags from
// the serialized JSON before returning it.
// During restore: calls sim.restoreState(), then resets all transient system
// state via registry.resetAll(), then calls sim.rebuildAfterRestore().
// ============================================================================

import { createLogger } from "../util/logger";
import { TransientStateRegistry } from "./transient-state-registry";
import type { ISimulation } from "./types";

const log = createLogger();

export class SimStateHelper {
  private sim: ISimulation;
  private registry: TransientStateRegistry;

  constructor(sim: ISimulation, registry?: TransientStateRegistry) {
    this.sim = sim;
    this.registry = registry ?? new TransientStateRegistry();
  }

  getRegistry(): TransientStateRegistry {
    return this.registry;
  }

  saveState(): string {
    const stateJson = this.sim.serializeState();
    try {
      const state = JSON.parse(stateJson) as Record<string, unknown>;
      this.registry.stripTransientFlags(state);
      return JSON.stringify(state);
    } catch (err) {
      log.error("SimStateHelper", `Failed to strip transient flags: ${err}`);
      return stateJson;
    }
  }

  async restoreState(stateJson: string): Promise<void> {
    this.sim.restoreState(stateJson);
    this.registry.resetAll();
    await this.sim.rebuildAfterRestore();
  }
}
