// ============================================================================
// FBX Binary Parser — binary FBX → FBXNode[] tree
// ============================================================================
// Handles FBX binary format versions 6400+ (uint32 headers) and 7500+
// (uint64 headers). Zlib-compressed arrays are decompressed via fflate.
//
// Reference: Babylon.js `parsers/fbxBinaryParser.ts` (292 lines) — similar
// structure but emits Babylon's internal node type. We emit our FBXNode.
//

import { assertFinite, assertPositive, MAX_DECOMPRESS_SIZE } from "@downdraft/engine";
import { decompressSync } from "fflate";
import { FBX_HEADER_MAGIC, type FBXNode, type FBXProperty } from "../types";

/**
 * Parse a binary FBX file into an FBXNode[] tree.
 *
 * @param data The raw FBX binary data.
 * @returns The top-level nodes and the FBX version number.
 */
export function parseFBXBinary(data: ArrayBuffer): { nodes: FBXNode[]; version: number } {
  const view = new DataView(data);
  const headerStr = new TextDecoder().decode(new Uint8Array(data, 0, 21));

  if (!headerStr.startsWith("Kaydara FBX Binary")) {
    throw new Error("Not a binary FBX file (missing Kaydara header)");
  }

  const version = view.getUint32(23, true);
  const nodes: FBXNode[] = [];
  let offset = 27; // 21 (magic) + 2 (unknown) + 4 (version)

  while (offset < data.byteLength) {
    const result = parseFBXNode(view, offset, data.byteLength, version);
    if (result === null) break;
    if (result.node === null) {
      offset = result.nextOffset;
      break;
    }
    nodes.push(result.node);
    offset = result.nextOffset;
  }

  return { nodes, version };
}

/**
 * Parse a single FBX node from the binary stream.
 * Returns null when the stream ends; returns { node: null, nextOffset } for
 * the null-record (end-of-children marker).
 */
function parseFBXNode(
  view: DataView,
  offset: number,
  endOffset: number,
  version: number,
): { node: FBXNode | null; nextOffset: number } | null {
  // FBX 7500+ uses uint64 header fields (8+8+8+1 = 25 bytes)
  // FBX < 7500 uses uint32 header fields (4+4+4+1 = 13 bytes)
  const is64Bit = version >= 7500;
  const headerSize = is64Bit ? 25 : 13;

  if (offset + headerSize > view.byteLength) return null;

  let nodeEndOffset: number;
  let numProperties: number;
  let propertyListLen: number;
  let nameLen: number;

  if (is64Bit) {
    // Read uint64 as two uint32; high 32 bits should be 0 for normal-sized files
    nodeEndOffset = view.getUint32(offset, true);
    numProperties = view.getUint32(offset + 8, true);
    propertyListLen = view.getUint32(offset + 16, true);
    nameLen = view.getUint8(offset + 24);
  } else {
    nodeEndOffset = view.getUint32(offset, true);
    numProperties = view.getUint32(offset + 4, true);
    propertyListLen = view.getUint32(offset + 8, true);
    nameLen = view.getUint8(offset + 12);
  }

  // Null record: all header fields are 0
  if (nodeEndOffset === 0 && numProperties === 0 && propertyListLen === 0 && nameLen === 0) {
    return { node: null, nextOffset: offset + headerSize };
  }
  if (nodeEndOffset > view.byteLength) return null;

  // For nodes with endOffset=0, use parent's endOffset as the boundary
  const effectiveEndOffset = nodeEndOffset === 0 ? endOffset : nodeEndOffset;

  let pos = offset + headerSize + nameLen;
  const name = new TextDecoder().decode(new Uint8Array(view.buffer, pos - nameLen, nameLen));

  const properties: FBXProperty[] = [];
  const propEnd = pos + propertyListLen;

  for (let i = 0; i < numProperties && pos < propEnd; i++) {
    const prop = parseFBXProperty(view, pos);
    if (prop === null) break;
    properties.push(prop.property);
    pos = prop.nextOffset;
  }

  pos = propEnd;

  const children: FBXNode[] = [];
  while (pos < effectiveEndOffset) {
    const child = parseFBXNode(view, pos, effectiveEndOffset, version);
    if (child === null) break;
    if (child.node === null) {
      pos = child.nextOffset;
      break;
    }
    children.push(child.node);
    pos = child.nextOffset;
  }

  return {
    node: { name, properties, children },
    nextOffset: effectiveEndOffset,
  };
}

/** Parse a single FBX property value from the binary stream. */
function parseFBXProperty(
  view: DataView,
  offset: number,
): { property: FBXProperty; nextOffset: number } | null {
  const typeCode = String.fromCharCode(view.getUint8(offset));

  switch (typeCode) {
    case "Y": {
      const value = view.getInt16(offset + 1, true);
      return { property: { type: "Y", value }, nextOffset: offset + 3 };
    }
    case "C": {
      const value = view.getUint8(offset + 1) !== 0;
      return { property: { type: "C", value }, nextOffset: offset + 2 };
    }
    case "I": {
      const value = view.getInt32(offset + 1, true);
      return { property: { type: "I", value }, nextOffset: offset + 5 };
    }
    case "F": {
      const value = view.getFloat32(offset + 1, true);
      return { property: { type: "F", value }, nextOffset: offset + 5 };
    }
    case "D": {
      const value = view.getFloat64(offset + 1, true);
      return { property: { type: "D", value }, nextOffset: offset + 9 };
    }
    case "L": {
      const value = Number(view.getBigInt64(offset + 1, true));
      return { property: { type: "L", value }, nextOffset: offset + 9 };
    }
    case "R": {
      const length = view.getUint32(offset + 1, true);
      const value = new Uint8Array(view.buffer, offset + 5, length);
      return { property: { type: "R", value }, nextOffset: offset + 5 + length };
    }
    case "S": {
      const length = view.getUint32(offset + 1, true);
      const raw = new TextDecoder().decode(
        new Uint8Array(view.buffer, offset + 5, length),
      );
      // FBX strings contain null terminators and \x00\x01 namespace separators.
      // Strip everything from the first null byte onward.
      const nullIdx = raw.indexOf("\x00");
      const value = nullIdx >= 0 ? raw.substring(0, nullIdx) : raw;
      return { property: { type: "S", value }, nextOffset: offset + 5 + length };
    }
    case "f":
    case "i":
    case "d":
    case "l":
    case "b": {
      const arrayLength = view.getUint32(offset + 1, true);
      const encoding = view.getUint32(offset + 5, true);
      const compLength = view.getUint32(offset + 9, true);
      const dataStart = offset + 13;

      assertFinite("fbx arrayLength", arrayLength);
      assertPositive("fbx arrayLength", arrayLength);

      let values: number[];

      if (encoding === 1) {
        if (arrayLength > MAX_DECOMPRESS_SIZE) {
          throw new RangeError(
            `fbx: decompressed array length ${arrayLength} exceeds max ${MAX_DECOMPRESS_SIZE}`,
          );
        }
        const compressed = new Uint8Array(view.buffer, dataStart, compLength);
        const decompressed = decompressSync(compressed);
        values = readFBXArray(decompressed, typeCode, arrayLength);
      } else {
        const view2 = new DataView(view.buffer, dataStart, compLength);
        values = readFBXArrayFromView(view2, typeCode, arrayLength);
      }

      return {
        property: { type: typeCode as "f" | "i" | "d" | "l" | "b", value: values, encoding },
        nextOffset: dataStart + compLength,
      };
    }
    default:
      return null;
  }
}

/** Read a typed array from decompressed bytes. */
function readFBXArray(data: Uint8Array, typeCode: string, count: number): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return readFBXArrayFromView(view, typeCode, count);
}

/** Read a typed array from a DataView (handles both compressed and uncompressed). */
function readFBXArrayFromView(view: DataView, typeCode: string, count: number): number[] {
  const values = new Array<number>(count);
  switch (typeCode) {
    case "f": {
      for (let i = 0; i < count; i++) values[i] = view.getFloat32(i * 4, true);
      break;
    }
    case "i": {
      for (let i = 0; i < count; i++) values[i] = view.getInt32(i * 4, true);
      break;
    }
    case "d": {
      for (let i = 0; i < count; i++) values[i] = view.getFloat64(i * 8, true);
      break;
    }
    case "l": {
      for (let i = 0; i < count; i++) values[i] = Number(view.getBigInt64(i * 8, true));
      break;
    }
    case "b": {
      for (let i = 0; i < count; i++) values[i] = view.getInt32(i * 4, true) !== 0 ? 1 : 0;
      break;
    }
  }
  return values;
}
