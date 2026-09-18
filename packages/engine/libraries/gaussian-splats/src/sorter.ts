import type { GaussianSplatData } from "./parser";

export interface SortResult {
  indices: Uint32Array;
  distances: Float32Array;
}

/**
 * CPU depth sort (back-to-front) for splats. Used as a fallback for small
 * splat counts (below `GpuSplatSorter`'s threshold) and in tests.
 *
 * Returns indices sorted so that `indices[0]` is the FARTHEST splat from the
 * camera (back-to-front order for alpha blending).
 */
export function sortSplats(
  data: GaussianSplatData,
  cameraPos: [number, number, number],
): SortResult {
  const count = data.count;
  const distances = new Float32Array(count);
  const indices = new Uint32Array(count);

  const pos = data.position;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const dx = pos[i3] - cameraPos[0];
    const dy = pos[i3 + 1] - cameraPos[1];
    const dz = pos[i3 + 2] - cameraPos[2];
    distances[i] = dx * dx + dy * dy + dz * dz;
    indices[i] = i;
  }

  indexSort(indices, distances);

  return { indices, distances };
}

function indexSort(indices: Uint32Array, distances: Float32Array): void {
  const count = indices.length;
  if (count <= 1) return;

  const tempIndices = new Uint32Array(count);
  mergeSort(indices, tempIndices, distances, 0, count - 1);
}

function mergeSort(
  indices: Uint32Array,
  temp: Uint32Array,
  distances: Float32Array,
  left: number,
  right: number,
): void {
  if (left >= right) return;
  const mid = Math.floor((left + right) / 2);
  mergeSort(indices, temp, distances, left, mid);
  mergeSort(indices, temp, distances, mid + 1, right);
  merge(indices, temp, distances, left, mid, right);
}

function merge(
  indices: Uint32Array,
  temp: Uint32Array,
  distances: Float32Array,
  left: number,
  mid: number,
  right: number,
): void {
  for (let i = left; i <= right; i++) temp[i] = indices[i];

  let i = left;
  let j = mid + 1;
  let k = left;

  while (i <= mid && j <= right) {
    if (distances[temp[i]] <= distances[temp[j]]) {
      indices[k++] = temp[i++];
    } else {
      indices[k++] = temp[j++];
    }
  }

  while (i <= mid) indices[k++] = temp[i++];
  while (j <= right) indices[k++] = temp[j++];
}

/**
 * Filter splats within `maxDistance` from `cameraPos`. Returns the indices of
 * visible splats (unsorted — pair with `sortSplats` if sorted order is needed).
 */
export function filterByDistance(
  data: GaussianSplatData,
  cameraPos: [number, number, number],
  maxDistance: number,
): Uint32Array {
  const maxDistSq = maxDistance * maxDistance;
  const visible: number[] = [];
  const pos = data.position;

  for (let i = 0; i < data.count; i++) {
    const i3 = i * 3;
    const dx = pos[i3] - cameraPos[0];
    const dy = pos[i3 + 1] - cameraPos[1];
    const dz = pos[i3 + 2] - cameraPos[2];
    if (dx * dx + dy * dy + dz * dz <= maxDistSq) {
      visible.push(i);
    }
  }

  return new Uint32Array(visible);
}
