import { SchemaRegistry, CURRENT_SCHEMA_VERSION } from "./schema";

describe("SchemaRegistry", () => {
  it("should start at current schema version", () => {
    const reg = new SchemaRegistry();
    expect(reg.getCurrentVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("should register migrations", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => data);
    expect(reg.hasMigration(0)).toBe(true);
  });

  it("should return false for unregistered migrations", () => {
    const reg = new SchemaRegistry();
    expect(reg.hasMigration(99)).toBe(false);
  });

  it("should apply migration from version 0 to 1", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => {
      const obj = data as Record<string, unknown>;
      return { ...obj, migrated: true };
    });

    const result = reg.migrate({ foo: "bar" }, 0) as Record<string, unknown>;
    expect(result.migrated).toBe(true);
    expect(result.foo).toBe("bar");
  });

  it("should apply multiple migrations in sequence", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => ({ ...data as object, v1: true }));
    reg.registerMigration(1, (data) => ({ ...data as object, v2: true }));
    const result = reg.migrate({ start: true }, 0, 2) as Record<string, unknown>;
    expect(result.v1).toBe(true);
    expect(result.v2).toBe(true);
    expect(result.start).toBe(true);
  });

  it("should not apply migration if already at target version", () => {
    const reg = new SchemaRegistry();
    let called = false;
    reg.registerMigration(0, (data) => { called = true; return data; });

    reg.migrate({ foo: "bar" }, 1);
    expect(called).toBe(false);
  });

  it("should skip missing migrations gracefully", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(1, (data) => ({ ...data as object, v2: true }));

    const result = reg.migrate({ start: true }, 0, 2) as Record<string, unknown>;
    expect(result.v2).toBe(true);
  });

  it("should handle migration errors gracefully", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, () => { throw new Error("migration failed"); });

    const result = reg.migrate({ foo: "bar" }, 0);
    expect(result).toEqual({ foo: "bar" });
  });

  it("should migrate to specified target version", () => {
    const reg = new SchemaRegistry();
    reg.registerMigration(0, (data) => ({ ...data as object, v1: true }));
    reg.registerMigration(1, (data) => ({ ...data as object, v2: true }));

    const result = reg.migrate({ start: true }, 0, 1) as Record<string, unknown>;
    expect(result.v1).toBe(true);
    expect(result.v2).toBeUndefined();
  });
});
