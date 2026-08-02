// ============================================================================
// Test Scene — combines navmesh, water, and gameplay tests into one scene
// ============================================================================

import type { AgentVisual } from "./engine.ts";
import { initNavMeshTest, getAgentPositions, type NavMeshTestResult } from "./navmesh-test.ts";
import { initWaterTest, tickWaterTest, getWaterState, type WaterTestResult } from "./water-test.ts";
import { initGameplayTest, tickGameplayTest, getGameplayStateSnapshot, type GameplayState } from "./gameplay-test.ts";

export interface TestScene {
  navmesh: NavMeshTestResult;
  water: WaterTestResult;
  gameplay: GameplayState;
  getAgentVisuals(): AgentVisual[];
  tick(dt: number): void;
  getSnapshot(): unknown;
}

export function initTestScene(): TestScene {
  const navmesh = initNavMeshTest();
  const water = initWaterTest();
  const gameplay = initGameplayTest();

  return {
    navmesh,
    water,
    gameplay,

    getAgentVisuals(): AgentVisual[] {
      const positions = getAgentPositions(navmesh);
      return positions.map((p) => ({
        position: p.pos,
        color: navmesh.agents[p.index].color,
        size: 0.8,
      }));
    },

    tick(dt: number): void {
      // Tick ECS world (runs crowd system)
      navmesh.world.step(dt);

      // Tick water physics
      tickWaterTest(water, dt);

      // Tick gameplay systems
      tickGameplayTest(gameplay, dt);
    },

    getSnapshot(): unknown {
      return {
        navmesh: {
          polyCount: navmesh.navMesh.getPolyCount(),
          agents: getAgentPositions(navmesh),
        },
        water: getWaterState(water),
        gameplay: getGameplayStateSnapshot(gameplay),
      };
    },
  };
}
