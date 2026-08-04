import { createLogger } from "../util/logger";

const log = createLogger();

export const CURRENT_SCHEMA_VERSION = 1;

export type MigrationFn = (data: unknown) => unknown;

export class SchemaRegistry {
  private migrations: Map<number, MigrationFn> = new Map();
  private currentVersion: number = CURRENT_SCHEMA_VERSION;

  registerMigration(fromVersion: number, fn: MigrationFn): void {
    this.migrations.set(fromVersion, fn);
  }

  getCurrentVersion(): number {
    return this.currentVersion;
  }

  migrate(data: unknown, fromVersion: number, targetVersion: number = this.currentVersion): unknown {
    let current = data;
    let version = fromVersion;

    while (version < targetVersion) {
      const fn = this.migrations.get(version);
      if (!fn) {
        version++;
        continue;
      }
      try {
        current = fn(current);
      } catch (e) {
        log.warn("DownDraft", `Migration v${version}→v${version + 1} failed: ${e}`);
      }
      version++;
    }

    return current;
  }

  hasMigration(fromVersion: number): boolean {
    return this.migrations.has(fromVersion);
  }
}
