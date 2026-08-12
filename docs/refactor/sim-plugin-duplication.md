# Simulation / Plugin Duplication — Remaining Work

**Updated:** 2026-08-12

## Status

Three of four game systems (fishing, survival, economy) have been migrated to the
plugin layer. The simulation layer is a thin adapter that extends the plugin class
and wires game-specific objects into the plugin's interface-based deps. No further
work needed for those.

**Inventory is the only remaining full duplicate** and needs migration.

---

## Inventory — Needs Migration

### Plugin version (authoritative)
- **File:** `games/to-the-ocean/plugins/inventory/src/inventory.ts` (364 lines)
- **Spec:** `games/to-the-ocean/plugins/inventory/src/inventory.spec.ts`
- **Package:** `@to-the-ocean/plugin-inventory`

Full grid-based inventory: `createGrid`, `cloneGrid`, `addItem`, `removeItem`,
`removeItemById`, `moveItem`, `countItem`, `serializeGrid`, `deserializeGrid`,
`processSpoilage`, `getGridStateForUI`. Registers an ECS `GridInventory` component
and `InventoryPlugin` with a spoilage system.

### Simulation version (stale duplicate)
- **File:** `games/to-the-ocean/src/simulation/inventory/inventory-system.ts` (271 lines)

A **full duplicate** of the plugin's inventory functions, not a thin adapter.
Missing features vs. the plugin version:

| Feature | Plugin version | Simulation version |
|---|---|---|
| `removeItemById` | Present | **Missing** |
| `canSwapItems` helper | Present — used by `moveItem` for robust swap validation | **Missing** — simpler inline swap |
| `findStackRoot` bounds check | Checks `x < 0 \|\| y < 0 \|\| x >= width \|\| y >= height` | **No bounds check** |
| `processSpoilage` clamping | Clamps `spoilProgress` to `[0, 1]` | **No clamping** |
| `GridInventory` component | Registered via `Component.register` | **Not present** |
| `InventoryPlugin` | Plugin with spoilage system | **Not present** |
| Item type imports | Uses `@to-the-ocean/library-items` | Uses `../../shared/data/items` |

### Migration steps
1. Update all imports of `../inventory/inventory-system` to
   `@to-the-ocean/plugin-inventory`.
2. Replace `createGrid` calls that use sim-specific `InventoryGrid` with the
   plugin's version (structurally identical, but `ItemStack.spoilProgress` is
   `number` not `number | undefined`).
3. Delete `src/simulation/inventory/inventory-system.ts`.
4. Move the simulation spec to use the plugin's functions, or keep as an
   integration test that verifies the adapter wiring.

---

## Already Migrated (no action needed)

| System | Sim file | Plugin file | Status |
|---|---|---|---|
| Fishing | `sim/fishing/fishing-system.ts` (thin adapter) | `plugins/fishing/src/fishing-system.ts` | Migrated — keep plugin |
| Survival | `sim/survival/survival-system.ts` (thin adapter) | `plugins/survival/src/survival-system.ts` | Migrated — keep plugin |
| Economy | `sim/economy/market-system.ts` (thin adapter) | `plugins/economy/src/market-system.ts` | Migrated — keep plugin |
