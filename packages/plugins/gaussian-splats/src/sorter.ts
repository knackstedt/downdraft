import type { GaussianSplat, GaussianSplatData } from "./parser.ts";

export interface SortResult {
  indices: Uint32Array;
  distances: Float32Array;
}

export function sortSplats(
  data: GaussianSplatData,
  cameraPos: [number, number, number],
): SortResult {
  const count = data.count;
  const distances = new Float32Array(count);
  const indices = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const dx = data.splats[i].position[0] - cameraPos[0];
    const dy = data.splats[i].position[1] - cameraPos[1];
    const dz = data.splats[i].position[2] - cameraPos[2];
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

export function filterByDistance(
  data: GaussianSplatData,
  cameraPos: [number, number, number],
  maxDistance: number,
): Uint32Array {
  const maxDistSq = maxDistance * maxDistance;
  const visible: number[] = [];

  for (let i = 0; i < data.count; i++) {
    const dx = data.splats[i].position[0] - cameraPos[0];
    const dy = data.splats[i].position[1] - cameraPos[1];
    const dz = data.splats[i].position[2] - cameraPos[2];
    if (dx * dx + dy * dy + dz * dz <= maxDistSq) {
      visible.push(i);
    }
  }

  return new Uint32Array(visible);
}
