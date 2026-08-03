import { ItemStack, InventorySlot, ItemDef, StorageType } from "../../shared/types";
import { getItem } from "../../shared/data/items";
import { PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT } from "../../shared/constants";

export interface InventoryGrid {
  width: number;
  height: number;
  slots: (ItemStack | null)[][];
}

export function createGrid(width: number, height: number): InventoryGrid {
  const slots: (ItemStack | null)[][] = [];
  for (let y = 0; y < height; y++) {
    slots.push(new Array(width).fill(null));
  }
  return { width, height, slots };
}

export function cloneGrid(grid: InventoryGrid): InventoryGrid {
  const newGrid = createGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (stack) {
        newGrid.slots[y][x] = { ...stack };
      }
    }
  }
  return newGrid;
}

function canPlaceAt(grid: InventoryGrid, x: number, y: number, w: number, h: number): boolean {
  if (x < 0 || y < 0 || x + w > grid.width || y + h > grid.height) return false;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (grid.slots[y + dy][x + dx] !== null) return false;
    }
  }
  return true;
}

function placeAt(grid: InventoryGrid, x: number, y: number, stack: ItemStack, w: number, h: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      grid.slots[y + dy][x + dx] = stack;
    }
  }
}

function clearAt(grid: InventoryGrid, x: number, y: number, w: number, h: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      grid.slots[y + dy][x + dx] = null;
    }
  }
}

function findStackRoot(grid: InventoryGrid, x: number, y: number): { x: number; y: number; w: number; h: number } | null {
  const stack = grid.slots[y][x];
  if (!stack) return null;
  const def = getItem(stack.itemId);
  if (!def) return null;
  // Find top-left corner by scanning backwards
  let rootX = x;
  let rootY = y;
  // The root is the top-leftmost cell that has the same stack reference
  for (let sy = y; sy >= 0; sy--) {
    for (let sx = x; sx >= 0; sx--) {
      if (grid.slots[sy][sx] === stack) {
        rootX = sx;
        rootY = sy;
      }
    }
  }
  return { x: rootX, y: rootY, w: def.width, h: def.height };
}

export function addItem(grid: InventoryGrid, itemId: string, quantity: number): number {
  const def = getItem(itemId);
  if (!def) return quantity;

  // First, try to stack onto existing stacks
  if (def.maxStack > 1) {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const stack = grid.slots[y][x];
        if (!stack || stack.itemId !== itemId) continue;
        // Only stack onto the root cell (top-left)
        const root = findStackRoot(grid, x, y);
        if (!root || root.x !== x || root.y !== y) continue;
        const space = def.maxStack - stack.quantity;
        if (space <= 0) continue;
        const toAdd = Math.min(space, quantity);
        stack.quantity += toAdd;
        quantity -= toAdd;
        if (quantity <= 0) return 0;
      }
    }
  }

  // Then, try to place new stacks
  while (quantity > 0) {
    const stackSize = Math.min(quantity, def.maxStack);
    let placed = false;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if (canPlaceAt(grid, x, y, def.width, def.height)) {
          const newStack: ItemStack = {
            itemId,
            quantity: stackSize,
            spoilProgress: 0,
          };
          placeAt(grid, x, y, newStack, def.width, def.height);
          quantity -= stackSize;
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) break;
  }

  return quantity;
}

export function removeItem(grid: InventoryGrid, x: number, y: number, quantity: number): { itemId: string; quantity: number } | null {
  const stack = grid.slots[y]?.[x];
  if (!stack) return null;
  const def = getItem(stack.itemId);
  if (!def) return null;

  const root = findStackRoot(grid, x, y);
  if (!root) return null;

  const toRemove = Math.min(quantity, stack.quantity);
  stack.quantity -= toRemove;

  if (stack.quantity <= 0) {
    clearAt(grid, root.x, root.y, def.width, def.height);
  }

  return { itemId: stack.itemId, quantity: toRemove };
}

export function moveItem(grid: InventoryGrid, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const root = findStackRoot(grid, fromX, fromY);
  if (!root) return false;
  const stack = grid.slots[root.y][root.x];
  if (!stack) return false;
  const def = getItem(stack.itemId);
  if (!def) return false;

  // Clear old position
  clearAt(grid, root.x, root.y, def.width, def.height);

  // Check if we can place at new position
  if (canPlaceAt(grid, toX, toY, def.width, def.height)) {
    placeAt(grid, toX, toY, stack, def.width, def.height);
    return true;
  }

  // Can't place — try to swap with whatever is at the target
  const targetRoot = findStackRoot(grid, toX, toY);
  if (targetRoot) {
    const targetStack = grid.slots[targetRoot.y][targetRoot.x];
    if (targetStack) {
      const targetDef = getItem(targetStack.itemId);
      if (targetDef) {
        clearAt(grid, targetRoot.x, targetRoot.y, targetDef.width, targetDef.height);
        if (canPlaceAt(grid, root.x, root.y, targetDef.width, targetDef.height)) {
          placeAt(grid, root.x, root.y, targetStack, targetDef.width, targetDef.height);
          placeAt(grid, toX, toY, stack, def.width, def.height);
          return true;
        }
        // Can't swap — restore both
        placeAt(grid, targetRoot.x, targetRoot.y, targetStack, targetDef.width, targetDef.height);
      }
    }
  }

  // Restore original position
  placeAt(grid, root.x, root.y, stack, def.width, def.height);
  return false;
}

export function countItem(grid: InventoryGrid, itemId: string): number {
  let count = 0;
  const seen = new Set<ItemStack>();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack || stack.itemId !== itemId) continue;
      if (seen.has(stack)) continue;
      seen.add(stack);
      count += stack.quantity;
    }
  }
  return count;
}

export function serializeGrid(grid: InventoryGrid): { x: number; y: number; stack: ItemStack }[] {
  const result: { x: number; y: number; stack: ItemStack }[] = [];
  const seen = new Set<ItemStack>();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack || seen.has(stack)) continue;
      seen.add(stack);
      result.push({ x, y, stack: { ...stack } });
    }
  }
  return result;
}

export function deserializeGrid(data: { x: number; y: number; stack: ItemStack }[], width: number, height: number): InventoryGrid {
  const grid = createGrid(width, height);
  for (const entry of data) {
    const def = getItem(entry.stack.itemId);
    if (!def) continue;
    const stack: ItemStack = { ...entry.stack };
    placeAt(grid, entry.x, entry.y, stack, def.width, def.height);
  }
  return grid;
}

export function processSpoilage(grid: InventoryGrid, dt: number, gameHoursPerSecond: number): void {
  const seen = new Set<ItemStack>();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack) continue;
      if (seen.has(stack)) continue;
      seen.add(stack);
      const def = getItem(stack.itemId);
      if (!def || !def.spoilRate) continue;
      if (stack.spoilProgress === undefined) stack.spoilProgress = 0;
      stack.spoilProgress += def.spoilRate * gameHoursPerSecond * dt;
      if (stack.spoilProgress >= 1) {
        // Spoiled — remove item
        const root = findStackRoot(grid, x, y);
        if (root) {
          clearAt(grid, root.x, root.y, def.width, def.height);
        }
      }
    }
  }
}

export function getGridStateForUI(grid: InventoryGrid): { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[] {
  const result: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[] = [];
  const seen = new Set<ItemStack>();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack || seen.has(stack)) continue;
      seen.add(stack);
      const def = getItem(stack.itemId);
      if (!def) continue;
      result.push({
        x, y,
        itemId: stack.itemId,
        quantity: stack.quantity,
        spoilProgress: stack.spoilProgress ?? 0,
        width: def.width,
        height: def.height,
      });
    }
  }
  return result;
}
