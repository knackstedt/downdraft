// ============================================================================
// Navmesh Test (Recast) — visualizes a recast navmesh with agents + paths
//
// Builds a navmesh from a ground plane + box obstacles (walls + blocks),
// spawns agents in a recast Crowd, and visualizes:
//   - Navmesh polygon edges (green wireframe, subtle)
//   - Agent paths (bright blue lines, drawn on top)
//   - Agents as colored cubes
//   - Obstacles as gray boxes
//
// Agents auto-move: when they arrive at their target, a new random target
// is assigned. Play/pause/reset/randomize controls.
// ============================================================================

import { PhysicsTransform, Query, World, type Entity } from "@downdraft/core";
import {
    RecastAgent,
    RecastBackend,
    RecastCrowdSystem,
    type RecastAgentData,
    type Vec3,
} from "@downdraft/library-recast";
import { getNavMeshPositionsAndIndices } from "recast-navigation";
import { registerTest, type ITestRenderer, type TestContext } from "../../test-registry";
import { CubeRenderer, type CameraConfig, type CubeInstance } from "../helpers/cube-renderer";
import { LineRenderer, type DebugLine } from "../helpers/line-renderer";
import {
    getAgentSpeed,
    getNavmeshControls, getPaused,
    isRandomizeRequested,
    isResetRequested,
    randomGroundPoint,
} from "../helpers/navmesh-test-state";
import { buildObstacleScene, getObstacleBoxes } from "../helpers/obstacle-scene";

const AGENT_COLORS: [number, number, number][] = [
  [1, 0.2, 0.2], [0.2, 1, 0.2], [0.2, 0.4, 1], [1, 1, 0.2], [1, 0.4, 1],
];

const INITIAL_STARTS: Vec3[] = [[-20, 0, -20], [-15, 0, 18], [0, 0, -20], [12, 0, 12], [20, 0, -18]];
const INITIAL_TARGETS: Vec3[] = [[20, 0, 20], [18, 0, -18], [12, 0, 18], [-18, 0, -12], [-20, 0, 18]];

class RecastNavmeshRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private lineRenderer: LineRenderer;
  private depthTexture: GPUTexture | null = null;

  private backend: RecastBackend | null = null;
  private crowd: RecastCrowdSystem | null = null;
  private world: World | null = null;
  private crowdQuery: Query | null = null;
  private agents: { entity: Entity; color: [number, number, number]; target: Vec3 }[] = [];
  private obstacleCubes: CubeInstance[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.device = null as unknown as GPUDevice;
    this.format = "bgra8unorm";
    this.cubeRenderer = null as unknown as CubeRenderer;
    this.lineRenderer = null as unknown as LineRenderer;
  }

  async init(ctx: TestContext): Promise<void> {
    this.device = ctx.device;
    this.format = ctx.format;
    this.cubeRenderer = new CubeRenderer(this.device, this.format);
    this.cubeRenderer.init();
    this.lineRenderer = new LineRenderer(this.device, this.format);
    this.lineRenderer.init();

    this.obstacleCubes = getObstacleBoxes().map((b) => ({
      position: b.center, color: b.color, size: 1, scale: b.size,
    }));

    this.backend = new RecastBackend();
    await this.backend.init();
    const { positions, indices } = buildObstacleScene();
    const ok = this.backend.buildNavMesh(positions, indices, {
      cs: 0.3, ch: 0.2, walkableSlopeAngle: 45, walkableHeight: 2, walkableClimb: 0.4, walkableRadius: 0.4,
    });
    if (!ok) throw new Error("recast: failed to build navmesh");

    this.crowd = new RecastCrowdSystem(this.backend, { maxAgents: 32, maxAgentRadius: 0.6 });
    this.world = new World();
    this.crowdQuery = new Query([RecastAgent.id, PhysicsTransform.id]);
    this.world.schedule.updateQueryArchetypes(this.world.allArchetypes);
    this.crowd.register(this.world, this.crowdQuery);

    this.spawnAgents(INITIAL_STARTS, INITIAL_TARGETS);
  }

  private spawnAgents(starts: Vec3[], targets: Vec3[]): void {
    // Clear existing agents.
    this.agents = [];
    if (this.world) {
      for (const a of this.agents) this.world.despawn(a.entity);
    }

    for (let i = 0; i < starts.length; i++) {
      const agentData: RecastAgentData = {
        agentId: -1, radius: 0.4, height: 1.8, maxSpeed: getAgentSpeed(), maxAcceleration: 10,
        target: null, state: "idle", velocity: [0, 0, 0],
      };
      const transformData = {
        position: [...starts[i]] as Vec3,
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        prevPosition: [...starts[i]] as Vec3,
        prevRotation: [0, 0, 0, 1] as [number, number, number, number],
      };
      const components = new Map();
      components.set(RecastAgent.id, agentData);
      components.set(PhysicsTransform.id, transformData);
      const entity = this.world!.spawn(components);
      this.world!.schedule.updateQueryArchetypes(this.world!.allArchetypes);

      this.crowd!.addAgent(entity, { radius: 0.4, height: 1.8, maxSpeed: getAgentSpeed(), maxAcceleration: 10 });
      this.crowd!.setTarget(entity, targets[i]);
      this.agents.push({ entity, color: AGENT_COLORS[i], target: targets[i] });
    }
  }

  private randomizeAll(): void {
    if (!this.crowd || !this.world) return;
    for (const agent of this.agents) {
      const newStart = randomGroundPoint();
      const newTarget = randomGroundPoint();
      const transform = this.world.getComponent<{ position: Vec3 }>(agent.entity, PhysicsTransform.id);
      if (transform) {
        transform.position = [...newStart] as Vec3;
        transform.prevPosition = [...newStart] as Vec3;
      }
      agent.target = newTarget;
      this.crowd.setTarget(agent.entity, newTarget);
    }
  }

  private assignNewTarget(agent: { entity: Entity; target: Vec3 }): void {
    if (!this.crowd) return;
    const newTarget = randomGroundPoint();
    agent.target = newTarget;
    this.crowd.setTarget(agent.entity, newTarget);
  }

  render(ctx: TestContext): void {
    if (!this.world || !this.backend || !this.crowd) return;

    // Handle control signals.
    if (isResetRequested()) {
      this.spawnAgents(INITIAL_STARTS, INITIAL_TARGETS);
    }
    if (isRandomizeRequested()) {
      this.randomizeAll();
    }

    // Tick the ECS world only when not paused.
    if (!getPaused()) {
      this.world.step(ctx.dt);
    }

    // Update agent speeds + check arrival → assign new target (auto-move).
    for (const agent of this.agents) {
      const data = this.world.getComponent<RecastAgentData>(agent.entity, RecastAgent.id);
      if (data) {
        data.maxSpeed = getAgentSpeed();
        if (data.state === "arrived" && !getPaused()) {
          this.assignNewTarget(agent);
        }
      }
    }

    // Ensure depth texture.
    if (!this.depthTexture || this.depthTexture.width !== ctx.width || this.depthTexture.height !== ctx.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [ctx.width, ctx.height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    const camera: CameraConfig = {
      eye: [30, 35, 30], target: [0, 0, 0], up: [0, 1, 0],
      fov: Math.PI / 4, near: 0.1, far: 200, aspect: ctx.width / ctx.height,
    };

    const encoder = this.device.createCommandEncoder();
    const colorView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();
    const depthView = this.depthTexture.createView();

    // Pass 1: Scene (obstacles + agents) with depth write.
    const scenePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView, clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 }, loadOp: "clear", storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView, depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
      },
    });

    // Draw obstacles.
    if (showObstacles) {
      this.cubeRenderer.drawCubes(scenePass, this.obstacleCubes, camera);
    }

    // Draw agents.
    const agentCubes: CubeInstance[] = this.agents.map((a) => {
      const transform = this.world!.getComponent<{ position: Vec3 }>(a.entity, PhysicsTransform.id);
      const pos = transform ? transform.position : [0, 0, 0] as Vec3;
      return { position: [pos[0], pos[1], pos[2]], color: a.color, size: 0.8 };
    });
    this.cubeRenderer.drawCubes(scenePass, agentCubes, camera);

    scenePass.end();

    // Pass 2: Debug overlay (mesh + paths) — depth test but no depth write,
    // drawn on top so paths are always visible.
    const overlayPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "load", storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView, depthClearValue: 0, depthLoadOp: "load", depthStoreOp: "store",
      },
    });

    // Draw navmesh polygon edges (subtle green).
    if (showMesh && this.backend.isBuilt()) {
      const navMesh = this.backend.getNavMesh();
      const [meshPositions, meshIndices] = getNavMeshPositionsAndIndices(navMesh);
      const meshLines: DebugLine[] = [];
      for (let i = 0; i < meshIndices.length; i += 3) {
        const i0 = meshIndices[i] * 3;
        const i1 = meshIndices[i + 1] * 3;
        const i2 = meshIndices[i + 2] * 3;
        const p0: [number, number, number] = [meshPositions[i0], meshPositions[i0 + 1], meshPositions[i0 + 2]];
        const p1: [number, number, number] = [meshPositions[i1], meshPositions[i1 + 1], meshPositions[i1 + 2]];
        const p2: [number, number, number] = [meshPositions[i2], meshPositions[i2 + 1], meshPositions[i2 + 2]];
        const color: [number, number, number, number] = [0, 0.6, 0, 0.25];
        meshLines.push({ start: p0, end: p1, color });
        meshLines.push({ start: p1, end: p2, color });
        meshLines.push({ start: p2, end: p0, color });
      }
      this.lineRenderer.drawLines(overlayPass, meshLines, camera);
    }

    // Draw agent paths (bright blue, prominent).
    if (showPaths && this.backend.isBuilt()) {
      const query = this.backend.getQuery();
      const pathLines: DebugLine[] = [];
      // Draw thick path lines by offsetting slightly vertically + high alpha.
      for (const agent of this.agents) {
        const transform = this.world!.getComponent<{ position: Vec3 }>(agent.entity, PhysicsTransform.id);
        if (!transform) continue;
        const startPos = { x: transform.position[0], y: transform.position[1], z: transform.position[2] };
        const endPos = { x: agent.target[0], y: agent.target[1], z: agent.target[2] };
        const result = query.computePath(startPos, endPos);
        if (result.success && result.path.length > 1) {
          // Draw the path line in the agent's color (bright) for clarity.
          const color: [number, number, number, number] = [
            agent.color[0], agent.color[1], agent.color[2], 0.95,
          ];
          for (let i = 0; i < result.path.length - 1; i++) {
            // Offset slightly above ground so paths render above the mesh.
            const y0 = result.path[i].y + 0.3;
            const y1 = result.path[i + 1].y + 0.3;
            pathLines.push({
              start: [result.path[i].x, y0, result.path[i].z],
              end: [result.path[i + 1].x, y1, result.path[i + 1].z],
              color,
            });
          }
          // Draw target marker (vertical line at target).
          const t = agent.target;
          pathLines.push({
            start: [t[0], 0.1, t[2]],
            end: [t[0], 3, t[2]],
            color: [agent.color[0], agent.color[1], agent.color[2], 0.6],
          });
        }
      }
      this.lineRenderer.drawLines(overlayPass, pathLines, camera);
    }

    overlayPass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.lineRenderer?.dispose();
    this.backend?.destroy();
    this.depthTexture = null;
    this.backend = null;
    this.crowd = null;
    this.world = null;
  }
}

registerTest({
  id: "navmesh-recast",
  name: "Navmesh (Recast)",
  category: "Navmesh",
  description: "Recast WASM navmesh over a ground plane with box obstacles. Agents auto-move, routing around walls. Mesh wireframe (subtle green), path lines (bright, agent-colored), obstacles (gray).",
  requiresWebGPU: true,
  createRenderer: (canvas) => new RecastNavmeshRenderer(canvas),
  getControls: getNavmeshControls,
});
