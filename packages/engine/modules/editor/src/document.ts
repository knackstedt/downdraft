// ============================================================================
// EditorDocument — the design-world document the editor edits.
//
// Wraps the EngineContext's Scene/World/Hierarchy plus editor-owned metadata
// (display names, file path, dirty state). Commands mutate the world through
// this document; the `.ddscene` serializer (ddscene.ts) round-trips it to
// disk.
//
// Display names are document metadata, not a component — games are free to
// have their own "name" component; the editor's name is authoring chrome.
// ============================================================================

import { isAlive, type Entity, type Scene, type World } from "@downdraft/engine";

export type DocumentChangeKind =
  | "structure"      // entity spawned/removed/reparented
  | "data"           // component data changed
  | "meta"           // names/flags changed
  | "file";          // opened/saved (path + dirty reset)

export interface DocumentChange {
  kind: DocumentChangeKind;
  entity?: string;
}

export class EditorDocument {
  name: string;
  filePath: string | null = null;

  private scene: Scene;
  private names = new Map<string, string>();
  private dirty = false;
  private version = 0;
  private listeners = new Set<(change: DocumentChange) => void>();

  constructor(scene: Scene, name?: string) {
    this.scene = scene;
    this.name = name ?? scene.name;
  }

  get world(): World {
    return this.scene.world;
  }

  get entityCount(): number {
    return this.scene.getEntityCount();
  }

  key(entity: Entity): string {
    return `${entity.index}.${entity.generation}`;
  }

  parse(key: string): Entity | null {
    const parts = key.split(".");
    if (parts.length !== 2) return null;
    const index = parseInt(parts[0]!, 10);
    const generation = parseInt(parts[1]!, 10);
    if (Number.isNaN(index) || Number.isNaN(generation)) return null;
    return { index, generation };
  }

  isAliveKey(key: string): boolean {
    const e = this.parse(key);
    return e !== null && isAlive(this.world.entities, e);
  }

  /** All live entities tracked by the document's scene. */
  entities(): Entity[] {
    return this.scene.getEntities();
  }

  entityKeys(): string[] {
    return this.entities().map((e) => this.key(e));
  }

  entityName(key: string): string | undefined {
    return this.names.get(key);
  }

  setEntityName(key: string, name: string | undefined): void {
    if (name === undefined || name === "") this.names.delete(key);
    else this.names.set(key, name);
  }

  /** Display label: authored name if present, else `Entity <key>`. */
  label(key: string): string {
    return this.names.get(key) ?? `Entity ${key}`;
  }

  /** Reset all editor metadata (called when a new doc is loaded in place). */
  resetMeta(name: string): void {
    this.names.clear();
    this.name = name;
    this.filePath = null;
    this.dirty = false;
    this.version++;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getVersion(): number {
    return this.version;
  }

  markDirty(change: DocumentChange): void {
    this.dirty = true;
    this.version++;
    this.listeners.forEach((fn) => fn(change));
  }

  markClean(): void {
    this.dirty = false;
    this.version++;
    this.listeners.forEach((fn) => fn({ kind: "file" }));
  }

  onChange(fn: (change: DocumentChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
