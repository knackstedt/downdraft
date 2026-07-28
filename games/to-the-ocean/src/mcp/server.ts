// ============================================================================
// MCP Server — Model Context Protocol for AI agent queries
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import { parentPort } from "worker_threads";
import { PORT_DATA, PORT_SERVICE_BITS } from "../shared/constants";
import { ENT, SimBufferReader } from "../shared/sim-buffer";
import { EntityType, PortSize, SecurityLevel } from "../shared/types";

const log = createLogger("info");

interface McpRequest {
  id: number;
  method: string;
  params: any;
}

interface McpResponse {
  id: number;
  result?: any;
  error?: string;
}

export class McpServer {
  private simBuffer: SharedArrayBuffer | null = null;
  private waterBuffer: SharedArrayBuffer | null = null;
  private running = false;

  constructor() {
    this.setupHandlers();
  }

  setBuffers(sim: SharedArrayBuffer, water: SharedArrayBuffer): void {
    this.simBuffer = sim;
    this.waterBuffer = water;
  }

  start(): void {
    this.running = true;
    log.info("mcp", "Server started");
  }

  stop(): void {
    this.running = false;
  }

  private setupHandlers(): void {
    parentPort?.on("message", (req: McpRequest) => {
      this.handleRequest(req).then((result) => {
        parentPort?.postMessage({
          id: req.id,
          result,
        } as McpResponse);
      }).catch((err) => {
        parentPort?.postMessage({
          id: req.id,
          error: err.message,
        } as McpResponse);
      });
    });
  }

  private async handleRequest(req: McpRequest): Promise<any> {
    switch (req.method) {
      case "get_game_state":
        return this.getGameState();
      case "get_player_state":
        return this.getPlayerState(req.params.playerId);
      case "get_weather":
        return this.getWeather();
      case "get_time":
        return this.getTime();
      case "get_biome":
        return this.getBiome(req.params.x, req.params.z);
      case "get_nearby_ports":
        return this.getNearbyPorts(req.params.x, req.params.z, req.params.radius);
      case "get_nearby_islands":
        return this.getNearbyIslands(req.params.x, req.params.z, req.params.radius);
      case "get_market":
        return this.getMarket(req.params.portId);
      case "get_wildlife":
        return this.getWildlife();
      case "get_progression":
        return this.getProgression(req.params.playerId);
      case "get_recipes":
        return this.getRecipes();
      case "get_items":
        return this.getItems();
      case "query":
        return this.query(req.params.text);
      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  }

  private getGameState(): any {
    if (!this.simBuffer) return { error: "No sim buffer" };
    const reader = new SimBufferReader(this.simBuffer);
    if (!reader.isValid()) return { error: "Invalid sim buffer" };
    return {
      tick: reader.getTick(),
      entityCount: reader.getEntityCount(),
      playerCount: reader.getPlayerCount(),
      timeOfDay: reader.getTimeOfDay(),
      weatherType: reader.getWeatherType(),
      weatherIntensity: reader.getWeatherIntensity(),
      gamemode: reader.getGamemode(),
    };
  }

  private getPlayerState(playerId: number): any {
    if (!this.simBuffer) return { error: "No sim buffer" };
    // Read player slot from SAB
    return { playerId, message: "Player state from SAB" };
  }

  private getWeather(): any {
    if (!this.simBuffer) return { error: "No sim buffer" };
    const reader = new SimBufferReader(this.simBuffer);
    if (!reader.isValid()) return { error: "Invalid sim buffer" };
    const windDir = reader.getWindDir();
    return {
      type: reader.getWeatherType(),
      intensity: reader.getWeatherIntensity(),
      windSpeed: reader.getWindSpeed(),
      windDirX: windDir.x,
      windDirZ: windDir.z,
      visibility: reader.getVisibility(),
      temperature: reader.getAmbientTemp(),
    };
  }

  private getTime(): any {
    if (!this.simBuffer) return { error: "No sim buffer" };
    const reader = new SimBufferReader(this.simBuffer);
    if (!reader.isValid()) return { error: "Invalid sim buffer" };
    return { timeOfDay: reader.getTimeOfDay() };
  }

  private getBiome(x: number, z: number): any {
    // Would query chunk manager
    return { x, z, biome: "ocean", message: "Biome lookup" };
  }

  private getNearbyPorts(x: number, z: number, radius: number): any {
    if (!this.simBuffer) return { x, z, radius, ports: [] };
    const reader = new SimBufferReader(this.simBuffer);
    if (!reader.isValid()) return { x, z, radius, ports: [] };

    const entityCount = reader.getEntityCount();
    const ports: any[] = [];
    const radiusSq = radius * radius;

    for (let i = 0; i < entityCount; i++) {
      const slot = reader.getEntitySlot(i);
      if (!slot) continue;
      const type = slot.u32[ENT.TYPE];
      if (type !== EntityType.Port) continue;

      const px = slot.f32[ENT.POS_X];
      const pz = slot.f32[ENT.POS_Z];
      const dx = px - x;
      const dz = pz - z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;

      const size = slot.f32[ENT.DATA + PORT_DATA.SIZE];
      const serviceBits = slot.f32[ENT.DATA + PORT_DATA.SERVICES];
      const security = slot.f32[ENT.DATA + PORT_DATA.SECURITY];
      const mooredShipId = slot.f32[ENT.DATA + PORT_DATA.MOORED_SHIP_ID];
      const dockProgress = slot.f32[ENT.DATA + PORT_DATA.DOCK_PROGRESS];
      const biome = slot.f32[ENT.DATA + PORT_DATA.BIOME];

      const services: string[] = [];
      if (serviceBits & PORT_SERVICE_BITS.Trading) services.push("trading");
      if (serviceBits & PORT_SERVICE_BITS.Shipyard) services.push("shipyard");
      if (serviceBits & PORT_SERVICE_BITS.HullModification) services.push("hull_modification");
      if (serviceBits & PORT_SERVICE_BITS.Fishing) services.push("fishing");
      if (serviceBits & PORT_SERVICE_BITS.Supplies) services.push("supplies");
      if (serviceBits & PORT_SERVICE_BITS.Inn) services.push("inn");
      if (serviceBits & PORT_SERVICE_BITS.Licenses) services.push("licenses");
      if (serviceBits & PORT_SERVICE_BITS.Storage) services.push("storage");

      const sizeName = size === PortSize.Large ? "large" : size === PortSize.Medium ? "medium" : "small";
      const secName = security === SecurityLevel.Safe ? "safe" : security === SecurityLevel.Moderate ? "moderate" : security === SecurityLevel.High ? "high" : "extreme";

      ports.push({
        entityId: slot.u32[ENT.ID],
        position: { x: px, y: slot.f32[ENT.POS_Y], z: pz },
        scale: slot.f32[ENT.SCALE],
        size: sizeName,
        securityLevel: secName,
        biome,
        services,
        mooredShipId,
        dockProgress,
        distance: Math.sqrt(distSq),
      });
    }

    return { x, z, radius, ports };
  }

  private getNearbyIslands(x: number, z: number, radius: number): any {
    return { x, z, radius, islands: [] };
  }

  private getMarket(portId: string): any {
    return { portId, listings: [] };
  }

  private getWildlife(): any {
    return { count: 0, species: [] };
  }

  private getProgression(playerId: number): any {
    return { playerId, hullTier: 0, equipmentTier: 0 };
  }

  private getRecipes(): any {
    return { recipes: [] };
  }

  private getItems(): any {
    return { items: [] };
  }

  private query(text: string): any {
    // Natural language query — would use embeddings or keyword matching
    return { query: text, response: "Query not implemented" };
  }
}
