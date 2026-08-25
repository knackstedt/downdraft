// ============================================================================
// Overburden — inventory
//
// A slot-based inventory: a fixed-length array of (InventorySlot | null).
// Slots 0..HOTBAR_SIZE-1 are the hotbar (the in-game bottom bar renders
// exactly those slots). Lives in the sim worker (authoritative). Snapshots
// are sent to the renderer / MCP via RPC.
//
// `add()` respects each item's `maxStack`: it tops up existing same-item
// slots first, then fills empty slots, and returns the count that did NOT
// fit so the caller can drop it on the ground.
// ============================================================================

import { getItemDef } from "./items";
import type { RecipeDef } from "./recipes";

export interface InventorySlot {
  itemId: string;
  count: number;
}

/** Total number of inventory slots (9 columns × 6 rows). */
export const INVENTORY_SIZE = 54;
/** Number of hotbar slots (the first row of the grid). */
export const HOTBAR_SIZE = 9;

/** A serialized inventory snapshot — fixed-length array, null = empty slot. */
export type InventorySnapshot = (InventorySlot | null)[];

/** Legacy snapshot shape (pre-slot-model): a list of {itemId, count}. */
export type LegacyInventorySnapshot = { itemId: string; count: number }[];

export class Inventory {
  private slots: (InventorySlot | null)[] = new Array(INVENTORY_SIZE).fill(null);
  readonly size = INVENTORY_SIZE;
  readonly hotbarSize = HOTBAR_SIZE;

  /** Returns the slot at index i (or null if empty / out of range). */
  slot(i: number): InventorySlot | null {
    return this.slots[i] ?? null;
  }

  /** Returns the hotbar slots (first HOTBAR_SIZE entries). */
  hotbar(): (InventorySlot | null)[] {
    return this.slots.slice(0, HOTBAR_SIZE);
  }

  /** Returns a shallow copy of all slots. */
  allSlots(): (InventorySlot | null)[] {
    return this.slots.slice();
  }

  /** Returns the total count of an item across all slots (0 if absent). */
  count(itemId: string): number {
    let total = 0;
    for (const s of this.slots) {
      if (s && s.itemId === itemId) total += s.count;
    }
    return total;
  }

  /**
   * Add `n` of an item, respecting `maxStack`. Tops up existing same-item
   * slots first, then fills empty slots. Returns the count that did NOT fit
   * (the caller should drop it on the ground).
   */
  add(itemId: string, n: number = 1): number {
    if (n <= 0) return 0;
    const max = getItemDef(itemId)?.maxStack ?? 64;
    let remaining = n;
    // 1) Top up existing same-item slots (hotbar first so pickups prefer the
    //    hotbar row, matching player expectations).
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.itemId === itemId && s.count < max) {
        const room = max - s.count;
        const add = Math.min(room, remaining);
        s.count += add;
        remaining -= add;
      }
    }
    // 2) Fill empty slots (hotbar first).
    for (let i = 0; i < this.size && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const add = Math.min(max, remaining);
        this.slots[i] = { itemId, count: add };
        remaining -= add;
      }
    }
    return remaining;
  }

  /** Remove `n` of an item across slots. Returns true if successful, false if insufficient. */
  remove(itemId: string, n: number = 1): boolean {
    if (n <= 0) return true;
    if (this.count(itemId) < n) return false;
    let remaining = n;
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.itemId === itemId) {
        if (s.count > remaining) {
          s.count -= remaining;
          remaining = 0;
        } else {
          remaining -= s.count;
          this.slots[i] = null;
        }
      }
    }
    return true;
  }

  /** Check if the inventory has all the given ingredients. */
  hasIngredients(ingredients: { itemId: string; count: number }[]): boolean {
    for (const ing of ingredients) {
      if (this.count(ing.itemId) < ing.count) return false;
    }
    return true;
  }

  /**
   * Consume ingredients and add outputs for a recipe. Returns true on success.
   * Output overflow is dropped on the ground via the optional `dropOverflow`
   * callback (the worker passes `spawnDrop` bound to the station/blockhead
   * position); if no callback is given, overflow is silently discarded.
   */
  applyRecipe(recipe: RecipeDef, dropOverflow?: (itemId: string, count: number) => void): boolean {
    if (!this.hasIngredients(recipe.inputs)) return false;
    for (const ing of recipe.inputs) this.remove(ing.itemId, ing.count);
    for (const out of recipe.outputs) {
      const overflow = this.add(out.itemId, out.count);
      if (overflow > 0 && dropOverflow) dropOverflow(out.itemId, overflow);
    }
    return true;
  }

  /** Whether the player can place the block associated with an item. */
  canPlace(itemId: string): boolean {
    const def = getItemDef(itemId);
    if (!def || def.placeBlock === 0) return false;
    return this.count(itemId) > 0;
  }

  /**
   * Move a stack from one slot to another.
   * - If `to` is empty: relocate the stack.
   * - If `to` has the same item and there's room (≤ maxStack): merge, leaving
   *   any remainder in `from`.
   * - If `to` has a different item: swap the two stacks.
   */
  move(from: number, to: number): void {
    if (from === to) return;
    const src = this.slots[from];
    if (!src) return;
    const dst = this.slots[to];
    if (!dst) {
      this.slots[to] = src;
      this.slots[from] = null;
      return;
    }
    if (dst.itemId === src.itemId) {
      const max = getItemDef(src.itemId)?.maxStack ?? 64;
      const room = max - dst.count;
      if (room <= 0) {
        // No room — swap so the player can keep dragging.
        this.swap(from, to);
        return;
      }
      const move = Math.min(room, src.count);
      dst.count += move;
      src.count -= move;
      if (src.count <= 0) this.slots[from] = null;
      return;
    }
    this.swap(from, to);
  }

  /** Swap the contents of two slots. */
  swap(from: number, to: number): void {
    const a = this.slots[from];
    this.slots[from] = this.slots[to];
    this.slots[to] = a;
  }

  /** Serialized snapshot for RPC / UI (fixed-length, null = empty slot). */
  snapshot(): InventorySnapshot {
    return this.slots.map((s) => (s ? { itemId: s.itemId, count: s.count } : null));
  }

  /**
   * Load from a snapshot. Accepts BOTH:
   *  - Legacy shape: `{ itemId, count }[]` (no nulls, variable length) —
   *    re-packed via `add()` so maxStack is respected.
   *  - New shape: `(InventorySlot | null)[]` (fixed-length, null = empty).
   */
  loadSnapshot(data: unknown): void {
    this.slots = new Array(this.size).fill(null);
    if (!Array.isArray(data)) return;
    // Detect legacy shape: every entry is a non-null {itemId, count} object
    // AND the array length is small (≤ size). The new shape always has
    // length === size and may contain nulls.
    const looksLegacy =
      data.length > 0 &&
      data.length <= this.size &&
      (data as unknown[]).every(
        (d) => d !== null && typeof d === "object" && typeof (d as { itemId?: unknown }).itemId === "string" && typeof (d as { count?: unknown }).count === "number",
      );
    if (looksLegacy) {
      for (const d of data as LegacyInventorySnapshot) {
        if (d.count > 0) this.add(d.itemId, d.count);
      }
      return;
    }
    // New shape: copy slot-for-slot.
    for (let i = 0; i < Math.min(data.length, this.size); i++) {
      const s = data[i];
      if (s && typeof s === "object" && typeof (s as { itemId?: unknown }).itemId === "string") {
        this.slots[i] = { itemId: (s as InventorySlot).itemId, count: (s as InventorySlot).count };
      }
    }
  }

  clear(): void {
    this.slots = new Array(this.size).fill(null);
  }
}
