import { getItem } from "@shared/data/items";
import { RECIPES, Recipe } from "@shared/data/recipes";
import { PLR, SimBufferReader } from "@downdraft/core";
import { ItemCategory } from "@shared/types";
import React from "react";
import { useGameStore } from "../stores/game-store";

type TabId = "crafting" | "inventory" | "character";

interface EquipSlot {
  key: string;
  label: string;
  icon: string;
  categories: ItemCategory[];
}

const EQUIP_SLOTS: EquipSlot[] = [
  { key: "rod", label: "Fishing Rod", icon: "🎣", categories: [ItemCategory.Equipment] },
  { key: "weapon", label: "Weapon", icon: "⚔️", categories: [ItemCategory.Weapon] },
  { key: "armor", label: "Armor", icon: "🛡️", categories: [ItemCategory.Armor] },
  { key: "accessory", label: "Accessory", icon: "💎", categories: [ItemCategory.Equipment, ItemCategory.Treasure] },
];

const CATEGORY_LABELS: Record<string, string> = {
  [ItemCategory.Fish]: "Fish",
  [ItemCategory.Junk]: "Junk",
  [ItemCategory.Material]: "Materials",
  [ItemCategory.Equipment]: "Equipment",
  [ItemCategory.Placeable]: "Placeables",
  [ItemCategory.Consumable]: "Consumables",
  [ItemCategory.Seed]: "Seeds",
  [ItemCategory.Bait]: "Bait",
  [ItemCategory.Treasure]: "Treasure",
  [ItemCategory.Tool]: "Tools",
  [ItemCategory.Weapon]: "Weapons",
  [ItemCategory.Armor]: "Armor",
  [ItemCategory.Cosmetic]: "Cosmetics",
};

interface InvSlot {
  itemId: string;
  quantity: number;
}

function countItem(inventory: InvSlot[], itemId: string): number {
  return inventory
    .filter((s) => s.itemId === itemId)
    .reduce((sum, s) => sum + s.quantity, 0);
}

function canCraft(recipe: Recipe, inventory: InvSlot[]): boolean {
  return recipe.inputs.every(
    (input) => countItem(inventory, input.itemId) >= input.quantity,
  );
}

interface QueueEntry {
  recipe: Recipe;
  uid: number;
}

let queueUid = 0;

export default function CraftMenu() {
  const toggle = useGameStore((s) => s.toggleCraftMenu);
  const [activeTab, setActiveTab] = React.useState<TabId>("crafting");
  const [selectedRecipe, setSelectedRecipe] = React.useState<Recipe | null>(
    RECIPES[0] ?? null,
  );

  // Mock inventory — in a real implementation this would read from the sim buffer
  const [inventory, setInventory] = React.useState<InvSlot[]>([
    { itemId: "wood", quantity: 20 },
    { itemId: "cloth", quantity: 5 },
    { itemId: "rope", quantity: 3 },
    { itemId: "metal_scrap", quantity: 8 },
    { itemId: "raw_fish", quantity: 4 },
    { itemId: "plastic", quantity: 6 },
    { itemId: "basic_rod", quantity: 1 },
    { itemId: "reinforced_rod", quantity: 1 },
    { itemId: "cooked_fish", quantity: 3 },
    { itemId: "coconut", quantity: 2 },
    { itemId: "fresh_water", quantity: 5 },
    { itemId: "pearl", quantity: 1 },
  ]);

  const [craftQueue, setCraftQueue] = React.useState<QueueEntry[]>([]);
  const [craftProgress, setCraftProgress] = React.useState(0);
  const [craftCount, setCraftCount] = React.useState(1);
  const rafRef = React.useRef<number | null>(null);
  const inventoryRef = React.useRef(inventory);
  inventoryRef.current = inventory;

  const currentCraft = craftQueue[0]?.recipe ?? null;

  const addToQueue = (recipe: Recipe, count: number = 1) => {
    if (!canCraft(recipe, inventory)) return;
    const entries: QueueEntry[] = Array.from({ length: count }, () => ({
      recipe,
      uid: ++queueUid,
    }));
    setCraftQueue((prev) => [...prev, ...entries]);
  };

  const removeFromQueue = (index: number) => {
    setCraftQueue((prev) => prev.filter((_, i) => i !== index));
  };

  const clearQueue = () => {
    setCraftQueue([]);
    setCraftProgress(0);
  };

  React.useEffect(() => {
    const head = craftQueue[0];
    if (!head) {
      setCraftProgress(0);
      return;
    }
    const recipe = head.recipe;

    if (!canCraft(recipe, inventoryRef.current)) {
      setCraftQueue((prev) => prev.slice(1));
      return;
    }

    const startTime = performance.now();
    const duration = recipe.craftingTime * 1000;

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const pct = Math.min(elapsed / duration, 1);
      setCraftProgress(pct);

      if (pct < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setInventory((prev) => {
          const next = [...prev];
          for (const input of recipe.inputs) {
            let remaining = input.quantity;
            for (const slot of next) {
              if (slot.itemId === input.itemId && remaining > 0) {
                const take = Math.min(slot.quantity, remaining);
                slot.quantity -= take;
                remaining -= take;
              }
            }
          }
          const filtered = next.filter((s) => s.quantity > 0);
          const existing = filtered.find((s) => s.itemId === recipe.output.itemId);
          if (existing) {
            existing.quantity += recipe.output.quantity;
          } else {
            filtered.push({ itemId: recipe.output.itemId, quantity: recipe.output.quantity });
          }
          return filtered;
        });
        setCraftQueue((prev) => prev.slice(1));
        setCraftProgress(0);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [craftQueue[0]?.uid]);

  const groupedRecipes = React.useMemo(() => {
    const groups: Record<string, Recipe[]> = {};
    for (const r of RECIPES) {
      const cat = r.id.startsWith("boat_") ? "Boat Parts" : `Tier ${r.tier}`;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(r);
    }
    return groups;
  }, []);

  const groupedInventory = React.useMemo(() => {
    const groups: Record<string, InvSlot[]> = {};
    for (const slot of inventory) {
      const item = getItem(slot.itemId);
      const cat = item ? CATEGORY_LABELS[item.category] ?? "Other" : "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(slot);
    }
    return groups;
  }, [inventory]);

  return (
    <div
      className="w-full h-full flex items-center justify-center pointer-events-auto bg-ocean-950/80"
      data-close-menu="true"
      onClick={toggle}
    >
      <div
        className="hud-panel p-0 max-w-5xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ocean-700/50">
          <h2 className="text-2xl font-bold text-ocean-100">Crafting & Inventory</h2>
          <div className="flex gap-2">
            <button
              className={`btn ${activeTab === "crafting" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("crafting")}
            >
              Crafting
            </button>
            <button
              className={`btn ${activeTab === "inventory" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("inventory")}
            >
              Inventory
            </button>
            <button
              className={`btn ${activeTab === "character" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("character")}
            >
              Character
            </button>
            <button className="btn-secondary" onClick={toggle}>
              Close [Tab]
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {activeTab === "crafting" && (
            <>
              {/* Recipe list */}
              <div className="w-2/3 overflow-y-auto p-4 space-y-4">
                {Object.entries(groupedRecipes).map(([category, recipes]) => (
                  <div key={category}>
                    <h3 className="text-sm font-semibold text-ocean-400 uppercase tracking-wide mb-2">
                      {category}
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                      {recipes.map((recipe) => {
                        const craftable = canCraft(recipe, inventory);
                        const isCurrent = currentCraft?.id === recipe.id;
                        const queueCount = craftQueue.filter((e) => e.recipe.id === recipe.id).length;
                        const isSelected = selectedRecipe?.id === recipe.id;
                        return (
                          <button
                            key={recipe.id}
                            className={`text-left p-3 rounded-lg border transition-all ${
                              isSelected
                                ? "border-ocean-400 bg-ocean-800/60"
                                : "border-ocean-700/30 bg-ocean-800/30 hover:bg-ocean-700/40"
                            } ${!craftable && queueCount === 0 ? "opacity-40" : ""}`}
                            onClick={() => setSelectedRecipe(recipe)}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-ocean-100 font-medium text-sm">
                                {recipe.name}
                              </span>
                              <div className="flex items-center gap-2">
                                {isCurrent && (
                                  <span className="text-xs text-amber-300">
                                    {Math.round(craftProgress * 100)}%
                                  </span>
                                )}
                                {queueCount > 0 && (
                                  <span className="text-xs text-ocean-400">
                                    {isCurrent ? `+${queueCount - 1}` : `x${queueCount}`}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="text-xs text-ocean-400 mt-1">
                              {recipe.inputs.map((inp, i) => {
                                const have = countItem(inventory, inp.itemId);
                                const item = getItem(inp.itemId);
                                return (
                                  <span
                                    key={i}
                                    className={have >= inp.quantity ? "text-ocean-300" : "text-coral-400"}
                                  >
                                    {i > 0 && ", "}
                                    {item?.name ?? inp.itemId}: {have}/{inp.quantity}
                                  </span>
                                );
                              })}
                            </div>
                            {isCurrent && (
                              <div className="mt-2 h-1 bg-ocean-900 rounded overflow-hidden">
                                <div
                                  className="h-full bg-amber-400 transition-none"
                                  style={{ width: `${craftProgress * 100}%` }}
                                />
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Detail panel */}
              <div className="w-1/3 border-l border-ocean-700/50 p-4 flex flex-col">
                {selectedRecipe && (
                  <>
                    <h3 className="text-lg font-bold text-ocean-100 mb-2">
                      {selectedRecipe.name}
                    </h3>
                    <div className="text-sm text-ocean-400 mb-4">
                      Crafting time: {selectedRecipe.craftingTime}s
                      {selectedRecipe.station && (
                        <div className="mt-1">
                          Requires: {getItem(selectedRecipe.station)?.name ?? selectedRecipe.station}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2 mb-4">
                      <h4 className="text-xs font-semibold text-ocean-400 uppercase">Inputs</h4>
                      {selectedRecipe.inputs.map((inp, i) => {
                        const have = countItem(inventory, inp.itemId);
                        const item = getItem(inp.itemId);
                        return (
                          <div key={i} className="flex justify-between text-sm">
                            <span className="text-ocean-200">
                              {item?.name ?? inp.itemId}
                            </span>
                            <span className={have >= inp.quantity ? "text-biome-safe" : "text-coral-400"}>
                              {have} / {inp.quantity}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="space-y-2 mb-4">
                      <h4 className="text-xs font-semibold text-ocean-400 uppercase">Output</h4>
                      <div className="flex justify-between text-sm">
                        <span className="text-ocean-200">
                          {getItem(selectedRecipe.output.itemId)?.name ?? selectedRecipe.output.itemId}
                        </span>
                        <span className="text-amber-300">x{selectedRecipe.output.quantity}</span>
                      </div>
                    </div>

                    {!canCraft(selectedRecipe, inventory) ? (
                      <button className="btn btn-secondary opacity-50 cursor-not-allowed mb-4" disabled>
                        Missing materials
                      </button>
                    ) : (
                      <div className="space-y-2 mb-4">
                        <div className="flex gap-2">
                          {[1, 5, 10].map((n) => (
                            <button
                              key={n}
                              className="btn btn-primary flex-1"
                              onClick={() => addToQueue(selectedRecipe, n)}
                            >
                              +{n}
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min={1}
                            value={craftCount}
                            onChange={(e) => setCraftCount(Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-20 px-2 py-1 bg-ocean-800 border border-ocean-700/50 rounded text-ocean-100 text-sm text-center"
                          />
                          <button
                            className="btn btn-primary flex-1"
                            onClick={() => addToQueue(selectedRecipe, craftCount)}
                          >
                            Queue {craftCount}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Craft Queue */}
                    {craftQueue.length > 0 && (
                      <div className="flex-1 overflow-y-auto">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-xs font-semibold text-ocean-400 uppercase">
                            Queue ({craftQueue.length})
                          </h4>
                          <button
                            className="text-xs text-coral-400 hover:text-coral-300"
                            onClick={clearQueue}
                          >
                            Clear All
                          </button>
                        </div>
                        <div className="space-y-1">
                          {craftQueue.map((entry, i) => (
                            <div
                              key={entry.uid}
                              className="flex items-center justify-between bg-ocean-800/40 rounded px-2 py-1.5"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-xs text-ocean-500 font-mono">{i + 1}</span>
                                <span className="text-sm text-ocean-200 truncate">
                                  {entry.recipe.name}
                                </span>
                                {i === 0 && (
                                  <span className="text-xs text-amber-300 flex-shrink-0">
                                    {Math.round(craftProgress * 100)}%
                                  </span>
                                )}
                              </div>
                              <button
                                className="text-coral-400 hover:text-coral-300 text-sm flex-shrink-0 ml-2"
                                onClick={() => removeFromQueue(i)}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
          {activeTab === "inventory" && (
            <div className="w-full overflow-y-auto p-4 space-y-4">
              {Object.entries(groupedInventory).map(([category, slots]) => (
                <div key={category}>
                  <h3 className="text-sm font-semibold text-ocean-400 uppercase tracking-wide mb-2">
                    {category}
                  </h3>
                  <div className="grid grid-cols-6 gap-2">
                    {slots.map((slot, i) => {
                      const item = getItem(slot.itemId);
                      return (
                        <div
                          key={`${slot.itemId}-${i}`}
                          className="hud-panel p-2 flex flex-col items-center text-center"
                          title={item?.name ?? slot.itemId}
                        >
                          <div className="w-10 h-10 bg-ocean-800/60 rounded flex items-center justify-center text-xs text-ocean-300 mb-1">
                            {item?.name?.charAt(0) ?? "?"}
                          </div>
                          <div className="text-xs text-ocean-200 truncate w-full">
                            {item?.name ?? slot.itemId}
                          </div>
                          <div className="text-xs text-amber-300 font-mono">
                            x{slot.quantity}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {inventory.length === 0 && (
                <div className="text-center text-ocean-500 py-12">
                  Your inventory is empty. Catch fish and gather materials to craft items!
                </div>
              )}
            </div>
          )}
          {activeTab === "character" && (
            <CharacterTab inventory={inventory} />
          )}
        </div>
      </div>
    </div>
  );
}

function CharacterTab({ inventory }: { inventory: InvSlot[] }) {
  const equipment = useGameStore((s) => s.equipment);
  const equipItem = useGameStore((s) => s.equipItem);
  const renderer = useGameStore((s) => s.renderer);

  const [stats, setStats] = React.useState({
    health: 100, maxHealth: 100,
    hunger: 100, thirst: 100,
    oxygen: 100, maxOxygen: 100,
    temperature: 50,
  });

  const [selectedSlot, setSelectedSlot] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!renderer) return;
    const interval = setInterval(() => {
      const simReader = (renderer as any).simReader as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;
      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;
      setStats({
        health: playerSlot.f32[PLR.HEALTH],
        maxHealth: playerSlot.f32[PLR.MAX_HEALTH],
        hunger: playerSlot.f32[PLR.HUNGER],
        thirst: playerSlot.f32[PLR.THIRST],
        oxygen: playerSlot.f32[PLR.OXYGEN],
        maxOxygen: playerSlot.f32[PLR.MAX_OXYGEN],
        temperature: playerSlot.f32[PLR.TEMPERATURE],
      });
    }, 100);
    return () => clearInterval(interval);
  }, [renderer]);

  const healthPct = (stats.health / stats.maxHealth) * 100;
  const oxygenPct = (stats.oxygen / stats.maxOxygen) * 100;

  const equippableItems = React.useMemo(() => {
    if (!selectedSlot) return [];
    const slot = EQUIP_SLOTS.find((s) => s.key === selectedSlot);
    if (!slot) return [];
    return inventory.filter((inv) => {
      const item = getItem(inv.itemId);
      return item && slot.categories.includes(item.category);
    });
  }, [selectedSlot, inventory]);

  return (
    <div className="w-full overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-6">
        {/* Left: Player Status */}
        <div>
          <h3 className="text-sm font-semibold text-ocean-400 uppercase tracking-wide mb-3">
            Player Status
          </h3>

          <div className="space-y-3">
            <StatRow label="Health" value={stats.health} max={stats.maxHealth} pct={healthPct} color="bg-coral-500" />
            <StatRow label="Hunger" value={stats.hunger} max={100} pct={stats.hunger} color="bg-amber-500" />
            <StatRow label="Thirst" value={stats.thirst} max={100} pct={stats.thirst} color="bg-blue-500" />
            <StatRow label="Oxygen" value={stats.oxygen} max={stats.maxOxygen} pct={oxygenPct} color="bg-cyan-400" />
            <StatRow label="Temperature" value={stats.temperature} max={100} pct={stats.temperature} color="bg-orange-400" />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <InfoCard label="Max Health" value={Math.round(stats.maxHealth).toString()} />
            <InfoCard label="Max Oxygen" value={Math.round(stats.maxOxygen).toString()} />
          </div>
        </div>

        {/* Right: Equipment Slots */}
        <div>
          <h3 className="text-sm font-semibold text-ocean-400 uppercase tracking-wide mb-3">
            Equipment
          </h3>

          <div className="space-y-2">
            {EQUIP_SLOTS.map((slot) => {
              const equippedId = equipment[slot.key];
              const equippedItem = equippedId ? getItem(equippedId) : null;
              const isSelected = selectedSlot === slot.key;
              return (
                <div key={slot.key}>
                  <button
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      isSelected
                        ? "border-ocean-400 bg-ocean-800/60"
                        : "border-ocean-700/30 bg-ocean-800/30 hover:bg-ocean-700/40"
                    }`}
                    onClick={() => setSelectedSlot(isSelected ? null : slot.key)}
                  >
                    <span className="text-2xl">{slot.icon}</span>
                    <div className="flex-1 text-left">
                      <div className="text-xs text-ocean-400">{slot.label}</div>
                      <div className="text-sm text-ocean-100">
                        {equippedItem ? equippedItem.name : "— Empty —"}
                      </div>
                    </div>
                    {equippedItem && (
                      <span
                        className="text-xs text-coral-400 hover:text-coral-300 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          equipItem(slot.key, null);
                        }}
                      >
                        Unequip
                      </span>
                    )}
                  </button>

                  {isSelected && (
                    <div className="mt-1 ml-4 p-2 bg-ocean-900/60 rounded-lg">
                      {equippableItems.length > 0 ? (
                        <div className="space-y-1">
                          {equippableItems.map((inv, i) => {
                            const item = getItem(inv.itemId);
                            if (!item) return null;
                            return (
                              <button
                                key={`${inv.itemId}-${i}`}
                                className="w-full flex items-center gap-2 p-2 rounded hover:bg-ocean-700/50 transition-all text-left"
                                onClick={() => {
                                  equipItem(slot.key, inv.itemId);
                                  setSelectedSlot(null);
                                }}
                              >
                                <span className="text-sm text-ocean-100">{item.name}</span>
                                <span className="text-xs text-amber-300 ml-auto">x{inv.quantity}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-ocean-500 p-2">
                          No equippable items for this slot.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, max, pct, color }: { label: string; value: number; max: number; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-ocean-300">{label}</span>
        <span className="text-ocean-400 font-mono">{Math.round(value)} / {Math.round(max)}</span>
      </div>
      <div className="h-2 bg-ocean-900 rounded overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-300`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-panel p-3 text-center">
      <div className="text-xs text-ocean-400">{label}</div>
      <div className="text-lg text-ocean-100 font-bold">{value}</div>
    </div>
  );
}
