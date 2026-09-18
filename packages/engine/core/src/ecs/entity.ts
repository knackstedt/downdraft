export interface Entity {
  index: number;
  generation: number;
}

export const ROOT_ENTITY: Entity = { index: 0, generation: 0 };

export function entityEqual(a: Entity, b: Entity): boolean {
  return a.index === b.index && a.generation === b.generation;
}

export function entityToString(e: Entity): string {
  return `Entity(${e.index}.${e.generation})`;
}

export function isAlive(entities: EntityMeta[], e: Entity): boolean {
  const meta = entities[e.index];
  return meta !== undefined && meta.generation === e.generation && meta.alive;
}

export interface EntityMeta {
  generation: number;
  alive: boolean;
  archetypeId: number;
}
