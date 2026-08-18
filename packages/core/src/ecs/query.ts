import type { Archetype } from "./archetype";
import { archetypeMatches, getComponentColumn } from "./archetype";
import type { ComponentDefinition, ComponentId } from "./component";

export interface QueryDescriptor {
  required: ComponentId[];
  excluded: ComponentId[];
  changedFilter?: ComponentId;
  lastReadTick: number;
}

export class Query {
  readonly descriptor: QueryDescriptor;
  private archetypes: Archetype[] = [];
  private cachedArchetypes: Set<number> = new Set();

  private iterComps: unknown[] = [];
  private iterColumns: unknown[][] = [];

  constructor(required: ComponentId[], excluded: ComponentId[] = [], changedFilter?: ComponentId) {
    this.descriptor = {
      required,
      excluded,
      changedFilter,
      lastReadTick: 0,
    };
  }

  updateArchetypes(allArchetypes: Archetype[]): void {
    this.archetypes.length = 0;
    this.cachedArchetypes.clear();
    for (let i = 0; i < allArchetypes.length; i++) {
      const arch = allArchetypes[i];
      if (archetypeMatches(arch, this.descriptor.required, this.descriptor.excluded)) {
        this.archetypes.push(arch);
        this.cachedArchetypes.add(arch.id);
      }
    }
  }

  matchesArchetype(arch: Archetype): boolean {
    return this.cachedArchetypes.has(arch.id);
  }

  iterate<T extends unknown[]>(
    currentTick: number,
    fn: (entity: import("./entity").Entity, components: T, row: number) => void,
  ): void {
    const required = this.descriptor.required;
    const changedFilter = this.descriptor.changedFilter;
    const ncomps = required.length;
    const comps = this.iterComps;
    if (comps.length !== ncomps) comps.length = ncomps;

    for (let a = 0; a < this.archetypes.length; a++) {
      const arch = this.archetypes[a];
      const entities = arch.entities;
      const count = entities.length;

      const columns = this.iterColumns;
      if (columns.length !== ncomps) columns.length = ncomps;
      for (let r = 0; r < ncomps; r++) {
        columns[r] = getComponentColumn(arch, required[r]);
      }

      if (changedFilter !== undefined) {
        const changedCol = getComponentColumn<{ lastChanged: number }>(arch, changedFilter);
        if (!changedCol) continue;
        for (let row = 0; row < count; row++) {
          if (changedCol[row].lastChanged >= this.descriptor.lastReadTick) {
            for (let c = 0; c < ncomps; c++) comps[c] = columns[c][row];
            fn(entities[row], comps as T, row);
          }
        }
      } else {
        for (let row = 0; row < count; row++) {
          for (let c = 0; c < ncomps; c++) comps[c] = columns[c][row];
          fn(entities[row], comps as T, row);
        }
      }
    }

    this.descriptor.lastReadTick = currentTick;
  }

  count(): number {
    let total = 0;
    for (let i = 0; i < this.archetypes.length; i++) {
      total += this.archetypes[i].entities.length;
    }
    return total;
  }
}

export function query(
  ...required: ComponentId[]
): Query {
  return new Query(required);
}

export function queryExcluded(
  required: ComponentId[],
  excluded: ComponentId[],
): Query {
  return new Query(required, excluded);
}

export function queryChanged(
  required: ComponentId[],
  changedComponent: ComponentId,
): Query {
  return new Query(required, [], changedComponent);
}

export function queryFromDefs(
  ...defs: ComponentDefinition<Record<string, unknown>>[]
): Query {
  return new Query(defs.map((d) => d.id));
}
