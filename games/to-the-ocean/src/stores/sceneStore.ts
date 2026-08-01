// ============================================================================
// Scene Store — Zustand store for the 3D world scene graph
// Tracks sim entities (read-only) and imported models (editable)
// ============================================================================

import { EntityType } from "@shared/types";
import { create } from "zustand";
import type { ModelData } from "../engine/ModelLoader";

import { type GizmoMode } from "@downdraft/plugin-devtools";

export type { GizmoMode } from "@downdraft/plugin-devtools";

export interface SceneNode {
  id: string;
  name: string;
  type: "entity" | "model";
  entityType?: EntityType;
  visible: boolean;
  locked: boolean;
  // Transform
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion [x, y, z, w]
  scale: [number, number, number];
  // Hierarchy
  children: string[];
  parentId: string | null;
  // For model nodes
  modelData?: ModelData;
  modelFormat?: string;
  // Metadata
  createdAt: number;
}

interface SceneStoreState {
  // All nodes keyed by id
  nodes: Record<string, SceneNode>;
  // Root-level node IDs
  rootIds: string[];
  // Currently selected node ID
  selectedId: string | null;
  // Gizmo mode
  gizmoMode: GizmoMode;
  // Whether gizmo is visible (controlled by DevTools panel)
  gizmoVisible: boolean;
  // Whether dev labels are visible (controlled by DevTools panel)
  showLabels: boolean;
  // Version counter for change detection
  version: number;

  // Actions
  addModel: (modelData: ModelData, name: string, position?: [number, number, number]) => string;
  duplicateNode: (id: string) => string | null;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  updateNodeTransform: (id: string, transform: Partial<Pick<SceneNode, "position" | "rotation" | "scale">>) => void;
  updateNodeProperty: (id: string, key: keyof SceneNode, value: any) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  setGizmoVisible: (visible: boolean) => void;
  setShowLabels: (visible: boolean) => void;
  syncSimEntities: (entities: SimEntitySnapshot[]) => void;
  getSceneTree: () => SceneTreeSnapshot;
  getNode: (id: string) => SceneNode | null;
}

export interface SimEntitySnapshot {
  id: number;
  type: EntityType;
  typeName: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: number;
}

export interface SceneTreeSnapshot {
  nodes: {
    id: string;
    name: string;
    type: "entity" | "model";
    entityType?: number;
    visible: boolean;
    locked: boolean;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    children: string[];
    parentId: string | null;
    modelFormat?: string;
  }[];
  selectedId: string | null;
  gizmoMode: GizmoMode;
  gizmoVisible: boolean;
  showLabels: boolean;
  version: number;
}

let modelIdCounter = 0;

export const useSceneStore = create<SceneStoreState>((set, get) => ({
  nodes: {},
  rootIds: [],
  selectedId: null,
  gizmoMode: "translate",
  gizmoVisible: false,
  showLabels: false,
  version: 0,

  addModel: (modelData, name, position = [0, 0, 0]) => {
    const id = `model-${++modelIdCounter}`;
    const node: SceneNode = {
      id,
      name,
      type: "model",
      visible: true,
      locked: false,
      position: [...position] as [number, number, number],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      children: [],
      parentId: null,
      modelData,
      modelFormat: modelData.format,
      createdAt: Date.now(),
    };

    set((s) => ({
      nodes: { ...s.nodes, [id]: node },
      rootIds: [...s.rootIds, id],
      selectedId: id,
      gizmoVisible: true,
      version: s.version + 1,
    }));

    return id;
  },

  duplicateNode: (id) => {
    const state = get();
    const original = state.nodes[id];
    if (!original || original.type !== "model" || !original.modelData) return null;

    const newId = `model-${++modelIdCounter}`;
    const offset = 2;
    const node: SceneNode = {
      id: newId,
      name: `${original.name} (copy)`,
      type: "model",
      visible: original.visible,
      locked: false,
      position: [
        original.position[0] + offset,
        original.position[1],
        original.position[2] + offset,
      ] as [number, number, number],
      rotation: [...original.rotation] as [number, number, number, number],
      scale: [...original.scale] as [number, number, number],
      children: [],
      parentId: null,
      modelData: original.modelData,
      modelFormat: original.modelFormat,
      createdAt: Date.now(),
    };

    set((s) => ({
      nodes: { ...s.nodes, [newId]: node },
      rootIds: [...s.rootIds, newId],
      selectedId: newId,
      version: s.version + 1,
    }));

    return newId;
  },

  removeNode: (id) => {
    set((s) => {
      const nodes = { ...s.nodes };
      delete nodes[id];
      return {
        nodes,
        rootIds: s.rootIds.filter((rid) => rid !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        version: s.version + 1,
      };
    });
  },

  selectNode: (id) => {
    set((s) => ({
      selectedId: id,
      gizmoVisible: id !== null,
      version: s.version + 1,
    }));
  },

  updateNodeTransform: (id, transform) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      return {
        nodes: {
          ...s.nodes,
          [id]: {
            ...node,
            ...(transform.position ? { position: [...transform.position] as [number, number, number] } : {}),
            ...(transform.rotation ? { rotation: [...transform.rotation] as [number, number, number, number] } : {}),
            ...(transform.scale ? { scale: [...transform.scale] as [number, number, number] } : {}),
          },
        },
        version: s.version + 1,
      };
    });
  },

  updateNodeProperty: (id, key, value) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      return {
        nodes: { ...s.nodes, [id]: { ...node, [key]: value } },
        version: s.version + 1,
      };
    });
  },

  setGizmoMode: (mode) => {
    set((s) => ({ gizmoMode: mode, version: s.version + 1 }));
  },

  setGizmoVisible: (visible) => {
    set((s) => ({ gizmoVisible: visible, version: s.version + 1 }));
  },

  setShowLabels: (visible) => {
    set((s) => ({ showLabels: visible, version: s.version + 1 }));
  },

  syncSimEntities: (entities) => {
    set((s) => {
      const nodes = { ...s.nodes };
      const newRootIds: string[] = [];
      const existingEntityIds = new Set<string>();

      for (const ent of entities) {
        const id = `entity-${ent.id}`;
        existingEntityIds.add(id);
        const existing = nodes[id];
        if (existing) {
          // Update transform only (sim controls these)
          nodes[id] = {
            ...existing,
            position: ent.position,
            rotation: ent.rotation,
            scale: [ent.scale, ent.scale, ent.scale],
            entityType: ent.type,
          };
        } else {
          nodes[id] = {
            id,
            name: `${ent.typeName} #${ent.id}`,
            type: "entity",
            entityType: ent.type,
            visible: true,
            locked: true, // Sim entities are locked by default
            position: ent.position,
            rotation: ent.rotation,
            scale: [ent.scale, ent.scale, ent.scale],
            children: [],
            parentId: null,
            createdAt: Date.now(),
          };
        }
        newRootIds.push(id);
      }

      // Remove stale entity nodes
      for (const key of Object.keys(nodes)) {
        if (key.startsWith("entity-") && !existingEntityIds.has(key)) {
          delete nodes[key];
        }
      }

      // Keep model nodes in rootIds
      for (const rid of s.rootIds) {
        if (!rid.startsWith("entity-") && !newRootIds.includes(rid)) {
          newRootIds.push(rid);
        }
      }

      return { nodes, rootIds: newRootIds, version: s.version + 1 };
    });
  },

  getSceneTree: () => {
    const s = get();
    return {
      nodes: Object.values(s.nodes).map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        entityType: n.entityType,
        visible: n.visible,
        locked: n.locked,
        position: n.position,
        rotation: n.rotation,
        scale: n.scale,
        children: n.children,
        parentId: n.parentId,
        modelFormat: n.modelFormat,
      })),
      selectedId: s.selectedId,
      gizmoMode: s.gizmoMode,
      gizmoVisible: s.gizmoVisible,
      showLabels: s.showLabels,
      version: s.version,
    };
  },

  getNode: (id) => {
    return get().nodes[id] ?? null;
  },
}));
