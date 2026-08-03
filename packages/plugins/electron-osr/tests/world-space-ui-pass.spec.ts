// ============================================================================
// WorldSpaceUIPass Tests — Instance packing and texture grouping
// ============================================================================

import { describe, it, expect } from "bun:test";
import type { WorldSpaceUIElement } from "../src/types.ts";

// Test the instance sorting and grouping logic without GPU device
// (GPU-dependent tests would need a real WebGPU device)

describe("WorldSpaceUIPass logic", () => {
  // Helper: sort elements by textureIndex (same logic as WorldSpaceUIPass.execute)
  function sortByTextureIndex(elements: WorldSpaceUIElement[]): WorldSpaceUIElement[] {
    return [...elements].sort((a, b) => a.textureIndex - b.textureIndex);
  }

  // Helper: group sorted elements by textureIndex (same logic as WorldSpaceUIPass.execute)
  function groupByTextureIndex(sorted: WorldSpaceUIElement[]): { texIdx: number; count: number; firstInstance: number }[] {
    if (sorted.length === 0) return [];
    const groups: { texIdx: number; count: number; firstInstance: number }[] = [];
    let currentTexIdx = sorted[0].textureIndex;
    let groupCount = 0;
    let firstInstance = 0;

    for (let i = 0; i <= sorted.length; i++) {
      const texIdx = i < sorted.length ? sorted[i].textureIndex : -1;
      if (texIdx !== currentTexIdx) {
        groups.push({ texIdx: currentTexIdx, count: groupCount, firstInstance });
        firstInstance += groupCount;
        groupCount = 0;
        currentTexIdx = texIdx;
      }
      groupCount++;
    }
    return groups;
  }

  it("should sort elements by textureIndex", () => {
    const elements: WorldSpaceUIElement[] = [
      { id: "a", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 2, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "b", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 0, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "c", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 1, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "d", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 0, uvOffset: [0, 0], uvScale: [1, 1] },
    ];
    const sorted = sortByTextureIndex(elements);
    expect(sorted[0].textureIndex).toBe(0);
    expect(sorted[1].textureIndex).toBe(0);
    expect(sorted[2].textureIndex).toBe(1);
    expect(sorted[3].textureIndex).toBe(2);
  });

  it("should group sorted elements by textureIndex with correct counts", () => {
    const elements: WorldSpaceUIElement[] = [
      { id: "a", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 0, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "b", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 0, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "c", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 1, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "d", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 1, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "e", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 1, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "f", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 2, uvOffset: [0, 0], uvScale: [1, 1] },
    ];
    const sorted = sortByTextureIndex(elements);
    const groups = groupByTextureIndex(sorted);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({ texIdx: 0, count: 2, firstInstance: 0 });
    expect(groups[1]).toEqual({ texIdx: 1, count: 3, firstInstance: 2 });
    expect(groups[2]).toEqual({ texIdx: 2, count: 1, firstInstance: 5 });
  });

  it("should handle single element", () => {
    const elements: WorldSpaceUIElement[] = [
      { id: "a", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 0, uvOffset: [0, 0], uvScale: [1, 1] },
    ];
    const sorted = sortByTextureIndex(elements);
    const groups = groupByTextureIndex(sorted);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ texIdx: 0, count: 1, firstInstance: 0 });
  });

  it("should handle empty array", () => {
    const sorted = sortByTextureIndex([]);
    const groups = groupByTextureIndex(sorted);
    expect(groups).toHaveLength(0);
  });

  it("should handle all same textureIndex", () => {
    const elements: WorldSpaceUIElement[] = [
      { id: "a", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 5, uvOffset: [0, 0], uvScale: [1, 1] },
      { id: "b", position: [0, 0, 0], size: [1, 1], billboardMode: 0, textureIndex: 5, uvOffset: [0, 0], uvScale: [1, 1] },
    ];
    const sorted = sortByTextureIndex(elements);
    const groups = groupByTextureIndex(sorted);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ texIdx: 5, count: 2, firstInstance: 0 });
  });
});
