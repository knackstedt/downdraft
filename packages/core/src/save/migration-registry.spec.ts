import { MigrationRegistryImpl } from "./migration-registry.ts";

describe("MigrationRegistryImpl", () => {
  it("returns data unchanged for unknown component at v1", () => {
    const reg = new MigrationRegistryImpl();
    const result = reg.migrate("unknown", { foo: 1 }, 1);
    expect(result).toEqual({ data: { foo: 1 }, version: 1 });
  });

  it("returns null for unknown component at v>1", () => {
    const reg = new MigrationRegistryImpl();
    const result = reg.migrate("unknown", { foo: 1 }, 2);
    expect(result).toBeNull();
  });

  it("returns data unchanged when already at current version", () => {
    const reg = new MigrationRegistryImpl();
    reg.setCurrentVersion("world", 3);
    const result = reg.migrate("world", { time: 0.5 }, 3);
    expect(result).toEqual({ data: { time: 0.5 }, version: 3 });
  });

  it("returns null for forward-incompatible version", () => {
    const reg = new MigrationRegistryImpl();
    reg.setCurrentVersion("world", 2);
    const result = reg.migrate("world", { time: 0.5 }, 3);
    expect(result).toBeNull();
  });

  it("walks a single migration step", () => {
    const reg = new MigrationRegistryImpl();
    reg.register("world", {
      fromVersion: 1,
      toVersion: 2,
      migrate: (data: any) => ({ ...data, newField: "migrated" }),
    });
    const result = reg.migrate("world", { time: 0.5 }, 1);
    expect(result).toEqual({ data: { time: 0.5, newField: "migrated" }, version: 2 });
  });

  it("walks multiple migration steps in order", () => {
    const reg = new MigrationRegistryImpl();
    reg.register("entities", { fromVersion: 1, toVersion: 2, migrate: (d: any) => ({ ...d, v2: true }) });
    reg.register("entities", { fromVersion: 2, toVersion: 3, migrate: (d: any) => ({ ...d, v3: true }) });
    reg.register("entities", { fromVersion: 3, toVersion: 4, migrate: (d: any) => ({ ...d, v4: true }) });
    const result = reg.migrate("entities", { base: 1 }, 1);
    expect(result).toEqual({ data: { base: 1, v2: true, v3: true, v4: true }, version: 4 });
  });

  it("returns null when migration step is missing (abandoned)", () => {
    const reg = new MigrationRegistryImpl();
    reg.register("players", { fromVersion: 1, toVersion: 2, migrate: (d: any) => d });
    reg.setCurrentVersion("players", 3);
    // Missing v2→v3 migration
    const result = reg.migrate("players", { name: "test" }, 1);
    expect(result).toBeNull();
  });

  it("returns null when migration function throws", () => {
    const reg = new MigrationRegistryImpl();
    reg.register("world", {
      fromVersion: 1,
      toVersion: 2,
      migrate: () => { throw new Error("boom"); },
    });
    const result = reg.migrate("world", { time: 0.5 }, 1);
    expect(result).toBeNull();
  });

  it("getLatestVersion returns registered version", () => {
    const reg = new MigrationRegistryImpl();
    reg.register("world", { fromVersion: 1, toVersion: 2, migrate: (d: any) => d });
    reg.register("world", { fromVersion: 2, toVersion: 5, migrate: (d: any) => d });
    expect(reg.getLatestVersion("world")).toBe(5);
  });

  it("getLatestVersion returns 1 for unregistered component", () => {
    const reg = new MigrationRegistryImpl();
    expect(reg.getLatestVersion("unknown")).toBe(1);
  });

  it("setCurrentVersion updates current version", () => {
    const reg = new MigrationRegistryImpl();
    reg.setCurrentVersion("world", 2);
    expect(reg.getLatestVersion("world")).toBe(2);
    reg.setCurrentVersion("world", 5);
    expect(reg.getLatestVersion("world")).toBe(5);
  });
});
