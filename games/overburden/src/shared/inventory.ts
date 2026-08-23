// ============================================================================
// Overburden — inventory
//
// A simple counted inventory: Map<itemId, count>. Lives in the sim worker
// (authoritative). Snapshots are sent to the renderer / MCP via RPC.
// ============================================================================

import { getItemDef } from "./items";
import type { RecipeDef } from "./recipes";

export interface InventorySlot {
  itemId: string;
  count: number;
}

export class Inventory {
  private items = new Map<string, number>();

  /** Returns the count of an item (0 if absent). */
  count(itemId: string): number {
    return this.items.get(itemId) ?? 0;
  }

  /** Add `n` of an item, respecting max stack across the whole inventory (no slot splitting yet). */
  add(itemId: string, n: number = 1): void {
    if (n <= 0) return;
    this.items.set(itemId, this.count(itemId) + n);
  }

  /** Remove `n` of an item. Returns true if successful, false if insufficient. */
  remove(itemId: string, n: number = 1): boolean {
    const have = this.count(itemId);
    if (have < n) return false;
    if (have === n) this.items.delete(itemId);
    else this.items.set(itemId, have - n);
    return true;
  }

  /** Check if the inventory has all the given ingredients. */
  hasIngredients(ingredients: { itemId: string; count: number }[]): boolean {
    for (const ing of ingredients) {
      if (this.count(ing.itemId) < ing.count) return false;
    }
    return true;
  }

  /** Consume ingredients and add outputs for a recipe. Returns true on success. */
  applyRecipe(recipe: RecipeDef): boolean {
    if (!this.hasIngredients(recipe.inputs)) return false;
    for (const ing of recipe.inputs) this.remove(ing.itemId, ing.count);
    for (const out of recipe.outputs) this.add(out.itemId, out.count);
    return true;
  }

  /** Whether the player can place the block associated with an item. */
  canPlace(itemId: string): boolean {
    const def = getItemDef(itemId);
    if (!def || def.placeBlock === 0) return false;
    return this.count(itemId) > 0;
  }

  /** Serialized snapshot for RPC / UI. */
  snapshot(): InventorySlot[] {
    const slots: InventorySlot[] = [];
    for (const [itemId, count] of this.items) {
      if (count > 0) slots.push({ itemId, count });
    }
    slots.sort((a, b) => a.itemId.localeCompare(b.itemId));
    return slots;
  }

  /** Load from a snapshot (used by save/load). */
  loadSnapshot(slots: InventorySlot[]): void {
    this.items.clear();
    for (const s of slots) {
      if (s.count > 0) this.items.set(s.itemId, s.count);
    }
  }

  clear(): void {
    this.items.clear();
  }
}
