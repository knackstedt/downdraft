// Command handling — extracted from Simulation.ts

import { WeatherSystem } from "@downdraft/plugin-weather";
import {
    BiomeType,
    GameMode,
    SimCommand,
    WeatherType,
    WorldCommand,
} from "../shared/types";
import { WorldGenerator } from "../shared/world/world-generator";
import { DockingSystem } from "./building/docking-system";
import { PlaceableSystem } from "./building/placeable-system";
import { MarketSystem } from "./economy/market-system";
import { GameModeManager } from "./gamemode/game-mode-manager";
import {
    addItem,
    moveItem,
    removeItem
} from "./inventory/inventory-system";
import { LicenseSystem } from "./player/license-system";
import type { SimEntity, SimPlayer } from "./simulation";
import type { SimulationEntityManagerAccess } from "./simulation-entity-manager";
import { SurvivalSystem } from "./survival/survival-system";
import { ChunkManager } from "./world/chunk-manager";
import { IslandManager } from "./world/island-manager";
import { PortSystem } from "./world/port-system";

export interface SimulationCommandsAccess extends SimulationEntityManagerAccess {
  survivalSystem: SurvivalSystem;
  marketSystem: MarketSystem;
  licenseSystem: LicenseSystem;
  dockingSystem: DockingSystem;
  placeableSystem: PlaceableSystem;
  gameModeManager: GameModeManager;
  weatherSystem: WeatherSystem;
  worldGen: WorldGenerator;
  chunkManager: ChunkManager;
  portSystem: PortSystem;
  islandManager: IslandManager;
  rules: Record<string, number | boolean>;
  gamemode: GameMode;
  timeOfDay: number;
  profile?: boolean;
  entities: SimEntity[];
  entityCount: number;
  players: SimPlayer[];
  playerCount: number;
  spawnEntity: (type: any, opts: any) => number;
  removeEntity: (id: number) => void;
  getPlayerCenterX: () => number;
  getPlayerCenterZ: () => number;
}

export function handleCommand(
  sim: SimulationCommandsAccess,
  cmd: SimCommand,
): { success: boolean; message?: string; data?: any } {
  const player = sim.players.find(p => p?.playerId === cmd.playerId);
  if (!player || !player.active) {
    return { success: false, message: "Player not found or inactive" };
  }

  switch (cmd.type) {
    case "sleep": {
      sim.survivalSystem.sleep(player);
      return { success: true };
    }
    case "wake": {
      sim.survivalSystem.wake(player);
      return { success: true };
    }
    case "eat": {
      const amount = (cmd.payload.amount as number) ?? 10;
      sim.survivalSystem.eat(player, amount);
      return { success: true };
    }
    case "drink": {
      const amount = (cmd.payload.amount as number) ?? 20;
      sim.survivalSystem.drink(player, amount);
      return { success: true };
    }
    case "trade": {
      const portId = String(cmd.payload.portId);
      const itemId = cmd.payload.itemId as string;
      const quantity = (cmd.payload.quantity as number) ?? 1;
      const isBuying = (cmd.payload.isBuying as boolean) ?? true;
      const baseValue = (cmd.payload.baseValue as number) ?? 0;
      if (baseValue <= 0) return { success: false, message: "Invalid base value" };
      const listing = sim.marketSystem.getListing(portId, itemId);
      if (!listing && isBuying) return { success: false, message: "Item not available at this port" };
      if (isBuying) {
        const totalPrice = sim.marketSystem.buyFromPort(portId, itemId, baseValue, quantity);
        if (player.gold < totalPrice) return { success: false, message: "Not enough gold" };
        player.gold -= totalPrice;
      } else {
        const totalPrice = sim.marketSystem.sellToPort(portId, itemId, baseValue, quantity, false);
        player.gold += totalPrice;
      }
      return { success: true, data: { gold: player.gold } };
    }
    case "license": {
      const craftType = cmd.payload.craftType as number;
      if (sim.licenseSystem.hasLicense(player.playerId, craftType)) {
        return { success: false, message: "Already has this license" };
      }
      sim.licenseSystem.grantLicense(player.playerId, craftType);
      player.licenses.push(craftType);
      return { success: true };
    }
    case "dock": {
      const shipId = cmd.payload.shipId as number;
      const dockIndex = (cmd.payload.dockIndex as number) ?? 0;
      const success = sim.dockingSystem.release(shipId, dockIndex, sim.entities, sim.entityCount);
      if (!success) return { success: false, message: "Cannot release dock at that index" };
      return { success: true };
    }
    case "place_item": {
      const itemId = cmd.payload.itemId as string;
      const parentId = (cmd.payload.parentId as number) ?? 0;
      const instanceId = sim.placeableSystem.place(itemId, parentId);
      if (!instanceId) return { success: false, message: "Unknown placeable item" };
      return { success: true, data: { instanceId } };
    }
    case "pickup_item": {
      const itemId = cmd.payload.itemId as string;
      const quantity = (cmd.payload.quantity as number) ?? 1;
      const remaining = addItem(player.inventory, itemId, quantity);
      if (remaining > 0) {
        return { success: false, message: `Inventory full, ${remaining} items not picked up` };
      }
      const instanceId = cmd.payload.instanceId as number | undefined;
      if (instanceId !== undefined) {
        sim.placeableSystem.remove(instanceId);
      }
      return { success: true };
    }
    case "drop_item": {
      const x = cmd.payload.x as number;
      const y = cmd.payload.y as number;
      const quantity = (cmd.payload.quantity as number) ?? 1;
      const removed = removeItem(player.inventory, x, y, quantity);
      if (!removed) return { success: false, message: "No item at that slot" };
      return { success: true, data: removed };
    }
    case "inventory_move": {
      const fromX = cmd.payload.fromX as number;
      const fromY = cmd.payload.fromY as number;
      const toX = cmd.payload.toX as number;
      const toY = cmd.payload.toY as number;
      const success = moveItem(player.inventory, fromX, fromY, toX, toY);
      if (!success) return { success: false, message: "Cannot move item to that position" };
      return { success: true };
    }
    case "craft": {
      return { success: false, message: "Crafting not yet implemented" };
    }
    case "ship_hold_move": {
      const shipId = cmd.payload.shipId as number;
      const fromX = cmd.payload.fromX as number;
      const fromY = cmd.payload.fromY as number;
      const toX = cmd.payload.toX as number;
      const toY = cmd.payload.toY as number;
      const holdGrid = sim.shipInventories.get(shipId);
      if (!holdGrid) return { success: false, message: "Ship hold not found" };
      const success = moveItem(holdGrid, fromX, fromY, toX, toY);
      if (!success) return { success: false, message: "Cannot move item to that position" };
      return { success: true };
    }
    case "transfer_to_ship": {
      const shipId = cmd.payload.shipId as number;
      const fromX = cmd.payload.fromX as number;
      const fromY = cmd.payload.fromY as number;
      const quantity = (cmd.payload.quantity as number) ?? 1;
      const holdGrid = sim.shipInventories.get(shipId);
      if (!holdGrid) return { success: false, message: "Ship hold not found" };
      const removed = removeItem(player.inventory, fromX, fromY, quantity);
      if (!removed) return { success: false, message: "No item at that slot" };
      const remaining = addItem(holdGrid, removed.itemId, removed.quantity);
      if (remaining > 0) {
        addItem(player.inventory, removed.itemId, remaining);
        return { success: false, message: `Ship hold full, ${remaining} items returned` };
      }
      return { success: true };
    }
    case "transfer_from_ship": {
      const shipId = cmd.payload.shipId as number;
      const fromX = cmd.payload.fromX as number;
      const fromY = cmd.payload.fromY as number;
      const quantity = (cmd.payload.quantity as number) ?? 1;
      const holdGrid = sim.shipInventories.get(shipId);
      if (!holdGrid) return { success: false, message: "Ship hold not found" };
      const removed = removeItem(holdGrid, fromX, fromY, quantity);
      if (!removed) return { success: false, message: "No item at that slot" };
      const remaining = addItem(player.inventory, removed.itemId, removed.quantity);
      if (remaining > 0) {
        addItem(holdGrid, removed.itemId, remaining);
        return { success: false, message: `Player inventory full, ${remaining} items returned` };
      }
      return { success: true };
    }
    default:
      return { success: false, message: `Unknown command type: ${cmd.type}` };
  }
}

export function handleWorldCommand(
  sim: SimulationCommandsAccess,
  cmd: WorldCommand,
): { success: boolean; message?: string; data?: any } {
  const { type, payload } = cmd;
  const cx = payload.chunkX ?? 0;
  const cz = payload.chunkZ ?? 0;

  switch (type) {
    case "override_biome": {
      if (payload.biome === undefined) return { success: false, message: "Missing biome" };
      sim.worldGen.setBiomeOverride(cx, cz, payload.biome as BiomeType);
      sim.chunkManager.reloadChunk(cx, cz);
      return { success: true };
    }
    case "force_port": {
      sim.worldGen.forcePort(cx, cz);
      sim.chunkManager.reloadChunk(cx, cz);
      const nearbyPorts = sim.chunkManager.getNearbyPorts(
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(), 5000,
      );
      sim.portSystem.updatePorts(nearbyPorts);
      return { success: true };
    }
    case "force_island": {
      sim.worldGen.forceIsland(cx, cz);
      sim.chunkManager.reloadChunk(cx, cz);
      sim.islandManager.tick(
        (type, opts) => sim.spawnEntity(type, opts),
        (id) => sim.removeEntity(id),
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(),
      );
      return { success: true };
    }
    case "remove_port": {
      sim.worldGen.removePort(cx, cz);
      sim.chunkManager.reloadChunk(cx, cz);
      const nearbyPorts = sim.chunkManager.getNearbyPorts(
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(), 5000,
      );
      sim.portSystem.updatePorts(nearbyPorts);
      return { success: true };
    }
    case "remove_island": {
      sim.worldGen.removeIsland(cx, cz);
      sim.chunkManager.reloadChunk(cx, cz);
      sim.islandManager.tick(
        (type, opts) => sim.spawnEntity(type, opts),
        (id) => sim.removeEntity(id),
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(),
      );
      return { success: true };
    }
    case "clear_overrides": {
      sim.worldGen.clearOverrides();
      sim.chunkManager.reloadAll();
      const nearbyPorts = sim.chunkManager.getNearbyPorts(
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(), 5000,
      );
      sim.portSystem.updatePorts(nearbyPorts);
      sim.islandManager.tick(
        (type, opts) => sim.spawnEntity(type, opts),
        (id) => sim.removeEntity(id),
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(),
      );
      return { success: true };
    }
    case "set_seed": {
      if (payload.seed === undefined) return { success: false, message: "Missing seed" };
      sim.worldGen.setSeed(payload.seed);
      sim.chunkManager.reloadAll();
      const nearbyPorts = sim.chunkManager.getNearbyPorts(
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(), 5000,
      );
      sim.portSystem.updatePorts(nearbyPorts);
      sim.islandManager.tick(
        (type, opts) => sim.spawnEntity(type, opts),
        (id) => sim.removeEntity(id),
        sim.getPlayerCenterX(), sim.getPlayerCenterZ(),
      );
      return { success: true };
    }
    case "toggle_event": {
      return { success: true, message: `Event '${payload.event}' ${payload.action} (stub)` };
    }
    default:
      return { success: false, message: `Unknown world command: ${type}` };
  }
}

export function setSetting(
  sim: SimulationCommandsAccess,
  key: string,
  value: number | boolean,
): void {
  sim.rules[key] = value;
  sim.gameModeManager.updateRules(sim.rules);
  sim.survivalSystem.updateRules(sim.rules);
  if (key === "portGenerationRate" || key === "islandGenerationRate") {
    sim.worldGen.setGenerationRates(
      (sim.rules.portGenerationRate as number) ?? 0.015,
      (sim.rules.islandGenerationRate as number) ?? 0.00000025,
    );
  }
  if (key === "profile") {
    sim.profile = !!value;
  }
}

export function setWeather(sim: SimulationCommandsAccess, weatherType: number): void {
  sim.weatherSystem.setWeatherType(weatherType as WeatherType);
}

export function setTimeOfDay(sim: SimulationCommandsAccess, time: number): void {
  sim.timeOfDay = time;
}

export function setGamemode(sim: SimulationCommandsAccess, mode: number): void {
  sim.gamemode = Object.values(GameMode)[mode] as GameMode;
  sim.gameModeManager.setGamemode(sim.gamemode);
}
