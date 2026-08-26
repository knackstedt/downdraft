// ============================================================================
// FBX Connection Graph — single source of truth for object connections
// ============================================================================
// FBX is fundamentally a property-graph format. Objects are connected by
// OO (Object-Object) and OP (Object-Property) links. This module builds the
// connection graph ONCE from the Connections node and provides query functions
// that all other interpreters use.
//
// Reference: Babylon.js `interpreter/connections.ts` (356 lines).
//

import type { FBXConnection, FBXNode } from "../types";

/**
 * The FBX connection graph — bidirectional maps for object-id links.
 *
 * Built once from the `Connections` top-level node. All interpreters query
 * this instead of re-parsing connections.
 */
export class FBXConnectionGraph {
  /** childId → parentId (first-wins for duplicates — FBX can have duplicate OO links). */
  private readonly childToParent = new Map<string, string>();
  /** parentId → childIds[] (all children). */
  private readonly parentToChildren = new Map<string, string[]>();
  /** parentId → FBXConnection[] (all connections where this ID is the parent). */
  private readonly parentToConnections = new Map<string, FBXConnection[]>();
  /** childId → FBXConnection[] (all connections where this ID is the child). */
  private readonly childToConnections = new Map<string, FBXConnection[]>();
  /** All connections in order. */
  readonly connections: FBXConnection[] = [];

  constructor(nodes: FBXNode[]) {
    const connectionsNode = nodes.find((n) => n.name === "Connections");
    if (!connectionsNode) return;

    for (const c of connectionsNode.children) {
      if (c.name !== "C" || c.properties.length < 3) continue;
      const type = String(c.properties[0].value);
      const childId = String(c.properties[1].value);
      const parentId = String(c.properties[2].value);
      const property = c.properties.length >= 4 ? String(c.properties[3].value) : undefined;

      const conn: FBXConnection = { type, childId, parentId, property };
      this.connections.push(conn);

      // Build childToParent (first-wins for OO links — a bone may have both
      // a bone→parentBone OO link and a bone→sceneRoot OO link; the first
      // is the correct hierarchy parent).
      if (type === "OO" && !this.childToParent.has(childId)) {
        this.childToParent.set(childId, parentId);
      } else if (type !== "OO") {
        // OP links: last-wins is fine (property connections are unique)
        this.childToParent.set(childId, parentId);
      }

      // Build parentToChildren (all links)
      let children = this.parentToChildren.get(parentId);
      if (!children) {
        children = [];
        this.parentToChildren.set(parentId, children);
      }
      children.push(childId);

      // Build parentToConnections / childToConnections index maps
      let pConns = this.parentToConnections.get(parentId);
      if (!pConns) { pConns = []; this.parentToConnections.set(parentId, pConns); }
      pConns.push(conn);
      let cConns = this.childToConnections.get(childId);
      if (!cConns) { cConns = []; this.childToConnections.set(childId, cConns); }
      cConns.push(conn);
    }
  }

  /** Get the parent object ID for a child (OO hierarchy link). */
  getParent(childId: string): string | undefined {
    return this.childToParent.get(childId);
  }

  /** Get all child object IDs for a parent. */
  getChildren(parentId: string): string[] {
    return this.parentToChildren.get(parentId) ?? [];
  }

  /** Get all connections where the given ID is the child. */
  getConnectionsFromChild(childId: string): FBXConnection[] {
    return this.childToConnections.get(childId) ?? [];
  }

  /** Get all connections where the given ID is the parent. */
  getConnectionsToParent(parentId: string): FBXConnection[] {
    return this.parentToConnections.get(parentId) ?? [];
  }

  /** Get OP (Object-Property) connections to a parent, filtered by property. */
  getPropertyConnections(parentId: string, propertyFilter?: string): FBXConnection[] {
    const conns = this.parentToConnections.get(parentId);
    if (!conns) return [];
    if (propertyFilter === undefined) return conns.filter((c) => c.type === "OP");
    const lower = propertyFilter.toLowerCase();
    return conns.filter(
      (c) => c.type === "OP" && (c.property ?? "").toLowerCase().includes(lower),
    );
  }

  /** Check if a child has a parent in the graph. */
  hasParent(childId: string): boolean {
    return this.childToParent.has(childId);
  }

  /** Get the OO hierarchy parent (only OO links, not OP). */
  getHierarchyParent(childId: string): string | undefined {
    const conns = this.childToConnections.get(childId);
    if (conns) {
      for (const conn of conns) {
        if (conn.type === "OO") return conn.parentId;
      }
    }
    return undefined;
  }
}

/**
 * Build a map of object ID → FBXNode for all objects in the Objects node.
 * Useful for looking up nodes by ID (e.g. when traversing connections).
 */
export function buildObjectIdMap(nodes: FBXNode[]): Map<string, FBXNode> {
  const objectsNode = nodes.find((n) => n.name === "Objects");
  if (!objectsNode) return new Map();

  const map = new Map<string, FBXNode>();
  collectObjects(objectsNode, map);
  return map;
}

/** Recursively collect all objects with an ID property. */
function collectObjects(node: FBXNode, map: Map<string, FBXNode>): void {
  // Most object nodes have their ID as the first property
  if (node.properties.length > 0) {
    const id = String(node.properties[0].value);
    if (!map.has(id)) {
      map.set(id, node);
    }
  }
  for (const child of node.children) {
    collectObjects(child, map);
  }
}

/**
 * Get the object ID from a node (first property).
 * Falls back to a synthetic ID if the node has no properties.
 */
export function getObjectId(node: FBXNode, fallback: string): string {
  return node.properties.length > 0 ? String(node.properties[0].value) : fallback;
}

/**
 * Get the object name from a node (second property, type "S").
 * This is the human-readable name (e.g. "mixamorig:Hips", "Cube").
 */
export function getObjectName(node: FBXNode, fallback: string): string {
  if (node.properties.length >= 2 && node.properties[1].type === "S") {
    return String(node.properties[1].value);
  }
  return fallback;
}
