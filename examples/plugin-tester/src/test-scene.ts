// ============================================================================
// Test Scene — combines navmesh and water tests into one scene
// ============================================================================

import type { AgentVisual } from "./engine";
import { getAgentPositions, initNavMeshTest, type NavMeshTestResult } from "./navmesh-test";
import { getWaterState, initWaterTest, tickWaterTest, type WaterTestResult } from "./water-test";

export interface TestScene {
  navmesh: NavMeshTestResult;
  water: WaterTestResult;
  getAgentVisuals(): AgentVisual[];
  tick(dt: number): void;
  getSnapshot(): unknown;
}

export function initTestScene(): TestScene {
  const navmesh = initNavMeshTest();
  const water = initWaterTest();

  return {
    navmesh,
    water,

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
    },

    getSnapshot(): unknown {
      return {
        navmesh: {
          polyCount: navmesh.navMesh.getPolyCount(),
          agents: getAgentPositions(navmesh),
        },
        water: getWaterState(water),
      };
    },
  };
}
