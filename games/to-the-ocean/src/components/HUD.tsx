import { BUILDER_CELL_OPTIONS, HOTBAR_TOOLS } from "@shared/constants";
import { PLR, PLR_FLAG, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, WeatherType } from "@shared/types";
import React from "react";
import { useGameStore } from "../stores/gameStore";
import Reticule, { type ToolAction } from "./Reticule";

const WEATHER_NAMES: Record<number, string> = {
  [WeatherType.Clear]: "Clear",
  [WeatherType.PartlyCloudy]: "Partly Cloudy",
  [WeatherType.Overcast]: "Overcast",
  [WeatherType.Rain]: "Rain",
  [WeatherType.Storm]: "Storm",
  [WeatherType.Fog]: "Fog",
  [WeatherType.Eclipse]: "Eclipse",
  [WeatherType.FullMoon]: "Full Moon",
  [WeatherType.HellStorm]: "Hellstorm",
  [WeatherType.Snow]: "Snow",
};

const CAMERA_MODE_NAMES: Record<number, string> = {
  [CameraMode.FirstPerson]: "First Person",
  [CameraMode.ThirdPerson]: "Third Person",
  [CameraMode.FreeCam]: "Free Cam",
};

function BuilderCellLabel() {
  const builderCellType = useGameStore((s) => s.builderCellType);
  return (
    <span className="text-amber-300 text-[8px] mt-0.5">
      {BUILDER_CELL_OPTIONS[builderCellType]?.name ?? "Hull"}
    </span>
  );
}

export default function HUD() {
  const { fps, weather, renderer } = useGameStore();
  const waypoint = useGameStore((s) => s.waypoint);
  const setWaypoint = useGameStore((s) => s.setWaypoint);
  const [hudState, setHudState] = React.useState({
    health: 100, maxHealth: 100,
    hunger: 100, thirst: 100,
    oxygen: 100, maxOxygen: 100,
    temperature: 50,
    timeOfDay: 0.3,
    weatherType: 0,
    biome: 7,
    security: 0,
    cameraMode: CameraMode.ThirdPerson,
    isFishing: false,
    fishingTension: 50,
    fishingProgress: 0,
    activeSlot: 0,
    isPiloting: false,
    isOnboard: false,
    gold: 0,
  });
  const [waypointInfo, setWaypointInfo] = React.useState<{ dist: number; bearing: number } | null>(null);

  React.useEffect(() => {
    if (!renderer) return;
    const interval = setInterval(() => {
      // Read from sim buffer
      const simReader = (renderer as any).simReader as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;

      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;

      const flags = playerSlot.u32[PLR.FLAGS];
      const newCamMode = playerSlot.u32[PLR.CAMERA_MODE] as CameraMode;

      // Auto-unhide HUD when leaving freecam
      if (newCamMode !== CameraMode.FreeCam && useGameStore.getState().hudHidden) {
        useGameStore.getState().setHudHidden(false);
      }

      setHudState({
        health: playerSlot.f32[PLR.HEALTH],
        maxHealth: playerSlot.f32[PLR.MAX_HEALTH],
        hunger: playerSlot.f32[PLR.HUNGER],
        thirst: playerSlot.f32[PLR.THIRST],
        oxygen: playerSlot.f32[PLR.OXYGEN],
        maxOxygen: playerSlot.f32[PLR.MAX_OXYGEN],
        temperature: playerSlot.f32[PLR.TEMPERATURE],
        timeOfDay: simReader.getTimeOfDay(),
        weatherType: simReader.getWeatherType(),
        biome: 7,
        security: 0,
        cameraMode: newCamMode,
        isFishing: (flags & PLR_FLAG.FISHING) !== 0,
        fishingTension: playerSlot.f32[PLR.FISHING_TENSION] ?? 50,
        fishingProgress: playerSlot.f32[PLR.FISHING_PROGRESS] ?? 0,
        activeSlot: playerSlot.u32[PLR.ACTIVE_SLOT] ?? 0,
        isPiloting: (flags & PLR_FLAG.PILOTING) !== 0,
        isOnboard: (flags & PLR_FLAG.ONBOARD) !== 0,
        gold: playerSlot.f32[PLR.GOLD] ?? 0,
      });

      // Waypoint tracking
      const wp = useGameStore.getState().waypoint;
      if (wp) {
        const px = playerSlot.f32[PLR.POS_X];
        const pz = playerSlot.f32[PLR.POS_Z];
        const heading = playerSlot.f32[PLR.HEADING];
        const dx = wp.x - px;
        const dz = wp.z - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 50) {
          useGameStore.getState().setWaypoint(null);
          setWaypointInfo(null);
        } else {
          const wpBearing = Math.atan2(dx, -dz);
          let relBearing = wpBearing - heading;
          while (relBearing > Math.PI) relBearing -= Math.PI * 2;
          while (relBearing < -Math.PI) relBearing += Math.PI * 2;
          setWaypointInfo({ dist, bearing: relBearing });
        }
      } else {
        setWaypointInfo(null);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [renderer]);

  const healthPct = (hudState.health / hudState.maxHealth) * 100;
  const oxygenPct = (hudState.oxygen / hudState.maxOxygen) * 100;
  const isNight = hudState.timeOfDay > 0.7 || hudState.timeOfDay < 0.25;
  const timeStr = `${Math.floor(hudState.timeOfDay * 24).toString().padStart(2, "0")}:${Math.floor((hudState.timeOfDay * 24 % 1) * 60).toString().padStart(2, "0")}`;

  return (
    <div className="w-full h-full pointer-events-none">
      {/* First-person reticule — animated SVG that morphs between tool shapes */}
      <Reticule
        cameraMode={hudState.cameraMode}
        toolAction={(HOTBAR_TOOLS[hudState.activeSlot]?.action ?? "build") as ToolAction}
        isFishing={hudState.isFishing}
        size={useGameStore.getState().reticleSize}
      />

      {/* Top bar: time, weather, biome, camera mode */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-4 hud-panel px-6 py-2">
        <span className="text-ocean-100 font-mono">
          {isNight ? "🌙" : "☀️"} {timeStr}
        </span>
        <span className="text-ocean-300">
          {WEATHER_NAMES[hudState.weatherType] ?? "Unknown"}
        </span>
        <span className="text-ocean-400 text-sm">
          {fps} FPS
        </span>
        <span className="text-amber-300 text-sm font-semibold">
          {CAMERA_MODE_NAMES[hudState.cameraMode] ?? "Unknown"}
        </span>
        <span className="text-amber-200 text-sm font-mono font-bold">
          🪙 {Math.floor(hudState.gold)}
        </span>
      </div>

      {/* Waypoint indicator */}
      {waypointInfo && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 hud-panel px-4 py-1.5 flex items-center gap-3">
          <span
            className="text-amber-300 text-lg font-bold"
            style={{ transform: `rotate(${waypointInfo.bearing}rad)` }}
          >
            ➤
          </span>
          <span className="text-amber-200 text-sm font-mono">
            {waypointInfo.dist >= 1000
              ? `${(waypointInfo.dist / 1000).toFixed(1)}km`
              : `${waypointInfo.dist.toFixed(0)}m`}
          </span>
          <span
            className="text-ocean-400 text-xs cursor-pointer pointer-events-auto hover:text-red-400"
            onClick={() => setWaypoint(null)}
          >
            ✕
          </span>
        </div>
      )}

      {/* Top right: controls hint */}
      <div className="absolute top-4 right-4 hud-panel px-4 py-2 text-xs text-ocean-300 leading-relaxed">
        <div><span className="text-ocean-100 font-semibold">WASD</span> Move · <span className="text-ocean-100 font-semibold">Mouse</span> Look</div>
        <div><span className="text-ocean-100 font-semibold">V</span> Camera · <span className="text-ocean-100 font-semibold">F</span> Fish · <span className="text-ocean-100 font-semibold">Shift</span> Run</div>
        <div><span className="text-ocean-100 font-semibold">Tab</span> Craft & Inventory · <span className="text-ocean-100 font-semibold">C</span> Character · <span className="text-ocean-100 font-semibold">Esc</span> Menu</div>
        {hudState.cameraMode === CameraMode.FreeCam && (
          <div><span className="text-ocean-100 font-semibold">H</span> Toggle HUD</div>
        )}
      </div>

      {/* Fishing minigame UI */}
      {hudState.isFishing && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 hud-panel px-6 py-4 w-80">
          <div className="text-center text-amber-300 font-semibold mb-3">🎣 Fishing</div>

          {/* Tension bar */}
          <div className="mb-3">
            <div className="text-xs text-ocean-300 mb-1">Tension</div>
            <div className="relative h-6 bg-ocean-950 rounded-full overflow-hidden">
              {/* Danger zones */}
              <div className="absolute inset-y-0 left-0 w-[20%] bg-coral-600/30" />
              <div className="absolute inset-y-0 right-0 w-[20%] bg-coral-600/30" />
              {/* Good zone */}
              <div className="absolute inset-y-0 left-[30%] w-[40%] bg-biome-safe/20" />
              {/* Tension indicator */}
              <div
                className="absolute top-0 bottom-0 w-2 bg-ocean-300 rounded-full"
                style={{ left: `${hudState.fishingTension}%`, transform: "translateX(-50%)" }}
              />
            </div>
          </div>

          {/* Progress bar */}
          <div className="mb-2">
            <div className="text-xs text-ocean-300 mb-1">Progress</div>
            <div className="h-4 bg-ocean-950 rounded-full overflow-hidden">
              <div
                className="h-full bg-ocean-400 rounded-full"
                style={{ width: `${hudState.fishingProgress * 100}%` }}
              />
            </div>
          </div>

          <div className="text-center text-xs text-ocean-400">
            Hold <span className="text-ocean-100 font-bold">Space</span> or <span className="text-ocean-100 font-bold">Click</span> to reel
          </div>
        </div>
      )}

      {/* Bottom left: vital stats */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-2 w-48">
        <StatBar label="Health" value={healthPct} color="bg-coral-500" />
        <StatBar label="Hunger" value={hudState.hunger} color="bg-amber-500" />
        <StatBar label="Thirst" value={hudState.thirst} color="bg-blue-500" />
        <StatBar label="Oxygen" value={oxygenPct} color="bg-cyan-400" />
        <StatBar label="Temp" value={hudState.temperature} color="bg-orange-400" />
      </div>

      {/* Bottom center: hotbar (5 tools) */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {HOTBAR_TOOLS.map((tool, i) => {
          const isActive = i === hudState.activeSlot;
          return (
            <div
              key={i}
              className={`w-16 h-16 hud-panel flex flex-col items-center justify-center text-xs transition-all ${
                isActive ? "border-2 border-amber-400" : ""
              }`}
              style={{
                opacity: isActive ? 1 : 0.5,
                transform: `scale(${isActive ? 1.15 : 1})`,
              }}
            >
              <span className="text-ocean-300 font-bold text-[10px]">
                {i < 9 ? i + 1 : ""}
              </span>
              <span className="text-ocean-100 text-[10px] leading-tight text-center px-0.5 font-semibold">{tool.name}</span>
              {isActive && tool.action === "build" && (
                <BuilderCellLabel />
              )}
            </div>
          );
        })}
      </div>

      {/* Context prompts */}
      {hudState.isPiloting ? (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-center">
          <div className="text-ocean-200 text-sm bg-ocean-950/70 px-4 py-2 rounded-lg">
            <span className="text-ocean-400 font-bold">W/S</span> throttle · <span className="text-ocean-400 font-bold">A/D</span> steer · <span className="text-ocean-400 font-bold">F</span> release helm
          </div>
        </div>
      ) : hudState.isOnboard ? (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-center">
          <div className="text-ocean-200 text-sm bg-ocean-950/70 px-4 py-2 rounded-lg">
            On deck — <span className="text-ocean-400 font-bold">F</span> near helm to pilot · <span className="text-ocean-400 font-bold">F</span> away from helm to disembark · <span className="text-ocean-400 font-bold">1-3</span> / <span className="text-ocean-400 font-bold">Scroll</span> tools · <span className="text-ocean-400 font-bold">RMB</span> select cell · <span className="text-ocean-400 font-bold">LMB</span> to build
          </div>
        </div>
      ) : (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-center">
          <div className="text-ocean-200 text-sm bg-ocean-950/50 px-4 py-2 rounded-lg">
            <span className="text-ocean-400 font-bold">F</span> to board nearby ship
          </div>
        </div>
      )}
    </div>
  );
}

function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
  const prevValueRef = React.useRef(value);
  const materialChange = Math.abs(value - prevValueRef.current) >= 2;
  prevValueRef.current = value;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-ocean-300 w-12">{label}</span>
      <div className="flex-1 stat-bar">
        <div
          className={`stat-bar-fill ${color}`}
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            transition: materialChange ? 'width 300ms ease' : 'none',
          }}
        />
      </div>
    </div>
  );
}
