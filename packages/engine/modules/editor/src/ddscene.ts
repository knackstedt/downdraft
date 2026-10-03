// ============================================================================
// .ddscene — the editor's scene document format + SceneLoader.
//
// JSON, versioned, component-name-keyed (stable across code changes —
// numeric component ids are NOT persisted). Entity file ids are stable
// strings ("e_3") so parent references survive respawn.
//
//   serializeDocument(doc)              → DdSceneFile
//   deserializeIntoDocument(doc, file)  → { warnings, idMap }
//   instantiateScene(file, deps)        → spawn-only engine API for games
//   diffScenes(a, b)                    → structural diff for agents/CI
//
// Format is intentionally close to `SerializedScene` (core/scene/scene.ts)
// but persists component *names* and adds names/hierarchy/environment —
// `SerializedScene` is a runtime checkpoint, `.ddscene` is an authored doc.
// ============================================================================

import {
    getColumnValue,
    getComponentId,
    getComponentName,
    isRegisteredComponentName,
    sanitizeObject,
    type Entity,
    type Hierarchy,
    type Scene,
    type World,
} from "@downdraft/engine";

import type { EditorDocument } from "./document";

export const DDSCENE_FORMAT = "ddscene";
export const DDSCENE_VERSION = 1;

export interface DdSceneEntity {
  /** Stable file id — unique within the document. */
  id: string;
  /** Editor display name. */
  name?: string;
  /** File id of the parent entity. */
  parent?: string;
  /** Prefab reference (path or registry name). */
  prefab?: string;
  /** Per-prefab component overrides (recorded over the prefab base). */
  overrides?: Record<string, Record<string, unknown>>;
  /** Component name → data. Absent when the entity is a pure prefab ref. */
  components?: Record<string, Record<string, unknown>>;
}

export interface DdSceneFile {
  format: typeof DDSCENE_FORMAT;
  version: number;
  name: string;
  entities: DdSceneEntity[];
  environment?: Record<string, unknown>;
  camera?: {
    position: [number, number, number];
    target: [number, number, number];
    fov?: number;
  };
  meta: Record<string, unknown>;
}

export interface DeserializeResult {
  warnings: string[];
  /** file id → live entity key ("index.generation"). */
  idMap: Map<string, string>;
}

// ── Serialize ──

export function serializeDocument(doc: EditorDocument, scene: Scene, hierarchy: Hierarchy): DdSceneFile {
  const entities: DdSceneEntity[] = [];
  const fileIds = new Map<string, string>(); // entity key → file id

  for (const entity of doc.entities()) {
    fileIds.set(doc.key(entity), `e_${entity.index}`);
  }

  for (const entity of doc.entities()) {
    const key = doc.key(entity);
    const arch = doc.world.getArchetypeForEntity(entity);
    const components: Record<string, Record<string, unknown>> = {};
    if (arch) {
      const row = arch.entities.findIndex((e) => e.index === entity.index && e.generation === entity.generation);
      if (row >= 0) {
        for (const [cid, col] of arch.columns.entries()) {
          const data = getColumnValue(col, row);
          if (data !== undefined && data !== null) {
            components[getComponentName(cid)] = sanitizeObject(data) as Record<string, unknown>;
          }
        }
      }
    }

    const parent = hierarchy.getParent(entity);
    const entry: DdSceneEntity = {
      id: fileIds.get(key)!,
      components,
    };
    const displayName = doc.entityName(key);
    if (displayName) entry.name = displayName;
    if (parent) {
      const parentFileId = fileIds.get(doc.key(parent));
      if (parentFileId) entry.parent = parentFileId;
    }
    entities.push(entry);
  }

  return {
    format: DDSCENE_FORMAT,
    version: DDSCENE_VERSION,
    name: doc.name,
    entities,
    meta: {
      engineVersion: "0.1.0",
      savedAt: new Date().toISOString(),
    },
  };
}

// ── Deserialize ──

export function deserializeIntoDocument(
  doc: EditorDocument,
  scene: Scene,
  world: World,
  hierarchy: Hierarchy,
  file: DdSceneFile,
): DeserializeResult {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();

  if (file.format !== DDSCENE_FORMAT) {
    throw new Error(`Not a .ddscene document (format="${file.format}")`);
  }
  if (file.version > DDSCENE_VERSION) {
    throw new Error(
      `.ddscene version ${file.version} is newer than this engine supports (${DDSCENE_VERSION})`,
    );
  }

  // Clear the current document contents.
  for (const entity of doc.entities()) {
    world.despawn(entity);
    scene.removeEntity(entity);
  }
  world.flushCommands();
  doc.resetMeta(file.name);

  // Pass 1: spawn entities + components.
  const spawned = new Map<string, Entity>(); // fileId → Entity
  file.entities.forEach((entry) => {
    const components = new Map<number, unknown>();
    for (const [compName, data] of Object.entries(entry.components ?? {})) {
      if (!isRegisteredComponentName(compName)) {
        warnings.push(`entity "${entry.id}": unknown component "${compName}" — skipped`);
        continue;
      }
      components.set(getComponentId(compName), sanitizeObject({ ...data }));
    }
    const entity = world.spawn(components);
    scene.trackEntity(entity);
    spawned.set(entry.id, entity);
    const key = `${entity.index}.${entity.generation}`;
    idMap.set(entry.id, key);
    if (entry.name) doc.setEntityName(key, entry.name);
  });
  world.flushCommands();

  // Pass 2: restore hierarchy (prefab refs resolve in Phase 3 — entries with
  // `prefab` still spawn their own entity shell for now).
  file.entities.forEach((entry) => {
    if (!entry.parent) return;
    const child = spawned.get(entry.id);
    const parent = spawned.get(entry.parent);
    if (child && parent) {
      hierarchy.setParent(child, parent);
    } else {
      warnings.push(`entity "${entry.id}": parent "${entry.parent}" not found — orphaned`);
    }
  });

  doc.markClean();
  return { warnings, idMap };
}

/**
 * `SceneLoader` — the runtime consumption half. Games call this to spawn a
 * `.ddscene` into their own World/Hierarchy. Returns the fileId→Entity map
 * so games can resolve authored references.
 */
export function instantiateScene(
  file: DdSceneFile,
  deps: { world: World; scene?: Scene; hierarchy?: Hierarchy },
): DeserializeResult & { entities: Map<string, Entity> } {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();
  const spawned = new Map<string, Entity>();

  if (file.format !== DDSCENE_FORMAT) {
    throw new Error(`Not a .ddscene document (format="${file.format}")`);
  }

  file.entities.forEach((entry) => {
    const components = new Map<number, unknown>();
    for (const [compName, data] of Object.entries(entry.components ?? {})) {
      if (!isRegisteredComponentName(compName)) {
        warnings.push(`entity "${entry.id}": unknown component "${compName}" — skipped`);
        continue;
      }
      components.set(getComponentId(compName), sanitizeObject({ ...data }));
    }
    const entity = deps.world.spawn(components);
    deps.scene?.trackEntity(entity);
    spawned.set(entry.id, entity);
    idMap.set(entry.id, `${entity.index}.${entity.generation}`);
  });
  deps.world.flushCommands();

  file.entities.forEach((entry) => {
    if (!entry.parent || !deps.hierarchy) return;
    const child = spawned.get(entry.id);
    const parent = spawned.get(entry.parent);
    if (child && parent) deps.hierarchy.setParent(child, parent);
  });

  return { warnings, idMap, entities: spawned };
}

// ── Diff ──

export interface SceneDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Structural diff between two serialized scenes (entity id + JSON-equal
 *  component data). Used by `editor_diff` and by tests verifying round-trips. */
export function diffScenes(a: DdSceneFile, b: DdSceneFile): SceneDiff {
  const aMap = new Map(a.entities.map((e) => [e.id, e]));
  const bMap = new Map(b.entities.map((e) => [e.id, e]));
  const diff: SceneDiff = { added: [], removed: [], changed: [] };

  bMap.forEach((ent, id) => {
    const prev = aMap.get(id);
    if (!prev) { diff.added.push(id); return; }
    if (JSON.stringify(prev.components) !== JSON.stringify(ent.components)
      || prev.parent !== ent.parent
      || prev.name !== ent.name) {
      diff.changed.push(id);
    }
  });
  aMap.forEach((_, id) => {
    if (!bMap.has(id)) diff.removed.push(id);
  });
  return diff;
}

export function parseDdScene(text: string): DdSceneFile {
  const data = JSON.parse(text) as DdSceneFile;
  if (data.format !== DDSCENE_FORMAT) {
    throw new Error(`Not a .ddscene document (format="${(data as { format?: string }).format}")`);
  }
  return data;
}
