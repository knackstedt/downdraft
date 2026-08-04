import { World } from "../ecs/world";
import { Camera } from "./camera";
import { WorldStreamer, type ChunkData } from "./streaming";

function makeChunkData(name: string): ChunkData {
  return { name, entities: [] };
}

describe("WorldStreamer", () => {
  it("should construct with config", () => {
    const world = new World();
    const camera = new Camera();
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 3,
      unloadRadius: 5,
      maxConcurrentLoads: 2,
    });

    expect(streamer).toBeDefined();
  });

  it("should load chunks within load radius", async () => {
    const world = new World();
    const camera = new Camera();
    camera.setPosition(0, 0, 0);

    const loaded: string[] = [];
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 1,
      unloadRadius: 2,
      maxConcurrentLoads: 4,
      loader: async (coord) => {
        const name = `${coord.x},${coord.z}`;
        loaded.push(name);
        return makeChunkData(name);
      },
    });

    await streamer.update();

    expect(loaded.length).toBeGreaterThan(0);
  });

  it("should unload chunks outside unload radius", async () => {
    const world = new World();
    const camera = new Camera();
    camera.setPosition(0, 0, 0);

    const unloaded: string[] = [];
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 1,
      unloadRadius: 2,
      maxConcurrentLoads: 4,
      loader: async (coord) => makeChunkData(`${coord.x},${coord.z}`),
      unloader: async (coord, data) => {
        unloaded.push(data.name);
      },
    });

    await streamer.update();

    camera.setPosition(100, 0, 100);
    await streamer.update();

    expect(unloaded.length).toBeGreaterThan(0);
  });

  it("should respect maxConcurrentLoads", async () => {
    const world = new World();
    const camera = new Camera();
    camera.setPosition(0, 0, 0);

    let concurrentLoads = 0;
    let maxConcurrent = 0;
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 3,
      unloadRadius: 5,
      maxConcurrentLoads: 2,
      loader: async (coord) => {
        concurrentLoads++;
        maxConcurrent = Math.max(maxConcurrent, concurrentLoads);
        await new Promise((r) => setTimeout(r, 10));
        concurrentLoads--;
        return makeChunkData(`${coord.x},${coord.z}`);
      },
    });

    await streamer.update();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("should not reload already loaded chunks", async () => {
    const world = new World();
    const camera = new Camera();
    camera.setPosition(0, 0, 0);

    let loadCount = 0;
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 1,
      unloadRadius: 3,
      maxConcurrentLoads: 4,
      loader: async (coord) => {
        loadCount++;
        return makeChunkData(`${coord.x},${coord.z}`);
      },
    });

    await streamer.update();
    const firstCount = loadCount;
    await streamer.update();

    expect(loadCount).toBe(firstCount);
  });

  it("should handle empty update gracefully", async () => {
    const world = new World();
    const camera = new Camera();
    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 0,
      unloadRadius: 0,
      maxConcurrentLoads: 1,
    });

    await streamer.update();
    expect(true).toBe(true);
  });

  it("should track loaded chunk count", async () => {
    const world = new World();
    const camera = new Camera();
    camera.setPosition(0, 0, 0);

    const streamer = new WorldStreamer(world, camera, {
      chunkSize: 16,
      loadRadius: 1,
      unloadRadius: 2,
      maxConcurrentLoads: 4,
      loader: async (coord) => makeChunkData(`${coord.x},${coord.z}`),
    });

    await streamer.update();
    expect(streamer.getLoadedCount()).toBeGreaterThan(0);
  });
});
