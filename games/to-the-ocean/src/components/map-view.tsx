import React from "react";
import { useGameStore } from "../stores/game-store";
import { SimBufferReader, PLR, ENT } from "@downdraft/core";
import { CHUNK_SIZE, WORLD_SEED_DEFAULT, BIOME_NAMES, SECURITY_COLORS, SECURITY_NAMES } from "@shared/constants";
import { BiomeType, SecurityLevel, EntityType } from "@shared/types";
import { WorldGenerator } from "@shared/world/world-generator";

const BIOME_COLORS: Record<number, string> = {
  [BiomeType.Lake]: "#1a4a6a",
  [BiomeType.Arctic]: "#b0c4de",
  [BiomeType.Desert]: "#d4a76a",
  [BiomeType.BorealForest]: "#2d5a2d",
  [BiomeType.Tropical]: "#2d8a4a",
  [BiomeType.SubTropical]: "#3a7a3a",
  [BiomeType.Freshwater]: "#1a5a7a",
  [BiomeType.Ocean]: "#0a2a4a",
  [BiomeType.DeepOcean]: "#021530",
  [BiomeType.CoralReef]: "#ff7f50",
  [BiomeType.KelpForest]: "#2d6a3a",
  [BiomeType.Volcanic]: "#8b2500",
  [BiomeType.GarbagePatch]: "#696969",
  [BiomeType.Hell]: "#4a0000",
};

const ENTITY_COLORS: Record<number, string> = {
  [EntityType.Ship]: "#fbbf24",
  [EntityType.PirateShip]: "#ef4444",
  [EntityType.Pirate]: "#ef4444",
  [EntityType.Island]: "#8b7355",
  [EntityType.Port]: "#60a5fa",
  [EntityType.Fish]: "#22d3ee",
  [EntityType.Shark]: "#94a3b8",
  [EntityType.Whale]: "#64748b",
  [EntityType.Treasure]: "#fde047",
};

const ENTITY_LABELS: Record<number, string> = {
  [EntityType.Ship]: "Ship",
  [EntityType.PirateShip]: "Pirate Ship",
  [EntityType.Pirate]: "Pirate",
  [EntityType.Port]: "Port",
  [EntityType.Island]: "Island",
  [EntityType.Treasure]: "Treasure",
  [EntityType.Whale]: "Whale",
  [EntityType.Shark]: "Shark",
};

const MAP_VIEW_RADIUS = 15; // chunks visible in each direction (~3.8km radius)

export default function MapView() {
  const toggle = useGameStore((s) => s.toggleMap);
  const renderer = useGameStore((s) => s.renderer);
  const bookmarks = useGameStore((s) => s.bookmarks);
  const addBookmark = useGameStore((s) => s.addBookmark);
  const removeBookmark = useGameStore((s) => s.removeBookmark);
  const waypoint = useGameStore((s) => s.waypoint);
  const setWaypoint = useGameStore((s) => s.setWaypoint);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [hoverInfo, setHoverInfo] = React.useState<string | null>(null);
  const [coords, setCoords] = React.useState<{ x: number; z: number; biome: string; security: string } | null>(null);
  const [bookmarkMenu, setBookmarkMenu] = React.useState<{ x: number; y: number; worldX: number; worldZ: number } | null>(null);
  const worldGenRef = React.useRef<WorldGenerator | null>(null);
  const bookmarksRef = React.useRef(bookmarks);
  const waypointRef = React.useRef(waypoint);
  bookmarksRef.current = bookmarks;
  waypointRef.current = waypoint;

  if (!worldGenRef.current) {
    worldGenRef.current = new WorldGenerator(WORLD_SEED_DEFAULT);
  }

  // Cached world data — only regenerate when player crosses into a new chunk
  const worldDataRef = React.useRef<{
    chunkX: number;
    chunkZ: number;
    tiles: { cx: number; cz: number; biome: number; portName?: string; portPos?: { x: number; z: number }; islandPos?: { x: number; z: number }; islandRadius?: number }[];
  }>({ chunkX: NaN, chunkZ: NaN, tiles: [] });

  const rebuildWorldData = (playerChunkX: number, playerChunkZ: number) => {
    const wg = worldGenRef.current!;
    const tiles: typeof worldDataRef.current.tiles = [];
    for (let dz = -MAP_VIEW_RADIUS; dz <= MAP_VIEW_RADIUS; dz++) {
      for (let dx = -MAP_VIEW_RADIUS; dx <= MAP_VIEW_RADIUS; dx++) {
        const cx = playerChunkX + dx;
        const cz = playerChunkZ + dz;
        const info = wg.getChunkInfo(cx, cz);
        const tile: any = { cx, cz, biome: info.biome };
        if (info.hasPort) {
          const port = wg.generatePort(cx, cz, info.biome, info.securityLevel);
          tile.portName = port.name;
          tile.portPos = { x: port.position.x, z: port.position.z };
        }
        if (info.hasIsland) {
          const island = wg.generateIsland(cx, cz, info.biome, info.securityLevel);
          tile.islandPos = { x: island.position.x, z: island.position.z };
          tile.islandRadius = island.radius;
        }
        tiles.push(tile);
      }
    }
    worldDataRef.current = { chunkX: playerChunkX, chunkZ: playerChunkZ, tiles };
  };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastDraw = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - lastDraw < 200) return; // 5 FPS for map redraw
      lastDraw = now;

      const simReader = (renderer as any)?.simReader as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;

      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;

      const px = playerSlot.f32[PLR.POS_X];
      const pz = playerSlot.f32[PLR.POS_Z];
      const heading = playerSlot.f32[PLR.HEADING];

      // Size canvas to its own CSS-rendered size (avoid stretch)
      const canvasRect = canvas.getBoundingClientRect();
      const cw = Math.floor(canvasRect.width);
      const ch = Math.floor(canvasRect.height);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }

      const w = canvas.width;
      const h = canvas.height;
      const mapSize = Math.min(w, h) - 40;
      const mapX = (w - mapSize) / 2;
      const mapY = (h - mapSize) / 2;

      // World-to-map transform: player centered
      const worldSpan = MAP_VIEW_RADIUS * 2 * CHUNK_SIZE;
      const scale = mapSize / worldSpan;
      const chunkPixelSize = CHUNK_SIZE * scale;

      const worldToMap = (wx: number, wz: number): [number, number] => {
        const mx = mapX + (wx - px) * scale + mapSize / 2;
        const my = mapY + (wz - pz) * scale + mapSize / 2;
        return [mx, my];
      };

      // Clear background
      ctx.fillStyle = "#000814";
      ctx.fillRect(0, 0, w, h);

      // Rebuild cached world data only when player enters a new chunk
      const playerChunkX = Math.floor(px / CHUNK_SIZE);
      const playerChunkZ = Math.floor(pz / CHUNK_SIZE);
      if (worldDataRef.current.chunkX !== playerChunkX ||
          worldDataRef.current.chunkZ !== playerChunkZ) {
        rebuildWorldData(playerChunkX, playerChunkZ);
      }

      // Draw biome tiles from cache
      ctx.imageSmoothingEnabled = false;
      for (const tile of worldDataRef.current.tiles) {
        const [mx, my] = worldToMap(tile.cx * CHUNK_SIZE, tile.cz * CHUNK_SIZE);
        if (mx + chunkPixelSize < mapX || mx > mapX + mapSize ||
            my + chunkPixelSize < mapY || my > mapY + mapSize) continue;
        ctx.fillStyle = BIOME_COLORS[tile.biome] ?? "#0a2a4a";
        ctx.fillRect(Math.floor(mx), Math.floor(my), Math.ceil(chunkPixelSize), Math.ceil(chunkPixelSize));
      }

      // Draw islands from cache
      for (const tile of worldDataRef.current.tiles) {
        if (!tile.islandPos) continue;
        const [imx, imy] = worldToMap(tile.islandPos.x, tile.islandPos.z);
        if (imx < mapX || imx > mapX + mapSize || imy < mapY || imy > mapY + mapSize) continue;
        const islandRadiusPx = Math.max(2, (tile.islandRadius ?? 30) * scale);
        ctx.fillStyle = "#8b7355";
        ctx.beginPath();
        ctx.arc(imx, imy, islandRadiusPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#5a4a3a";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Draw ports from cache
      for (const tile of worldDataRef.current.tiles) {
        if (!tile.portPos) continue;
        const [pmx, pmy] = worldToMap(tile.portPos.x, tile.portPos.z);
        if (pmx < mapX || pmx > mapX + mapSize || pmy < mapY || pmy > mapY + mapSize) continue;
        ctx.fillStyle = "#60a5fa";
        ctx.beginPath();
        ctx.arc(pmx, pmy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#1e3a5f";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (chunkPixelSize > 8) {
          ctx.fillStyle = "#bfdbfe";
          ctx.font = "9px monospace";
          ctx.fillText(tile.portName ?? "", pmx + 6, pmy + 3);
        }
      }

      // Draw map border
      ctx.strokeStyle = "#1e3a5f";
      ctx.lineWidth = 2;
      ctx.strokeRect(mapX, mapY, mapSize, mapSize);

      // Draw grid lines every 5 chunks
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 0.5;
      const gridSpacing = 5 * chunkPixelSize;
      const startX = mapX + ((-px * scale + mapSize / 2) % gridSpacing + gridSpacing) % gridSpacing;
      for (let x = startX; x < mapX + mapSize; x += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, mapY);
        ctx.lineTo(x, mapY + mapSize);
        ctx.stroke();
      }
      const startY = mapY + ((-pz * scale + mapSize / 2) % gridSpacing + gridSpacing) % gridSpacing;
      for (let y = startY; y < mapY + mapSize; y += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(mapX, y);
        ctx.lineTo(mapX + mapSize, y);
        ctx.stroke();
      }

      // Draw entities from sim buffer
      const entityCount = simReader.getEntityCount();
      const playerId = playerSlot.u32[PLR.ENTITY_ID];
      for (let i = 0; i < entityCount; i++) {
        const ent = simReader.getEntitySlot(i);
        if (!ent) continue;
        const entId = ent.u32[ENT.ID];
        if (entId === playerId) continue;
        const entType = ent.u32[ENT.TYPE] as EntityType;
        const ex = ent.f32[ENT.POS_X];
        const ez = ent.f32[ENT.POS_Z];
        const [emx, emy] = worldToMap(ex, ez);
        if (emx < mapX || emx > mapX + mapSize || emy < mapY || emy > mapY + mapSize) continue;
        const color = ENTITY_COLORS[entType] ?? "#888";
        const size = entType === EntityType.Ship || entType === EntityType.PirateShip ? 4 :
                     entType === EntityType.Whale ? 3 : 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(emx, emy, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw other players
      const playerCount = simReader.getPlayerCount();
      for (let i = 0; i < playerCount; i++) {
        if (i === 0) continue;
        const ps = simReader.getPlayerSlot(i);
        if (!ps) continue;
        const opx = ps.f32[PLR.POS_X];
        const opz = ps.f32[PLR.POS_Z];
        const [omx, omy] = worldToMap(opx, opz);
        if (omx < mapX || omx > mapX + mapSize || omy < mapY || omy > mapY + mapSize) continue;
        ctx.fillStyle = "#f472b6";
        ctx.beginPath();
        ctx.arc(omx, omy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Draw bookmarks from store
      for (const bm of bookmarksRef.current) {
        const [bmx, bmy] = worldToMap(bm.x, bm.z);
        if (bmx < mapX - 10 || bmx > mapX + mapSize + 10 || bmy < mapY - 10 || bmy > mapY + mapSize + 10) continue;
        ctx.fillStyle = "#a855f7";
        ctx.beginPath();
        ctx.arc(bmx, bmy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.stroke();
        // Star icon
        ctx.fillStyle = "#c084fc";
        ctx.font = "8px monospace";
        ctx.fillText("\u2605", bmx - 4, bmy - 7);
        if (chunkPixelSize > 6) {
          ctx.fillStyle = "#d8b4fe";
          ctx.font = "9px monospace";
          ctx.fillText(bm.label, bmx + 7, bmy + 3);
        }
      }

      // Draw waypoint from store
      const wp = waypointRef.current;
      if (wp) {
        const [wmx, wmy] = worldToMap(wp.x, wp.z);
        if (wmx >= mapX - 10 && wmx <= mapX + mapSize + 10 && wmy >= mapY - 10 && wmy <= mapY + mapSize + 10) {
          // Pulsing ring
          const pulse = (now % 1000) / 1000;
          ctx.strokeStyle = `rgba(251, 191, 36, ${0.8 - pulse * 0.5})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(wmx, wmy, 6 + pulse * 8, 0, Math.PI * 2);
          ctx.stroke();
          // Cross marker
          ctx.strokeStyle = "#fbbf24";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(wmx - 6, wmy);
          ctx.lineTo(wmx + 6, wmy);
          ctx.moveTo(wmx, wmy - 6);
          ctx.lineTo(wmx, wmy + 6);
          ctx.stroke();
          // Distance label
          const dx = wp.x - px;
          const dz = wp.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          ctx.fillStyle = "#fde047";
          ctx.font = "bold 10px monospace";
          ctx.fillText(`${dist.toFixed(0)}m`, wmx + 8, wmy - 8);
        }
      }

      // Draw player at center with heading arrow
      const [pcx, pcy] = worldToMap(px, pz);
      ctx.fillStyle = "#4ade80";
      ctx.beginPath();
      ctx.arc(pcx, pcy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const arrowLen = 12;
      const ax = pcx + Math.sin(heading) * arrowLen;
      const ay = pcy - Math.cos(heading) * arrowLen;
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pcx, pcy);
      ctx.lineTo(ax, ay);
      ctx.stroke();

      // Compass
      ctx.fillStyle = "#81d4fa";
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      ctx.fillText("N", mapX + mapSize / 2, mapY + 14);
      ctx.fillText("S", mapX + mapSize / 2, mapY + mapSize - 4);
      ctx.fillText("W", mapX + 10, mapY + mapSize / 2 + 4);
      ctx.fillText("E", mapX + mapSize - 10, mapY + mapSize / 2 + 4);
      ctx.textAlign = "left";

      // Coordinate readout
      const playerChunkInfo = worldGenRef.current!.getChunkInfo(playerChunkX, playerChunkZ);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px monospace";
      ctx.fillText(
        `X: ${px.toFixed(0)}  Z: ${pz.toFixed(0)}  |  ${BIOME_NAMES[playerChunkInfo.biome] ?? "Unknown"}  |  ${SECURITY_NAMES[playerChunkInfo.securityLevel] ?? "Unknown"}`,
        mapX + 4,
        mapY + mapSize + 18,
      );
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);

  // Mouse hover for entity/chunk info
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const simReader = (renderer as any)?.simReader as SimBufferReader | null;
    if (!simReader || !simReader.isValid()) return;
    const playerSlot = simReader.getPlayerSlot(0);
    if (!playerSlot) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = canvas.width;
    const h = canvas.height;
    const mapSize = Math.min(w, h) - 40;
    const mapX = (w - mapSize) / 2;
    const mapY = (h - mapSize) / 2;

    if (mx < mapX || mx > mapX + mapSize || my < mapY || my > mapY + mapSize) {
      setHoverInfo(null);
      setCoords(null);
      return;
    }

    const px = playerSlot.f32[PLR.POS_X];
    const pz = playerSlot.f32[PLR.POS_Z];
    const worldSpan = MAP_VIEW_RADIUS * 2 * CHUNK_SIZE;
    const scale = mapSize / worldSpan;
    const wx = px + (mx - mapX - mapSize / 2) / scale;
    const wz = pz + (my - mapY - mapSize / 2) / scale;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const info = worldGenRef.current!.getChunkInfo(cx, cz);

    setCoords({
      x: wx,
      z: wz,
      biome: BIOME_NAMES[info.biome] ?? "Unknown",
      security: SECURITY_NAMES[info.securityLevel] ?? "Unknown",
    });

    // Check for nearby entities
    let nearest: { label: string; dist: number } | null = null;
    const entityCount = simReader.getEntityCount();
    const playerId = playerSlot.u32[PLR.ENTITY_ID];
    for (let i = 0; i < entityCount; i++) {
      const ent = simReader.getEntitySlot(i);
      if (!ent) continue;
      const entId = ent.u32[ENT.ID];
      if (entId === playerId) continue;
      const entType = ent.u32[ENT.TYPE] as EntityType;
      const ex = ent.f32[ENT.POS_X];
      const ez = ent.f32[ENT.POS_Z];
      const dx = ex - wx;
      const dz = ez - wz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < CHUNK_SIZE * 0.5) {
        const label = ENTITY_LABELS[entType] ?? `Entity(${entType})`;
        if (!nearest || dist < nearest.dist) {
          nearest = { label, dist };
        }
      }
    }

    // Check for ports/islands
    if (info.hasPort) {
      const port = worldGenRef.current!.generatePort(cx, cz, info.biome, info.securityLevel);
      const dx = port.position.x - wx;
      const dz = port.position.z - wz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < CHUNK_SIZE * 0.5) {
        if (!nearest || dist < nearest.dist) {
          nearest = { label: `Port: ${port.name}`, dist };
        }
      }
    }
    if (info.hasIsland) {
      const island = worldGenRef.current!.generateIsland(cx, cz, info.biome, info.securityLevel);
      const dx = island.position.x - wx;
      const dz = island.position.z - wz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < island.radius) {
        if (!nearest || dist < nearest.dist) {
          nearest = { label: `Island: ${island.name}`, dist };
        }
      }
    }

    setHoverInfo(nearest ? `${nearest.label} (${nearest.dist.toFixed(0)}m)` : null);
  };

  // Convert a mouse event to world coordinates
  const mouseToWorld = (e: React.MouseEvent<HTMLCanvasElement>): { wx: number; wz: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const simReader = (renderer as any)?.simReader as SimBufferReader | null;
    if (!simReader || !simReader.isValid()) return null;
    const playerSlot = simReader.getPlayerSlot(0);
    if (!playerSlot) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = canvas.width;
    const h = canvas.height;
    const mapSize = Math.min(w, h) - 40;
    const mapX = (w - mapSize) / 2;
    const mapY = (h - mapSize) / 2;
    if (mx < mapX || mx > mapX + mapSize || my < mapY || my > mapY + mapSize) return null;
    const px = playerSlot.f32[PLR.POS_X];
    const pz = playerSlot.f32[PLR.POS_Z];
    const worldSpan = MAP_VIEW_RADIUS * 2 * CHUNK_SIZE;
    const scale = mapSize / worldSpan;
    return {
      wx: px + (mx - mapX - mapSize / 2) / scale,
      wz: pz + (my - mapY - mapSize / 2) / scale,
    };
  };

  // Left click: set/clear waypoint
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = mouseToWorld(e);
    if (!pos) return;
    if (waypoint) {
      const dx = waypoint.x - pos.wx;
      const dz = waypoint.z - pos.wz;
      if (Math.sqrt(dx * dx + dz * dz) < CHUNK_SIZE * 0.3) {
        setWaypoint(null);
        return;
      }
    }
    setWaypoint({ x: pos.wx, z: pos.wz });
  };

  // Right click: open bookmark menu
  const onCanvasContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = mouseToWorld(e);
    if (!pos) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    setBookmarkMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      worldX: pos.wx,
      worldZ: pos.wz,
    });
  };

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto" onClick={toggle}>
      <div
        ref={containerRef}
        className="hud-panel p-2 relative"
        style={{ width: "90vw", height: "85vh", maxWidth: "1100px", maxHeight: "900px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1 px-2">
          <h2 className="text-xl font-bold text-ocean-100">World Map</h2>
          <div className="flex items-center gap-4 text-xs text-ocean-300">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-400" /> You
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-pink-400" /> Other Players
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-400" /> Ports
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> Ships
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-400" /> Hostiles
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-purple-400" /> Bookmarks
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-amber-300" style={{ clipPath: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" }} /> Waypoint
            </span>
          </div>
          <button className="btn-secondary text-sm" onClick={toggle}>Close [M]</button>
        </div>
        <div className="text-xs text-ocean-400 px-2 mb-1">
          <span className="text-ocean-300 font-semibold">Left-click</span> set waypoint · <span className="text-ocean-300 font-semibold">Right-click</span> add bookmark
        </div>
        <canvas
          ref={canvasRef}
          className="block rounded border border-ocean-700 cursor-crosshair"
          style={{ width: "calc(100% - 4px)", height: "calc(100% - 70px)" }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => { setHoverInfo(null); setCoords(null); }}
          onClick={onCanvasClick}
          onContextMenu={onCanvasContextMenu}
        />
        {hoverInfo && (
          <div className="absolute bottom-3 left-3 hud-panel px-3 py-1.5 text-xs text-ocean-100 pointer-events-none">
            {hoverInfo}
          </div>
        )}
        {coords && (
          <div className="absolute bottom-3 right-3 hud-panel px-3 py-1.5 text-xs text-ocean-300 pointer-events-none">
            {coords.x.toFixed(0)}, {coords.z.toFixed(0)} — {coords.biome} ({coords.security})
          </div>
        )}
        {/* Bookmark context menu */}
        {bookmarkMenu && (
          <>
            <div className="fixed inset-0" onClick={() => setBookmarkMenu(null)} onContextMenu={(e) => { e.preventDefault(); setBookmarkMenu(null); }} />
            <div
              className="absolute z-50 hud-panel p-2 text-xs"
              style={{ left: bookmarkMenu.x, top: bookmarkMenu.y, minWidth: 180 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-ocean-400 mb-1">
                {bookmarkMenu.worldX.toFixed(0)}, {bookmarkMenu.worldZ.toFixed(0)}
              </div>
              <input
                type="text"
                placeholder="Bookmark name..."
                className="w-full bg-ocean-900 text-ocean-100 text-xs px-2 py-1 rounded border border-ocean-700 mb-2"
                autoFocus
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    const label = (ev.target as HTMLInputElement).value.trim() || `Bookmark ${bookmarks.length + 1}`;
                    addBookmark(bookmarkMenu.worldX, bookmarkMenu.worldZ, label);
                    setBookmarkMenu(null);
                  } else if (ev.key === "Escape") {
                    setBookmarkMenu(null);
                  }
                }}
              />
              <div className="flex gap-2">
                <button
                  className="btn-secondary text-xs flex-1"
                  onClick={(ev) => {
                    const input = ev.currentTarget.parentElement?.previousElementSibling as HTMLInputElement;
                    const label = input?.value.trim() || `Bookmark ${bookmarks.length + 1}`;
                    addBookmark(bookmarkMenu.worldX, bookmarkMenu.worldZ, label);
                    setBookmarkMenu(null);
                  }}
                >
                  Add
                </button>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setBookmarkMenu(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
        {/* Bookmarks list */}
        {bookmarks.length > 0 && (
          <div className="absolute top-12 right-2 hud-panel p-2 text-xs max-h-48 overflow-y-auto" style={{ minWidth: 140 }}>
            <div className="text-ocean-400 font-semibold mb-1">Bookmarks</div>
            {bookmarks.map((bm) => (
              <div key={bm.id} className="flex items-center justify-between gap-2 py-0.5">
                <span className="text-purple-300 truncate" style={{ maxWidth: 80 }}>{bm.label}</span>
                <span className="text-ocean-500 text-[10px]">{bm.x.toFixed(0)},{bm.z.toFixed(0)}</span>
                <button
                  className="text-red-400 hover:text-red-300 text-[10px]"
                  onClick={() => removeBookmark(bm.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
