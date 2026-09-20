import { addEntityToArchetype, createArchetype, getColumnValue, getComponentColumn, isSoAColumn, removeEntityFromArchetype } from "./archetype";
import { component, soaComponent, type SoAComponentData } from "./component";
import { query, queryChanged } from "./query";
import { Stage, system } from "./system";
import { World } from "./world";

// --- SoA components for testing ---

const Position = soaComponent("SoAPosition", { x: "f32", y: "f32", z: "f32" });
const Velocity = soaComponent("SoAVelocity", { vx: "f32", vy: "f32", vz: "f32" });
const Health = soaComponent("SoAHealth", { hp: "f32", max: "f32", lastChanged: "u32" });
const Flags = soaComponent("SoAFlags", { flags: "u32", type: "u32" });

// --- AoS components for hybrid tests ---

const Name = component("SoAName", { name: "" });
const Data = component("SoAData", { payload: new Float32Array(8) });

type PositionData = SoAComponentData<{ x: "f32"; y: "f32"; z: "f32" }>;
type VelocityData = SoAComponentData<{ vx: "f32"; vy: "f32"; vz: "f32" }>;
type HealthData = SoAComponentData<{ hp: "f32"; max: "f32"; lastChanged: "u32" }>;

describe("SoA Component Definition", () => {
  it("should create a SoA component with schema", () => {
    expect(Position.soa).toBeDefined();
    expect(Position.soa!.fields).toEqual(["x", "y", "z"]);
    expect(Position.soa!.types.x).toBe("f32");
  });

  it("should create default data object with zeros", () => {
    const data = Position.create();
    expect(data.x).toBe(0);
    expect(data.y).toBe(0);
    expect(data.z).toBe(0);
  });

  it("should create data with overrides", () => {
    const data = Position.create({ x: 5, y: 10 });
    expect(data.x).toBe(5);
    expect(data.y).toBe(10);
    expect(data.z).toBe(0);
  });

  it("should not have soa schema for AoS component", () => {
    expect(Name.soa).toBeUndefined();
  });
});

describe("SoA Archetype Column", () => {
  it("should create SoA column for SoA component", () => {
    const arch = createArchetype([Position.id]);
    const col = getComponentColumn(arch, Position.id);
    expect(isSoAColumn(col)).toBe(true);
    if (isSoAColumn(col)) {
      expect(col.capacity).toBe(16);
      expect(col.length).toBe(0);
      expect(col.arrays.x).toBeInstanceOf(Float32Array);
      expect(col.arrays.y).toBeInstanceOf(Float32Array);
      expect(col.arrays.z).toBeInstanceOf(Float32Array);
    }
  });

  it("should create AoS column for AoS component", () => {
    const arch = createArchetype([Name.id]);
    const col = getComponentColumn(arch, Name.id);
    expect(isSoAColumn(col)).toBe(false);
  });

  it("should create hybrid archetype with both SoA and AoS columns", () => {
    const arch = createArchetype([Position.id, Name.id]);
    expect(isSoAColumn(getComponentColumn(arch, Position.id))).toBe(true);
    expect(isSoAColumn(getComponentColumn(arch, Name.id))).toBe(false);
  });

  it("should push SoA data into TypedArrays", () => {
    const arch = createArchetype([Position.id]);
    addEntityToArchetype(arch, { index: 1, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 5, y: 10, z: 15 })],
    ]));

    const col = getComponentColumn(arch, Position.id);
    expect(isSoAColumn(col)).toBe(true);
    if (isSoAColumn(col)) {
      expect(col.length).toBe(1);
      expect(col.arrays.x[0]).toBe(5);
      expect(col.arrays.y[0]).toBe(10);
      expect(col.arrays.z[0]).toBe(15);
    }
  });

  it("should grow TypedArrays when capacity exceeded", () => {
    const arch = createArchetype([Position.id]);
    // Push 20 entities — exceeds initial capacity of 16
    for (let i = 0; i < 20; i++) {
      addEntityToArchetype(arch, { index: i + 1, generation: 0 }, new Map<number, unknown>([
        [Position.id, Position.create({ x: i, y: i * 2, z: i * 3 })],
      ]));
    }

    const col = getComponentColumn(arch, Position.id);
    expect(isSoAColumn(col)).toBe(true);
    if (isSoAColumn(col)) {
      expect(col.length).toBe(20);
      expect(col.capacity).toBe(32); // doubled from 16
      // Verify data integrity after growth
      for (let i = 0; i < 20; i++) {
        expect(col.arrays.x[i]).toBe(i);
        expect(col.arrays.y[i]).toBe(i * 2);
        expect(col.arrays.z[i]).toBe(i * 3);
      }
    }
  });

  it("should swap-and-pop remove SoA data correctly", () => {
    const arch = createArchetype([Position.id]);
    addEntityToArchetype(arch, { index: 1, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 10 })],
    ]));
    addEntityToArchetype(arch, { index: 2, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 20 })],
    ]));
    addEntityToArchetype(arch, { index: 3, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 30 })],
    ]));

    // Remove entity at row 1 (index 2) — swap row 2 (x=30) to row 1
    removeEntityFromArchetype(arch, { index: 2, generation: 0 });

    const col = getComponentColumn(arch, Position.id);
    if (isSoAColumn(col)) {
      expect(col.length).toBe(2);
      expect(col.arrays.x[0]).toBe(10);
      expect(col.arrays.x[1]).toBe(30); // swapped from last row
    }
  });

  it("should handle hybrid add/remove (SoA + AoS)", () => {
    const arch = createArchetype([Position.id, Name.id]);
    addEntityToArchetype(arch, { index: 1, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 5 })],
      [Name.id, Name.create({ name: "foo" })],
    ]));
    addEntityToArchetype(arch, { index: 2, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 10 })],
      [Name.id, Name.create({ name: "bar" })],
    ]));

    // Remove first entity — second should swap to row 0
    removeEntityFromArchetype(arch, { index: 1, generation: 0 });

    const posCol = getComponentColumn(arch, Position.id);
    const nameCol = getComponentColumn(arch, Name.id);
    if (isSoAColumn(posCol)) {
      expect(posCol.arrays.x[0]).toBe(10); // swapped
    }
    expect((nameCol as unknown[])[0]).toEqual({ name: "bar", __componentId: Name.id });
  });
});

describe("SoA getColumnValue", () => {
  it("should reconstruct object from SoA column", () => {
    const arch = createArchetype([Position.id]);
    addEntityToArchetype(arch, { index: 1, generation: 0 }, new Map<number, unknown>([
      [Position.id, Position.create({ x: 42, y: 99, z: -7 })],
    ]));

    const col = getComponentColumn(arch, Position.id);
    const obj = getColumnValue<PositionData>(col, 0);
    expect(obj).toEqual({ x: 42, y: 99, z: -7 });
  });

  it("should return object from AoS column", () => {
    const arch = createArchetype([Name.id]);
    addEntityToArchetype(arch, { index: 1, generation: 0 }, new Map<number, unknown>([
      [Name.id, Name.create({ name: "hello" })],
    ]));

    const col = getComponentColumn(arch, Name.id);
    const obj = getColumnValue<{ name: string }>(col, 0);
    expect(obj).toEqual({ name: "hello", __componentId: Name.id } as { name: string });
  });

  it("should return undefined for missing column", () => {
    expect(getColumnValue(undefined, 0)).toBeUndefined();
  });
});

describe("SoA World operations", () => {
  it("should spawn entity with SoA component", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 1, y: 2, z: 3 })],
    ]));

    const pos = world.getComponent<PositionData>(entity, Position.id);
    expect(pos).not.toBeNull();
    expect(pos!.x).toBe(1);
    expect(pos!.y).toBe(2);
    expect(pos!.z).toBe(3);
  });

  it("should spawn entity with hybrid SoA + AoS components", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 5, y: 10 })],
      [Name.id, Name.create({ name: "test" })],
    ]));

    const pos = world.getComponent<PositionData>(entity, Position.id);
    expect(pos!.x).toBe(5);
    expect(pos!.y).toBe(10);

    const name = world.getComponent<{ name: string }>(entity, Name.id);
    expect(name!.name).toBe("test");
  });

  it("should despawn SoA entity", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 5 })],
    ]));

    expect(world.entityCount()).toBe(2);
    world.despawn(entity);
    world.flushCommands();
    expect(world.entityCount()).toBe(1);
  });

  it("should add AoS component to SoA entity (archetype move)", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 42 })],
    ]));

    world.addComponent(entity, Name.id, Name.create({ name: "named" }));
    world.flushCommands();

    // Position data should be preserved after archetype move
    const pos = world.getComponent<PositionData>(entity, Position.id);
    expect(pos!.x).toBe(42);

    const name = world.getComponent<{ name: string }>(entity, Name.id);
    expect(name!.name).toBe("named");
  });

  it("should add SoA component to AoS entity (archetype move)", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Name.id, Name.create({ name: "original" })],
    ]));

    world.addComponent(entity, Position.id, Position.create({ x: 7, y: 8, z: 9 }));
    world.flushCommands();

    const pos = world.getComponent<PositionData>(entity, Position.id);
    expect(pos!.x).toBe(7);
    expect(pos!.y).toBe(8);
    expect(pos!.z).toBe(9);

    const name = world.getComponent<{ name: string }>(entity, Name.id);
    expect(name!.name).toBe("original");
  });

  it("should remove SoA component (archetype move)", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 5 })],
      [Name.id, Name.create({ name: "keep" })],
    ]));

    world.removeComponent(entity, Position.id);
    world.flushCommands();

    expect(world.hasComponent(entity, Position.id)).toBe(false);
    const name = world.getComponent<{ name: string }>(entity, Name.id);
    expect(name!.name).toBe("keep");
  });
});

describe("SoA Query iteration", () => {
  it("should iterate SoA components and provide column + row", () => {
    const world = new World();
    world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 10, y: 20, z: 30 })],
      [Velocity.id, Velocity.create({ vx: 1, vy: 2, vz: 3 })],
    ]));
    world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 40, y: 50, z: 60 })],
      [Velocity.id, Velocity.create({ vx: 4, vy: 5, vz: 6 })],
    ]));
    world.flushCommands();

    const q = query(Position.id, Velocity.id);
    q.updateArchetypes(world.allArchetypes);

    const results: Array<{ x: number; vx: number }> = [];
    q.iterate(1, (_entity, comps, row) => {
      const pos = comps[0] as ReturnType<typeof Position.create> extends { x: number } ? never : never;
      // SoA: comps[0] is the SoAColumn, access via [row]
      const posCol = comps[0] as unknown as { x: Float32Array; y: Float32Array; z: Float32Array };
      const velCol = comps[1] as unknown as { vx: Float32Array; vy: Float32Array; vz: Float32Array };
      results.push({ x: posCol.x[row], vx: velCol.vx[row] });
    });

    expect(results).toEqual([
      { x: 10, vx: 1 },
      { x: 40, vx: 4 },
    ]);
  });

  it("should iterate hybrid SoA + AoS components", () => {
    const world = new World();
    world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 5 })],
      [Name.id, Name.create({ name: "alpha" })],
    ]));
    world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 10 })],
      [Name.id, Name.create({ name: "beta" })],
    ]));
    world.flushCommands();

    const q = query(Position.id, Name.id);
    q.updateArchetypes(world.allArchetypes);

    const results: Array<{ x: number; name: string }> = [];
    q.iterate(1, (_entity, comps, row) => {
      const posCol = comps[0] as unknown as { x: Float32Array };
      const nameObj = comps[1] as { name: string };
      results.push({ x: posCol.x[row], name: nameObj.name });
    });

    expect(results).toContainEqual({ x: 5, name: "alpha" });
    expect(results).toContainEqual({ x: 10, name: "beta" });
  });

  it("should support changed filter on SoA component", () => {
    const world = new World();
    const e1 = world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 1 })],
      [Health.id, Health.create({ hp: 100, max: 100, lastChanged: 0 })],
    ]));
    world.flushCommands();
    world.step(0.016); // tick 1

    // Mark health as changed on tick 1 via direct TypedArray access
    const ar = world.getArchetypeAndRow(e1);
    expect(ar).not.toBeNull();
    if (ar) {
      const col = ar.arch.columns.get(Health.id);
      if (isSoAColumn(col)) {
        (col.arrays.lastChanged as Uint32Array)[ar.row] = world.tick;
      }
    }

    const q = queryChanged([Position.id], Health.id);
    q.updateArchetypes(world.allArchetypes);
    q.descriptor.lastReadTick = 0;

    let count = 0;
    q.iterate(world.tick, () => {
      count++;
    });

    expect(count).toBe(1);
  });

  it("should run system with SoA query in world.step", () => {
    const world = new World();
    world.spawn(new Map<number, unknown>([
      [Position.id, Position.create({ x: 0, y: 0, z: 0 })],
      [Velocity.id, Velocity.create({ vx: 5, vy: 0, vz: 0 })],
    ]));
    world.flushCommands();

    const q = query(Position.id, Velocity.id);
    let moved = false;
    const moveSystem = system("soa-move", Stage.Update, (ctx) => {
      q.iterate(ctx.tick, (_entity, comps, row) => {
        const posCol = comps[0] as unknown as { x: Float32Array; y: Float32Array; z: Float32Array };
        const velCol = comps[1] as unknown as { vx: Float32Array; vy: Float32Array; vz: Float32Array };
        posCol.x[row] += velCol.vx[row]! * ctx.dt;
        moved = true;
      });
    }, { queries: [q] });

    world.schedule.add(moveSystem);
    q.updateArchetypes(world.allArchetypes);
    world.step(0.1);

    expect(moved).toBe(true);
    // Verify position was updated
    const ar = world.getArchetypeAndRow({ index: 1, generation: 0 });
    if (ar) {
      const col = ar.arch.columns.get(Position.id);
      if (isSoAColumn(col)) {
        expect(col.arrays.x[ar.row]).toBeCloseTo(0.5, 5); // 0 + 5 * 0.1
      }
    }
  });
});

describe("SoA with different TypedArray types", () => {
  it("should use Uint32Array for u32 fields", () => {
    const arch = createArchetype([Flags.id]);
    const col = getComponentColumn(arch, Flags.id);
    if (isSoAColumn(col)) {
      expect(col.arrays.flags).toBeInstanceOf(Uint32Array);
      expect(col.arrays.type).toBeInstanceOf(Uint32Array);
    }
  });

  it("should store u32 values correctly", () => {
    const world = new World();
    const entity = world.spawn(new Map<number, unknown>([
      [Flags.id, Flags.create({ flags: 0xFF, type: 42 })],
    ]));

    const flags = world.getComponent<{ flags: number; type: number }>(entity, Flags.id);
    expect(flags!.flags).toBe(255);
    expect(flags!.type).toBe(42);
  });
});
