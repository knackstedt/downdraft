// ============================================================================
// Navmesh Test (Legacy) — visualizes the hand-rolled @downdraft/library-navmesh
//
// Same obstacle scene as the recast test but uses the pure-JS navmesh library.
// Uses NavMeshDebugViz for polygon outlines + portal edges, and Pathfinder
// for agent path lines.
// ============================================================================

import { PhysicsTransform, Query, World, type Entity } from "@downdraft/core";
import {
    CrowdSystem,
    NavAgent,
    NavMesh,
    NavMeshDebugViz,
    NavMeshGenerator,
    Pathfinder,
    type HeightFieldSampler,
    type NavAgentData,
    type NavMeshGeneratorConfig,
    type Vec3,
} from "@downdraft/library-navmesh";
import { registerTest, type ITestRenderer, type TestContext, type TestControl } from "../../test-registry";
import { CubeRenderer, type CameraConfig, type CubeInstance } from "../helpers/cube-renderer";
import { LineRenderer, type DebugLine } from "../helpers/line-renderer";
import { buildObstacleSampler, getObstacleBoxes, GROUND_HALF } from "../helpers/obstacle-scene";

const NAVMESH_CONFIG: NavMeshGeneratorConfig = {
  cellSize: 1,
  cellHeight: 0.5,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxSlope: 45,
  maxStep: 0.5,
  regionMinSize: 2,
};

const AGENT_COLORS: [number, number, number][] = [
  [1, 0.2, 0.2], [0.2, 1, 0.2], [0.2, 0.4, 1], [1, 1, 0.2], [1, 0.4, 1],
];

// ── Test controls state ──

let showMesh = true;
let showPaths = true;
let showObstacles = true;
let agentSpeed = 3.5;

class LegacyNavmeshRenderer implements ITestRenderer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;
  private cubeRenderer: CubeRenderer;
  private lineRenderer: LineRenderer;
  private depthTexture: GPUTexture | null = null;

  private navMesh: NavMesh | null = null;
  private pathfinder: Pathfinder | null = null;
  private debugViz: NavMeshDebugViz | null = null;
  private crowd: CrowdSystem | null = null;
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

    // Build obstacle cube instances for rendering.
    this.obstacleCubes = getObstacleBoxes().map((b) => ({
      position: b.center,
      color: b.color,
      size: 1,
      scale: b.size,
    }));

    // Build navmesh from the obstacle scene's heightfield sampler.
    const sampler: HeightFieldSampler = buildObstacleSampler();
    const gen = new NavMeshGenerator(NAVMESH_CONFIG);
    const navData = gen.generate(sampler, -GROUND_HALF, -GROUND_HALF, GROUND_HALF, GROUND_HALF);
    this.navMesh = new NavMesh();
    this.navMesh.build(navData);
    this.pathfinder = new Pathfinder(this.navMesh);
    this.debugViz = new NavMeshDebugViz(this.navMesh);

    // Create crowd + ECS world.
    this.crowd = new CrowdSystem(this.navMesh, this.pathfinder, {
      spatialCellSize: 4,
      terrainSampleFn: null,
    });
    this.world = new World();
    this.crowdQuery = new Query([NavAgent.id, PhysicsTransform.id]);
    this.world.schedule.updateQueryArchetypes(this.world.allArchetypes);
    this.crowd.register(this.world, this.crowdQuery);

    // Spawn 5 agents — start/target positions chosen to require routing around obstacles.
    const startPositions: Vec3[] = [[-20, 0, -20], [-15, 0, 18], [0, 0, -20], [12, 0, 12], [20, 0, -18]];
    const targets: Vec3[] = [[20, 0, 20], [18, 0, -18], [12, 0, 18], [-18, 0, -12], [-20, 0, 18]];

    for (let i = 0; i < startPositions.length; i++) {
      const agentData: NavAgentData = {
        radius: 0.4,
        height: 1.8,
        maxSpeed: agentSpeed,
        acceleration: 10,
        path: [],
        pathIndex: 0,
        velocity: [0, 0, 0],
        target: null,
        state: "idle",
        avoidanceRadius: 2.0,
        separationWeight: 1.0,
        alignmentWeight: 0.5,
        cohesionWeight: 0.3,
        polyId: -1,
        repathTimer: 0,
      };
      const transformData = {
        position: [startPositions[i][0], startPositions[i][1], startPositions[i][2]] as Vec3,
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        prevPosition: [...startPositions[i]] as Vec3,
        prevRotation: [0, 0, 0, 1] as [number, number, number, number],
      };
      const components = new Map();
      components.set(NavAgent.id, agentData);
      components.set(PhysicsTransform.id, transformData);
      const entity = this.world.spawn(components);
      this.world.schedule.updateQueryArchetypes(this.world.allArchetypes);

      this.crowd.setTarget(entity, targets[i]);
      this.agents.push({ entity, color: AGENT_COLORS[i], target: targets[i] });
    }
  }

  render(ctx: TestContext): void {
    if (!this.world || !this.navMesh || !this.crowd) return;

    this.world.step(ctx.dt);

    // Update agent speeds.
    for (const agent of this.agents) {
      const data = this.world.getComponent<NavAgentData>(agent.entity, NavAgent.id);
      if (data) data.maxSpeed = agentSpeed;
    }

    if (!this.depthTexture || this.depthTexture.width !== ctx.width || this.depthTexture.height !== ctx.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [ctx.width, ctx.height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    const camera: CameraConfig = {
      eye: [30, 35, 30], target: [0, 0, 0], up: [0, 1, 0],
      fov: Math.PI / 4, near: 0.1, far: 200, aspect: ctx.width / ctx.height,
    };

    const encoder = this.device.createCommandEncoder();
    const colorView = this.canvas.getContext("webgpu")!.getCurrentTexture().createView();
    const depthView = this.depthTexture.createView();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    // Draw obstacles as gray boxes.
    if (showObstacles) {
      this.cubeRenderer.drawCubes(pass, this.obstacleCubes, camera);
    }

    // Draw agents.
    const agentCubes: CubeInstance[] = this.agents.map((a) => {
      const transform = this.world!.getComponent<{ position: Vec3 }>(a.entity, PhysicsTransform.id);
      const pos = transform ? transform.position : [0, 0, 0] as Vec3;
      return {
        position: [pos[0], pos[1], pos[2]],
        color: a.color,
        size: 0.8,
      };
    });
    this.cubeRenderer.drawCubes(pass, agentCubes, camera);

    // Draw navmesh polygon outlines + portal edges.
    if (showMesh && this.debugViz) {
      const outlines = this.debugViz.getPolygonOutlines();
      const portals = this.debugViz.getPortalEdges();
      const allLines: DebugLine[] = [...outlines, ...portals].map((l) => ({
        start: [l.start[0], l.start[1], l.start[2]] as [number, number, number],
        end: [l.end[0], l.end[1], l.end[2]] as [number, number, number],
        color: l.color,
      }));
      this.lineRenderer.drawLines(pass, allLines, camera);
    }

    // Draw agent paths.
    if (showPaths && this.pathfinder) {
      const pathLines: DebugLine[] = [];
      for (const agent of this.agents) {
        const transform = this.world!.getComponent<{ position: Vec3 }>(agent.entity, PhysicsTransform.id);
        if (!transform) continue;
        const path = this.pathfinder.findPath(transform.position, agent.target);
        for (let i = 0; i < path.length - 1; i++) {
          pathLines.push({
            start: [path[i][0], path[i][1], path[i][2]],
            end: [path[i + 1][0], path[i + 1][1], path[i + 1][2]],
            color: [0, 0.5, 1, 0.8],
          });
        }
      }
      this.lineRenderer.drawLines(pass, pathLines, camera);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  resize(_width: number, _height: number): void {}

  dispose(): void {
    this.depthTexture?.destroy();
    this.cubeRenderer?.dispose();
    this.lineRenderer?.dispose();
    this.depthTexture = null;
    this.navMesh = null;
    this.pathfinder = null;
    this.debugViz = null;
    this.crowd = null;
    this.world = null;
  }
}

registerTest({
  id: "navmesh-legacy",
  name: "Navmesh (Legacy)",
  category: "Navmesh",
  description: "Hand-rolled JS navmesh over a ground plane with box obstacles. Agents route around walls. Polygon outlines (green), portal edges (yellow), path lines (blue), obstacles (gray).",
  requiresWebGPU: true,
  createRenderer: (canvas) => new LegacyNavmeshRenderer(canvas),
  getControls: (): TestControl[] => [
    { key: "showMesh", label: "Show mesh", type: "checkbox", value: showMesh, onChange: (v) => { showMesh = v as boolean; } },
    { key: "showPaths", label: "Show paths", type: "checkbox", value: showPaths, onChange: (v) => { showPaths = v as boolean; } },
    { key: "showObstacles", label: "Show obstacles", type: "checkbox", value: showObstacles, onChange: (v) => { showObstacles = v as boolean; } },
    { key: "speed", label: "Agent speed", type: "slider", min: 1, max: 10, step: 0.5, value: agentSpeed, onChange: (v) => { agentSpeed = v as number; } },
  ],
});
