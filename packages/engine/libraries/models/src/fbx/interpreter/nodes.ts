// ============================================================================
// FBX Node Hierarchy — Model objects → ModelNode[]
// ============================================================================
// Builds the node hierarchy from Model objects and OO connections.
// Applies semantic normalizations:
//   - Strip "Model" suffix from node names (FBX naming quirk)
//   - Normalize Mixamo namespace variant: mixamorig7: → mixamorig:
//
// The parser emits clean node names so downstream code (skeleton-animator,
// animation retargeting) doesn't need to strip FBX naming quirks.
//

import type { ModelNode } from "../../types";
import type { FBXNode } from "../types";
import { childNode, findNodesInTree } from "../types";
import type { FBXConnectionGraph } from "./connections";
import { getObjectId, getObjectName } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";

/**
 * Normalize a node name:
 * - Strip trailing "Model" suffix (FBX Model nodes often have names like
 *   "CubeModel" — the actual object name is "Cube")
 * - Normalize Mixamo namespace variant: mixamorig7: → mixamorig:
 */
export function normalizeNodeName(name: string): string {
  let result = name;
  // Strip "Model" suffix
  if (result.endsWith("Model")) {
    result = result.slice(0, -5);
  }
  // Normalize Mixamo namespace variant
  if (result.startsWith("mixamorig7:")) {
    result = "mixamorig:" + result.substring(11);
  }
  return result;
}

/**
 * Build the ModelNode[] hierarchy from Model objects and connections.
 *
 * Each Model object becomes a ModelNode with translation, rotation, and scale
 * extracted from Properties70. PreRotation and LclRotation are combined into
 * a single rotation quaternion.
 *
 * @param nodes The full FBX node tree.
 * @param graph The connection graph.
 * @param diag Diagnostics collector.
 * @returns The node hierarchy, or undefined if no Model objects.
 */
export function parseNodeHierarchy(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  diag: DiagnosticsCollector,
): ModelNode[] | undefined {
  const modelNodes = findNodesInTree(nodes, "Model");
  if (modelNodes.length === 0) return undefined;

  const result: ModelNode[] = [];
  const idToIndex = new Map<string, number>();

  // First pass: create ModelNode entries for each Model object
  for (let i = 0; i < modelNodes.length; i++) {
    const node = modelNodes[i];
    const id = getObjectId(node, `model_${i}`);
    const rawName = getObjectName(node, `node_${i}`);
    const nodeName = normalizeNodeName(rawName);

    const props = extractNodeProperties(node);

    idToIndex.set(id, i);
    result.push({
      name: nodeName,
      translation: props.translation,
      rotation: props.rotation,
      scale: props.scale,
      nodeIndex: i,
    });
  }

  // Second pass: build children indices using the connection graph
  let matched = 0;
  let unmatched = 0;
  for (let i = 0; i < modelNodes.length; i++) {
    const id = getObjectId(modelNodes[i], `model_${i}`);
    const parentId = graph.getHierarchyParent(id);
    if (parentId && idToIndex.has(parentId)) {
      const parentIdx = idToIndex.get(parentId)!;
      if (!result[parentIdx].children) result[parentIdx].children = [];
      result[parentIdx].children!.push(i);
      matched++;
    } else {
      unmatched++;
      if (unmatched <= 3) {
        diag.debug("nodes", `Node ${i} id=${id} name=${result[i].name}: no hierarchy parent found`);
      }
    }
  }

  diag.debug("nodes", `Hierarchy: ${matched} matched, ${unmatched} unmatched, ${idToIndex.size} model IDs`);

  return result;
}

interface NodeProperties {
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

/** Extract Lcl Translation, Lcl Rotation, PreRotation, and Lcl Scaling from a Model node. */
function extractNodeProperties(node: FBXNode): NodeProperties {
  const props70 = childNode(node, "Properties70");
  if (!props70) return {};

  let translation: [number, number, number] | undefined;
  let lclRotation: [number, number, number, number] | undefined;
  let preRotation: [number, number, number, number] | undefined;
  let scale: [number, number, number] | undefined;

  for (let _i = 0, _it = props70.children, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (p.name !== "P" || p.properties.length < 5) continue;
    const propName = String(p.properties[0].value);

    if (propName === "Lcl Translation") {
      translation = [
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      ];
    } else if (propName === "Lcl Rotation") {
      lclRotation = eulerToQuaternion(
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      );
    } else if (propName === "PreRotation") {
      preRotation = eulerToQuaternion(
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      );
    } else if (propName === "Lcl Scaling") {
      scale = [
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      ];
    }
  }

  // Combine PreRotation * LclRotation
  let rotation: [number, number, number, number] | undefined;
  if (preRotation && lclRotation) {
    rotation = qmul(preRotation, lclRotation);
  } else if (preRotation) {
    rotation = preRotation;
  } else if (lclRotation) {
    rotation = lclRotation;
  }

  return { translation, rotation, scale };
}

/**
 * Convert Euler angles (degrees) to a quaternion.
 * FBX default rotation order is 0 = XYZ (extrinsic).
 * Extrinsic XYZ means: rotate around fixed X, then fixed Y, then fixed Z.
 * This is equivalent to intrinsic ZYX, and the quaternion is q = qz * qy * qx.
 */
function eulerToQuaternion(exDeg: number, eyDeg: number, ezDeg: number): [number, number, number, number] {
  const ex = (exDeg * Math.PI) / 180;
  const ey = (eyDeg * Math.PI) / 180;
  const ez = (ezDeg * Math.PI) / 180;
  const cx = Math.cos(ex / 2), sx = Math.sin(ex / 2);
  const cy = Math.cos(ey / 2), sy = Math.sin(ey / 2);
  const cz = Math.cos(ez / 2), sz = Math.sin(ez / 2);
  // q = qz * qy * qx (extrinsic XYZ = FBX default rotation order 0)
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/** Quaternion multiplication: a * b. */
function qmul(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
