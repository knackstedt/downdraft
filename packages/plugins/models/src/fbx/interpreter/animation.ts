// ============================================================================
// FBX Animation Interpreter — AnimationStack/Layer/CurveNode/Curve → AnimationData[]
// ============================================================================
// Walks the FBX animation graph: AnimationStack → AnimationLayer →
// AnimationCurveNode → AnimationCurve. Handles multi-clip (multiple stacks),
// LINEAR/STEP/CUBICSPLINE interpolation, and PreRotation/LclRotation rest
// extraction for retargeting.
//
// Reference: Babylon.js `interpreter/animation.ts` (852 lines).
//

import type { AnimationChannel, AnimationData } from "../../types";
import type { FBXNode } from "../types";
import { childNode, FBX_TIME_FACTOR, findNodesInTree, propArray } from "../types";
import type { FBXConnectionGraph } from "./connections";
import { buildObjectIdMap, getObjectId, getObjectName } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";
import { normalizeNodeName } from "./nodes";

interface FBXAnimCurve {
  id: string;
  keyTime: number[];
  keyValue: number[];
}

interface FBXAnimCurveNode {
  id: string;
  property: string; // "Lcl Translation", "Lcl Rotation", "Lcl Scaling"
  curveIds: string[];
  curveAxes: string[]; // "X", "Y", "Z" per curve
}

interface FBXAnimLayer {
  id: string;
  curveNodeIds: string[];
}

interface FBXAnimStack {
  id: string;
  name: string;
  localStop: number;
  layerIds: string[];
}

/**
 * Parse all animation clips from the FBX tree.
 *
 * Each AnimationStack becomes one AnimationData clip. Multiple stacks produce
 * multiple clips (multi-clip support).
 */
export function parseAnimations(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  diag: DiagnosticsCollector,
): AnimationData[] {
  const objectsNode = nodes.find((n) => n.name === "Objects");
  if (!objectsNode) return [];

  const objectIdMap = buildObjectIdMap(nodes);

  // Parse AnimationCurve nodes
  const curves = new Map<string, FBXAnimCurve>();
  for (const node of findNodesInTree([objectsNode], "AnimationCurve")) {
    const id = getObjectId(node, `curve_${curves.size}`);
    const keyTime = propArray(childNode(node, "KeyTime"), 0) ?? [];
    const keyValue = propArray(childNode(node, "KeyValueFloat"), 0) ?? [];
    curves.set(id, { id, keyTime, keyValue });
  }

  // Parse AnimationCurveNode nodes
  const curveNodes = new Map<string, FBXAnimCurveNode>();
  for (const node of findNodesInTree([objectsNode], "AnimationCurveNode")) {
    const id = getObjectId(node, `curveNode_${curveNodes.size}`);
    let propertyName = "";

    // FBX 7400+: type is encoded in the second property (e.g. "T\x00\x01AnimCurveNode")
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      const typeStr = String(node.properties[1].value);
      if (typeStr.startsWith("T")) propertyName = "Lcl Translation";
      else if (typeStr.startsWith("R")) propertyName = "Lcl Rotation";
      else if (typeStr.startsWith("S")) propertyName = "Lcl Scaling";
    }

    // Fallback: look for PropertyName child (older FBX formats)
    if (!propertyName) {
      const propNode = childNode(node, "PropertyName");
      if (propNode && propNode.properties.length > 0) {
        propertyName = String(propNode.properties[0].value);
      }
    }

    // Find connected curves and extract axis from connection property (e.g. "d|X")
    // Use graph.getChildren() for O(1) lookup instead of scanning all connections
    const connectedCurveIds: string[] = [];
    const connectedCurveAxes: string[] = [];
    for (const childId of graph.getChildren(id)) {
      if (!curves.has(childId)) continue;
      connectedCurveIds.push(childId);
      // Find the connection to get the property (axis info)
      const conn = graph.getConnectionsToParent(id).find((c) => c.childId === childId);
      let axis = "X";
      if (conn?.property) {
        if (conn.property.includes("|Y") || conn.property.endsWith("Y")) axis = "Y";
        else if (conn.property.includes("|Z") || conn.property.endsWith("Z")) axis = "Z";
      }
      connectedCurveAxes.push(axis);
    }

    curveNodes.set(id, { id, property: propertyName, curveIds: connectedCurveIds, curveAxes: connectedCurveAxes });
  }

  // Parse AnimationLayer nodes
  const layers = new Map<string, FBXAnimLayer>();
  for (const node of findNodesInTree([objectsNode], "AnimationLayer")) {
    const id = getObjectId(node, `layer_${layers.size}`);
    const connectedCurveNodeIds: string[] = [];
    for (const childId of graph.getChildren(id)) {
      if (curveNodes.has(childId)) {
        connectedCurveNodeIds.push(childId);
      }
    }
    layers.set(id, { id, curveNodeIds: connectedCurveNodeIds });
  }

  // Parse AnimationStack nodes
  const stacks: FBXAnimStack[] = [];
  for (const node of findNodesInTree([objectsNode], "AnimationStack")) {
    const id = getObjectId(node, `stack_${stacks.length}`);
    let stackName = `animation_${stacks.length}`;
    if (node.properties.length >= 2 && node.properties[1].type === "S") {
      stackName = String(node.properties[1].value);
    }

    let localStop = 0;
    const localStopNode = childNode(node, "LocalStop");
    if (localStopNode && localStopNode.properties.length > 0) {
      localStop = localStopNode.properties[0].value as number;
    }

    const connectedLayerIds: string[] = [];
    for (const childId of graph.getChildren(id)) {
      if (layers.has(childId)) {
        connectedLayerIds.push(childId);
      }
    }

    stacks.push({ id, name: stackName, localStop, layerIds: connectedLayerIds });
  }

  if (stacks.length === 0) return [];

  // Build curve node → model node mapping via connections
  const modelNodes = findNodesInTree([objectsNode], "Model");
  const modelIdToName = new Map<string, string>();
  for (const node of modelNodes) {
    const id = getObjectId(node, `model_${modelIdToName.size}`);
    const rawName = getObjectName(node, `node_${modelIdToName.size}`);
    modelIdToName.set(id, normalizeNodeName(rawName));
  }

  const curveNodeToModel = new Map<string, string>();
  for (const [modelId, modelName] of modelIdToName) {
    for (const childId of graph.getChildren(modelId)) {
      if (curveNodes.has(childId)) {
        curveNodeToModel.set(childId, modelName);
      }
    }
  }

  // Build curve node → deformer mapping for morph weight animations.
  // Morph weight animations connect AnimationCurveNode → Deformer via OP
  // connection with property "DeformPercent".
  const deformerNodes = findNodesInTree([objectsNode], "Deformer");
  const deformerIdToName = new Map<string, string>();
  for (const node of deformerNodes) {
    const id = getObjectId(node, `deformer_${deformerIdToName.size}`);
    // Use the deformer's name property if available, otherwise use a generic name
    const name = getObjectName(node, `deformer_${deformerIdToName.size}`);
    deformerIdToName.set(id, name);
  }

  const curveNodeToDeformer = new Map<string, string>();
  for (const [deformerId, deformerName] of deformerIdToName) {
    for (const childId of graph.getChildren(deformerId)) {
      if (curveNodes.has(childId)) {
        curveNodeToDeformer.set(childId, deformerName);
      }
    }
  }

  // Extract source rest rotations and pre-rotations for retargeting
  const sourceRestRotations = new Map<string, [number, number, number, number]>();
  const sourcePreRotations = new Map<string, [number, number, number, number]>();
  for (const node of modelNodes) {
    const id = getObjectId(node, `model_${sourceRestRotations.size}`);
    const rawName = getObjectName(node, `node_${sourceRestRotations.size}`);
    const modelName = normalizeNodeName(rawName);

    const props70 = childNode(node, "Properties70");
    if (!props70) continue;

    let preRot: [number, number, number, number] | null = null;
    let lclRot: [number, number, number, number] | null = null;

    for (const p of props70.children) {
      if (p.name !== "P" || p.properties.length < 7) continue;
      const propName = String(p.properties[0].value);
      if (propName === "Lcl Rotation" || propName === "PreRotation") {
        const q = eulerToQuaternion(
          p.properties[4].value as number,
          p.properties[5].value as number,
          p.properties[6].value as number,
        );
        if (propName === "PreRotation") preRot = q;
        else lclRot = q;
      }
    }

    if (preRot) sourcePreRotations.set(modelName, preRot);
    if (lclRot && preRot) {
      sourceRestRotations.set(modelName, qmul(preRot, lclRot));
    } else if (lclRot) {
      sourceRestRotations.set(modelName, lclRot);
    } else if (preRot) {
      sourceRestRotations.set(modelName, preRot);
    }
  }

  diag.debug("animation", `Extracted ${sourceRestRotations.size} source rest rotations`);

  // Build AnimationData for each stack
  const animations: AnimationData[] = [];

  for (const stack of stacks) {
    const channels: AnimationChannel[] = [];
    let maxTime = 0;

    // Group curve nodes by target model + property type
    const groupedChannels = new Map<string, {
      targetNode: string;
      path: "translation" | "rotation" | "scale" | "weights";
      curves: { axis: string; times: number[]; values: number[] }[];
    }>();

    for (const layerId of stack.layerIds) {
      const layer = layers.get(layerId);
      if (!layer) continue;

      for (const curveNodeId of layer.curveNodeIds) {
        const curveNode = curveNodes.get(curveNodeId);
        if (!curveNode) continue;

        // Check if this curve node targets a Model (TRS) or a Deformer (morph weights)
        const targetNode = curveNodeToModel.get(curveNode.id);
        const targetDeformer = curveNodeToDeformer.get(curveNode.id);

        if (!targetNode && !targetDeformer) continue;

        // Determine path from property name
        let path: "translation" | "rotation" | "scale" | "weights" = "translation";
        const propLower = curveNode.property.toLowerCase();
        if (targetDeformer || propLower.includes("deformpercent") || propLower.includes("weight")) {
          path = "weights";
        } else if (propLower.includes("lcl translation") || propLower.includes("translation")) {
          path = "translation";
        } else if (propLower.includes("lcl rotation") || propLower.includes("rotation")) {
          path = "rotation";
        } else if (propLower.includes("lcl scaling") || propLower.includes("scaling") || propLower.includes("scale")) {
          path = "scale";
        }

        const target = targetNode ?? targetDeformer!;

        if (curveNode.curveIds.length === 0) continue;

        const groupKey = `${target}:${path}`;
        let group = groupedChannels.get(groupKey);
        if (!group) {
          group = { targetNode: target, path, curves: [] };
          groupedChannels.set(groupKey, group);
        }

        for (let ci = 0; ci < curveNode.curveIds.length; ci++) {
          const curve = curves.get(curveNode.curveIds[ci]);
          if (!curve || curve.keyTime.length === 0) continue;

          const times: number[] = [];
          for (let t = 0; t < curve.keyTime.length; t++) {
            const timeSec = curve.keyTime[t] / FBX_TIME_FACTOR;
            times.push(timeSec);
            if (timeSec > maxTime) maxTime = timeSec;
          }

          const axis = curveNode.curveAxes[ci] || "X";
          group.curves.push({ axis, times, values: curve.keyValue });
        }
      }
    }

    // Build channels from grouped curves
    for (const group of groupedChannels.values()) {
      const channel = buildChannel(group, maxTime);
      if (channel) channels.push(channel);
    }

    if (channels.length === 0) continue;

    animations.push({
      name: stack.name,
      duration: maxTime,
      channels,
      sourceRestRotations: sourceRestRotations.size > 0 ? sourceRestRotations : undefined,
      sourcePreRotations: sourcePreRotations.size > 0 ? sourcePreRotations : undefined,
    });
  }

  diag.debug("animation", `Parsed ${animations.length} animation clips`);

  return animations;
}

/** Build an AnimationChannel from grouped axis curves. */
function buildChannel(
  group: { targetNode: string; path: "translation" | "rotation" | "scale" | "weights"; curves: { axis: string; times: number[]; values: number[] }[] },
  maxTime: number,
): AnimationChannel | null {
  if (group.curves.length === 0) return null;

  // Sort curves by axis: X, Y, Z
  const sortedCurves = [...group.curves].sort((a, b) => {
    const order = { X: 0, Y: 1, Z: 2 };
    return (order[a.axis as "X" | "Y" | "Z"] ?? 3) - (order[b.axis as "X" | "Y" | "Z"] ?? 3);
  });

  // Use the first curve's times as the channel times
  // (FBX curves for the same channel should have matching key times)
  const times = sortedCurves[0].times;
  const valueCount = times.length;

  // For weights path, use single value per keyframe (not 3-axis interleaved)
  if (group.path === "weights") {
    const values = new Float32Array(valueCount);
    for (let i = 0; i < valueCount; i++) {
      values[i] = sortedCurves[0].values[i] ?? 0;
    }
    return {
      targetNode: group.targetNode,
      path: "weights",
      keyframeTimes: new Float32Array(times),
      keyframeValues: values,
      interpolation: "LINEAR",
    };
  }

  // Interleave values: [x0, y0, z0, x1, y1, z1, ...]
  const values = new Float32Array(valueCount * 3);
  for (let i = 0; i < valueCount; i++) {
    for (let c = 0; c < sortedCurves.length && c < 3; c++) {
      const curve = sortedCurves[c];
      values[i * 3 + c] = curve.values[i] ?? 0;
    }
  }

  // Determine interpolation — default to LINEAR
  // (CUBICSPLINE detection would require checking the curve's tangent data)
  const interpolation: "LINEAR" | "STEP" | "CUBICSPLINE" = "LINEAR";

  return {
    targetNode: group.targetNode,
    path: group.path,
    keyframeTimes: new Float32Array(times),
    keyframeValues: values,
    interpolation,
  };
}

/** Convert Euler angles (degrees) to a quaternion (FBX default: XYZ extrinsic = ZYX intrinsic). */
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
