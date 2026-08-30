# Simulation / Module Duplication — Remaining Work

**Updated:** 2026-08-12

## Status

Three of four game systems (fishing, survival, economy) have been migrated to the
module layer. The simulation layer is a thin adapter that extends the module class
and wires game-specific objects into the module's interface-based deps. No further
work needed for those.

**Inventory is the only remaining full duplicate** and needs migration.

---

## Inventory — Needs Migration

### Module version (authoritative)
- **File:** `games/to-the-ocean/modules/inventory/src/inventory.ts` (364 lines)
- **Spec:** `games/to-the-ocean/modules/inventory/src/inventory.spec.ts`
- **Package:** `@to-the-ocean/module-inventory`

Full grid-based inventory: `createGrid`, `cloneGrid`, `addItem`, `removeItem`,
`removeItemById`, `moveItem`, `countItem`, `serializeGrid`, `deserializeGrid`,
`processSpoilage`, `getGridStateForUI`. Registers an ECS `GridInventory` component
and `InventoryModule` with a spoilage system.

### Simulation version (stale duplicate)
- **File:** `games/to-the-ocean/src/simulation/inventory/inventory-system.ts` (271 lines)

A **full duplicate** of the module's inventory functions, not a thin adapter.
Missing features vs. the module version:

| Feature | Module version | Simulation version |
|---|---|---|
| `removeItemById` | Present | **Missing** |
| `canSwapItems` helper | Present — used by `moveItem` for robust swap validation | **Missing** — simpler inline swap |
| `findStackRoot` bounds check | Checks `x < 0 \|\| y < 0 \|\| x >= width \|\| y >= height` | **No bounds check** |
| `processSpoilage` clamping | Clamps `spoilProgress` to `[0, 1]` | **No clamping** |
| `GridInventory` component | Registered via `Component.register` | **Not present** |
| `InventoryModule` | Module with spoilage system | **Not present** |
| Item type imports | Uses `@to-the-ocean/library-items` | Uses `../../shared/data/items` |

### Migration steps
1. Update all imports of `../inventory/inventory-system` to
   `@to-the-ocean/module-inventory`.
2. Replace `createGrid` calls that use sim-specific `InventoryGrid` with the
   module's version (structurally identical, but `ItemStack.spoilProgress` is
   `number` not `number | undefined`).
3. Delete `src/simulation/inventory/inventory-system.ts`.
4. Move the simulation spec to use the module's functions, or keep as an
   integration test that verifies the adapter wiring.

---

## Already Migrated (no action needed)

| System | Sim file | Module file | Status |
|---|---|---|---|
| Fishing | `sim/fishing/fishing-system.ts` (thin adapter) | `libraries/fishing/src/fishing-system.ts` | Migrated — keep module |
| Survival | `sim/survival/survival-system.ts` (thin adapter) | `libraries/survival/src/survival-system.ts` | Migrated — keep module |
| Economy | `sim/economy/market-system.ts` (thin adapter) | `libraries/economy/src/market-system.ts` | Migrated — keep module |
