// ============================================================================
// Water Test — initialize water physics, update each tick, expose state
// ============================================================================

import { WaterPhysics, WaterBuffer, DEFAULT_PHYSICS_CONFIG } from "@downdraft/library-water";

export interface WaterTestResult {
  physics: WaterPhysics;
  buffer: WaterBuffer;
}

export function initWaterTest(): WaterTestResult {
  const buffer = new WaterBuffer(4);
  const physics = new WaterPhysics(buffer, {
    ...DEFAULT_PHYSICS_CONFIG,
    waterRenderDistance: 100,
    windSpeed: 5,
    windDirX: 0.7,
    windDirZ: 0.7,
  });

  return { physics, buffer };
}

export function tickWaterTest(result: WaterTestResult, dt: number): void {
  result.physics.update(dt, 0, 0);
}

export function getWaterState(result: WaterTestResult) {
  const config = result.physics.getConfig();
  return {
    windSpeed: config.windSpeed,
    windDir: [config.windDirX, config.windDirZ],
    waterLevel: config.waterLevel,
    waveCount: config.waves.length,
    sampleHeights: [
      result.physics.sampleWaterAt(0, 0),
      result.physics.sampleWaterAt(10, 0),
      result.physics.sampleWaterAt(0, 10),
      result.physics.sampleWaterAt(-10, -10),
    ],
  };
}
