// ============================================================================
// Overburden — tree felling
//
// When a player mines a wood block on a tree, the entire tree is cut down:
// all connected wood + leaf blocks (in the background plane) are removed,
// plus any vine blocks that were climbing the tree.
//
// Tree grouping uses a per-tree tag stored in the upper 8 bits of the
// background Uint16Array value (bits 8-15). The tag is assigned at terrain
// generation time from the trunk base world coords. The flood-fill only
// crosses into cells that are tree blocks AND have the same tag, so
// neighboring trees with touching canopies are NOT felled together.
//
// Vines climbing the tree are also tagged with the same tree tag at gen
// time, so they're removed when the tree is felled.
//
// Edge case: if the mined wood block has tag 0 (old save before tagging),
// the flood-fill falls back to crossing any tree block regardless of tag.
// This preserves backward compatibility but may fell connected old trees.
// ============================================================================

import { getTreeTag, isTreeBlock, isVineBlock } from "../shared/tree-species";

export interface FellCell {
  x: number;
  y: number;
  blockId: number; // lower 8 bits
}

/**
 * Find all blocks that belong to the tree containing the wood block at
 * (startX, startY) in the background plane. Returns the list of cells to
 * remove (tree blocks + climbing vines).
 *
 * @param bg    active background plane (Uint16Array, W * H cells)
 * @param W     grid width
 * @param H     grid height
 * @param startX  X of the mined wood block
 * @param startY  Y of the mined wood block
 * @returns list of { x, y, blockId } cells to remove (includes the mined block)
 */
export function fellTree(
  bg: Uint16Array,
  W: number,
  H: number,
  startX: number,
  startY: number,
): FellCell[] {
  const treeCells: FellCell[] = [];
  const visited = new Uint8Array(W * H);
  const queue: number[] = []; // packed (y * W + x)
  const vineSet = new Set<number>(); // packed indices of candidate vines

  // Seed: the mined wood block
  const startIdx = startY * W + startX;
  if (!isTreeBlock(bg[startIdx])) return [];
  const targetTag = getTreeTag(bg[startIdx]);
  visited[startIdx] = 1;
  queue.push(startIdx);

  // A neighbor qualifies for the flood if it's a tree block with the same
  // tag (or if the source tag is 0 — backward compat: cross any tree block).
  const tagMatches = (packed: number): boolean => {
    if (targetTag === 0) return true; // untagged: old-save fallback
    return getTreeTag(packed) === targetTag;
  };

  // Phase 1: flood-fill through tree blocks (wood + leaves) with matching tag
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % W;
    const y = (idx / W) | 0;
    const packed = bg[idx];
    treeCells.push({ x, y, blockId: packed & 0xFF });

    // 4-neighbor: up, down, left, right
    // Up (y - 1): toward canopy
    if (y > 0) {
      const nIdx = idx - W;
      if (!visited[nIdx]) {
        const nPacked = bg[nIdx];
        if (isTreeBlock(nPacked) && tagMatches(nPacked)) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        } else if (isVineBlock(nPacked) && tagMatches(nPacked)) {
          vineSet.add(nIdx);
        }
      }
    }
    // Down (y + 1): toward trunk base
    if (y < H - 1) {
      const nIdx = idx + W;
      if (!visited[nIdx]) {
        const nPacked = bg[nIdx];
        if (isTreeBlock(nPacked) && tagMatches(nPacked)) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        } else if (isVineBlock(nPacked) && tagMatches(nPacked)) {
          vineSet.add(nIdx);
        }
      }
    }
    // Left (x - 1)
    if (x > 0) {
      const nIdx = idx - 1;
      if (!visited[nIdx]) {
        const nPacked = bg[nIdx];
        if (isTreeBlock(nPacked) && tagMatches(nPacked)) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        } else if (isVineBlock(nPacked) && tagMatches(nPacked)) {
          vineSet.add(nIdx);
        }
      }
    }
    // Right (x + 1)
    if (x < W - 1) {
      const nIdx = idx + 1;
      if (!visited[nIdx]) {
        const nPacked = bg[nIdx];
        if (isTreeBlock(nPacked) && tagMatches(nPacked)) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        } else if (isVineBlock(nPacked) && tagMatches(nPacked)) {
          vineSet.add(nIdx);
        }
      }
    }
  }

  // Phase 2: collect vine blocks that are 4-adjacent to a removed tree
  // block and have the same tree tag. These vines were climbing the tree
  // and lose their support.
  const vineCells: FellCell[] = [];
  for (const idx of vineSet) {
    if (visited[idx]) continue;
    const packed = bg[idx];
    if (!isVineBlock(packed & 0xFF)) continue;
    visited[idx] = 1;
    vineCells.push({ x: idx % W, y: (idx / W) | 0, blockId: packed & 0xFF });
  }

  return [...treeCells, ...vineCells];
}
