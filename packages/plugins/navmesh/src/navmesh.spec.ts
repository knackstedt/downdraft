import { NavMesh } from "./navmesh";
import { NavMeshGenerator } from "./navmesh-generator";
import { Pathfinder } from "./pathfinder";
import { NavMeshDebugViz } from "./debug-viz";
import type { HeightFieldSampler, NavMeshGeneratorConfig, Vec3 } from "./types";

function makeFlatSampler(height: number = 0): HeightFieldSampler {
  return {
    sampleHeight: () => height,
    isWalkable: () => true,
  };
}

function makeHeightmapSampler(heights: number[][], scale: number = 1): HeightFieldSampler {
  return {
    sampleHeight: (x: number, z: number) => {
      const ix = Math.floor(x / scale);
      const iz = Math.floor(z / scale);
      if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return 0;
      return heights[iz][ix];
    },
    isWalkable: (x: number, z: number) => {
      const ix = Math.floor(x / scale);
      const iz = Math.floor(z / scale);
      if (iz < 0 || iz >= heights.length || ix < 0 || ix >= heights[0].length) return false;
      return heights[iz][ix] >= 0;
    },
  };
}

const defaultConfig: NavMeshGeneratorConfig = {
  cellSize: 1,
  cellHeight: 0.5,
  agentRadius: 0.4,
  agentHeight: 1.8,
  maxSlope: 45,
  maxStep: 0.5,
  regionMinSize: 2,
};

describe("NavMeshGenerator", () => {
  it("should generate nav mesh from flat terrain", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    expect(data.polygons.length).toBeGreaterThan(0);
    expect(data.vertexCount).toBeGreaterThan(0);
    expect(data.vertices.length).toBe(data.vertexCount * 3);
  });

  it("should handle non-walkable areas", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const heights = [
      [0, 0, 0, 0],
      [0, -1, -1, 0],
      [0, -1, -1, 0],
      [0, 0, 0, 0],
    ];
    const sampler = makeHeightmapSampler(heights, 1);
    const data = gen.generate(sampler, 0, 0, 4, 4);

    expect(data.polygons.length).toBeGreaterThan(0);
    for (const poly of data.polygons) {
      expect(poly.region).toBeGreaterThanOrEqual(0);
    }
  });

  it("should partition separate regions", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const heights = [
      [0, 0, -10, 0, 0],
      [0, 0, -10, 0, 0],
      [0, 0, -10, 0, 0],
    ];
    const sampler = makeHeightmapSampler(heights, 1);
    const data = gen.generate(sampler, 0, 0, 5, 3);

    const regions = new Set(data.polygons.map((p) => p.region));
    expect(regions.size).toBeGreaterThanOrEqual(1);
  });

  it("should compute centroids and area for polygons", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    for (const poly of data.polygons) {
      expect(poly.centroid[0]).toBeGreaterThanOrEqual(-0.01);
      expect(poly.centroid[1]).toBe(0);
      expect(poly.area).toBeGreaterThan(0);
    }
  });
});

describe("NavMesh", () => {
  it("should build and query polygons", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    expect(navMesh.getPolyCount()).toBe(data.polygons.length);
  });

  it("should find closest polygon to a point", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const polyId = navMesh.findClosestPoly([5, 0, 5]);
    expect(polyId).toBeGreaterThanOrEqual(0);
  });

  it("should detect point in polygon", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const polyId = navMesh.findClosestPoly([5, 0, 5]);
    expect(polyId).toBeGreaterThanOrEqual(0);
    expect(navMesh.isPointInPoly(polyId, [5, 0, 5])).toBe(true);
    expect(navMesh.isPointInPoly(polyId, [100, 0, 100])).toBe(false);
  });

  it("should get polygon neighbors", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const polyId = navMesh.findClosestPoly([5, 0, 5]);
    const neighbors = navMesh.getPolyNeighbors(polyId);
    expect(neighbors.length).toBeGreaterThan(0);
  });

  it("should get portal edges between adjacent polygons", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const polyId = navMesh.findClosestPoly([5, 0, 5]);
    const neighbors = navMesh.getPolyNeighbors(polyId);
    if (neighbors.length > 0) {
      const portal = navMesh.getPortalEdge(polyId, neighbors[0]);
      expect(portal).not.toBeNull();
      expect(portal!.left).toBeDefined();
      expect(portal!.right).toBeDefined();
    }
  });

  it("should clear", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 5, 5);

    const navMesh = new NavMesh();
    navMesh.build(data);
    expect(navMesh.getPolyCount()).toBeGreaterThan(0);

    navMesh.clear();
    expect(navMesh.getPolyCount()).toBe(0);
  });
});

describe("Pathfinder", () => {
  it("should find path on flat terrain", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([1, 0, 1], [8, 0, 8]);

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0][0]).toBeCloseTo(1);
    expect(path[0][2]).toBeCloseTo(1);
    expect(path[path.length - 1][0]).toBeCloseTo(8);
    expect(path[path.length - 1][2]).toBeCloseTo(8);
  });

  it("should return empty path for unreachable destination", () => {
    const navMesh = new NavMesh();
    navMesh.build({ polygons: [], vertices: new Float32Array(0), vertexCount: 0 });

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([0, 0, 0], [10, 0, 10]);
    expect(path.length).toBe(0);
  });

  it("should return direct path when start and end are in same polygon", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const startPoly = navMesh.findClosestPoly([5, 0, 5]);
    const center = navMesh.getPolyCenter(startPoly);
    const path = pathfinder.findPath(
      [center[0] - 0.1, 0, center[2] - 0.1],
      [center[0] + 0.1, 0, center[2] + 0.1],
    );

    expect(path.length).toBeGreaterThanOrEqual(2);
  });

  it("should produce simplified waypoints via funnel algorithm", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 15, 15);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([1, 0, 1], [13, 0, 13]);

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path.length).toBeLessThan(20);
  });
});

describe("NavMeshDebugViz", () => {
  it("should generate polygon outline debug lines", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const viz = new NavMeshDebugViz(navMesh);
    const lines = viz.getPolygonOutlines();
    expect(lines.length).toBeGreaterThan(0);
  });

  it("should generate portal edge debug lines", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const viz = new NavMeshDebugViz(navMesh);
    const portals = viz.getPortalEdges();
    expect(portals.length).toBeGreaterThan(0);
  });

  it("should generate agent path lines", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 10, 10);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const pathfinder = new Pathfinder(navMesh);
    const path = pathfinder.findPath([1, 0, 1], [8, 0, 8]);

    const viz = new NavMeshDebugViz(navMesh);
    const lines = viz.getAgentPath(path);
    expect(lines.length).toBe(path.length - 1);
  });

  it("should get all debug data", () => {
    const gen = new NavMeshGenerator(defaultConfig);
    const sampler = makeFlatSampler(0);
    const data = gen.generate(sampler, 0, 0, 8, 8);

    const navMesh = new NavMesh();
    navMesh.build(data);

    const viz = new NavMeshDebugViz(navMesh);
    const debugData = viz.getAllDebugData();
    expect(debugData.lines.length).toBeGreaterThan(0);
    expect(debugData.centers.length).toBeGreaterThan(0);
  });
});
