import type { Schedule, System, World, ComponentDefinition } from "@downdraft/core";
import type { ViteHotContext, ComponentDefEntry } from "./types";

export interface HotReloadOptions {
  schedule: Schedule;
  world: World;
  componentDefs?: Map<string, ComponentDefinition<any>>;
  onSystemSwapped?: (name: string) => void;
  onComponentMerged?: (name: string, addedFields: string[]) => void;
}

export interface HotReloadHandle {
  accept: (hot: ViteHotContext) => void;
  swapSystem: (newSystem: System) => void;
  mergeComponentDefaults: (name: string, newDefaults: Record<string, unknown>) => void;
  dispose: () => void;
}

export function createHotReload(opts: HotReloadOptions): HotReloadHandle {
  const { schedule, world, componentDefs, onSystemSwapped, onComponentMerged } = opts;

  const swapSystem = (newSystem: System): void => {
    schedule.removeSystem(newSystem.name);
    schedule.addSystem(newSystem);
    schedule.updateQueryArchetypes(world.allArchetypes);
    onSystemSwapped?.(newSystem.name);
  };

  const mergeComponentDefaults = (
    name: string,
    newDefaults: Record<string, unknown>,
  ): void => {
    const def = componentDefs?.get(name);
    if (!def) return;

    const oldDefaults = def.defaults;
    const addedFields: string[] = [];

    for (const key of Object.keys(newDefaults)) {
      if (!(key in oldDefaults)) {
        addedFields.push(key);
      }
    }

    if (addedFields.length === 0) return;

    for (const archetype of world.allArchetypes) {
      if (!archetype.componentSet.has(def.id)) continue;
      const column = archetype.columns.get(def.id);
      if (!column) continue;

      for (let row = 0; row < column.length; row++) {
        const existing = column[row] as Record<string, unknown>;
        for (const field of addedFields) {
          if (!(field in existing)) {
            existing[field] = newDefaults[field];
          }
        }
      }
    }

    Object.assign(def.defaults, newDefaults);

    onComponentMerged?.(name, addedFields);
  };

  const accept = (hot: ViteHotContext): void => {
    hot.accept(() => {
      // The module will re-execute and call swapSystem/mergeComponentDefaults
      // from the new module's init code.
    });
  };

  const dispose = (): void => {
    // Nothing to clean up — state lives in the schedule/world
  };

  return {
    accept,
    swapSystem,
    mergeComponentDefaults,
    dispose,
  };
}
