// ============================================================================
// FBX Internal Types — node tree, properties, connections
// ============================================================================
// Shared between the binary parser and the interpreter layer.
// The parser produces FBXNode[]; the interpreter consumes it via the
// connection graph to build ModelData.
//

/** A single FBX property value (the typed data attached to a node). */
export type FBXProperty =
  | { type: "Y"; value: number }
  | { type: "C"; value: boolean }
  | { type: "I"; value: number }
  | { type: "F"; value: number }
  | { type: "D"; value: number }
  | { type: "L"; value: number }
  | { type: "R"; value: Uint8Array }
  | { type: "S"; value: string }
  | { type: "f" | "i" | "d" | "l" | "b"; value: number[]; encoding: number };

/** A node in the FBX binary tree (name + properties + children). */
export interface FBXNode {
  name: string;
  properties: FBXProperty[];
  children: FBXNode[];
}

/** A connection between two FBX objects (from the Connections node). */
export interface FBXConnection {
  /** Connection type: "OO" = Object-Object, "OP" = Object-Property. */
  type: string;
  /** Child object ID. */
  childId: string;
  /** Parent object ID. */
  parentId: string;
  /** Property name for OP connections (e.g. "d|X" for animation curve axis). */
  property?: string;
}

/** FBX binary header magic string. */
export const FBX_HEADER_MAGIC = "Kaydara FBX Binary  \x00";

/** FBX time units per second (46186158000 = int64 of FBX time ticks). */
export const FBX_TIME_FACTOR = 46186158000;

// ── Helper: extract a property value by type ────────────────────────────────

/** Get the first property of a node as a number. */
export function propNumber(node: FBXNode | undefined, index: number): number | undefined {
  if (!node) return undefined;
  const p = node.properties[index];
  if (!p) return undefined;
  if (p.type === "Y" || p.type === "I" || p.type === "F" || p.type === "D" || p.type === "L") {
    return p.value as number;
  }
  return undefined;
}

/** Get the first property of a node as a string. */
export function propString(node: FBXNode | undefined, index: number): string | undefined {
  if (!node) return undefined;
  const p = node.properties[index];
  if (!p) return undefined;
  if (p.type === "S") return p.value as string;
  return undefined;
}

/** Get the first property of a node as a number array. */
export function propArray(node: FBXNode | undefined, index: number): number[] | undefined {
  if (!node) return undefined;
  const p = node.properties[index];
  if (!p) return undefined;
  if (p.type === "f" || p.type === "i" || p.type === "d" || p.type === "l" || p.type === "b") {
    return p.value as number[];
  }
  return undefined;
}

/** Get the first property of a node as raw bytes. */
export function propRaw(node: FBXNode | undefined, index: number): Uint8Array | undefined {
  if (!node) return undefined;
  const p = node.properties[index];
  if (!p) return undefined;
  if (p.type === "R") return p.value as Uint8Array;
  return undefined;
}

/** Find the first child node by name. */
export function childNode(node: FBXNode, name: string): FBXNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** Find all child nodes by name. */
export function childNodes(node: FBXNode, name: string): FBXNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Recursively find all descendant nodes by name (depth-first). */
export function findNodesByName(node: FBXNode, name: string, results: FBXNode[] = [], depth = 0): FBXNode[] {
  if (depth > MAX_NODE_DEPTH) return results;
  if (node.name === name) results.push(node);
  for (let i = 0; i < node.children.length; i++) {
    findNodesByName(node.children[i], name, results, depth + 1);
  }
  return results;
}

/** Recursively find all descendant nodes by name (across multiple root nodes). */
export function findNodesInTree(nodes: FBXNode[], name: string): FBXNode[] {
  const results: FBXNode[] = [];
  for (const node of nodes) {
    findNodesByName(node, name, results);
  }
  return results;
}

// Import MAX_NODE_DEPTH from core to avoid circular deps — re-declare here
// since it's a simple constant.
const MAX_NODE_DEPTH = 256;
