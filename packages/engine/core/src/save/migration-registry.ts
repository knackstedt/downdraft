// ============================================================================
// Migration Registry — per-component schema versioning with chain walking
// ============================================================================

import { createLogger } from "../util/logger";
import type { ComponentMigration, IMigrationRegistry } from "./persist-types";

const log = createLogger();

interface ComponentEntry {
  currentVersion: number;
  migrations: Map<number, ComponentMigration>; // keyed by fromVersion
}

export class MigrationRegistryImpl implements IMigrationRegistry {
  private components: Map<string, ComponentEntry> = new Map();

  setCurrentVersion(component: string, version: number): void {
    let entry = this.components.get(component);
    if (!entry) {
      entry = { currentVersion: version, migrations: new Map() };
      this.components.set(component, entry);
    } else {
      entry.currentVersion = version;
    }
  }

  getLatestVersion(component: string): number {
    return this.components.get(component)?.currentVersion ?? 1;
  }

  register(component: string, migration: ComponentMigration): void {
    let entry = this.components.get(component);
    if (!entry) {
      entry = { currentVersion: migration.toVersion, migrations: new Map() };
      this.components.set(component, entry);
    }
    if (migration.toVersion > entry.currentVersion) {
      entry.currentVersion = migration.toVersion;
    }
    entry.migrations.set(migration.fromVersion, migration);
  }

  migrate(
    component: string,
    data: unknown,
    fromVersion: number,
  ): { data: unknown; version: number } | null {
    const entry = this.components.get(component);
    if (!entry) {
      if (fromVersion === 1) return { data, version: 1 };
      log.warn("MigrationRegistry", `Unknown component "${component}" with version ${fromVersion}`);
      return null;
    }

    if (fromVersion === entry.currentVersion) {
      return { data, version: entry.currentVersion };
    }

    if (fromVersion > entry.currentVersion) {
      log.warn(
        "MigrationRegistry",
        `Component "${component}" save version ${fromVersion} > current ${entry.currentVersion} — forward incompatible`,
      );
      return null;
    }

    let current = data;
    let version = fromVersion;

    while (version < entry.currentVersion) {
      const step = entry.migrations.get(version);
      if (!step) {
        log.warn(
          "MigrationRegistry",
          `Missing migration for "${component}" v${version}→v${version + 1} — marking as abandoned`,
        );
        return null;
      }
      try {
        current = step.migrate(current);
        version = step.toVersion;
      } catch (e) {
        log.warn(
          "MigrationRegistry",
          `Migration failed for "${component}" v${version}→v${step.toVersion}: ${e}`,
        );
        return null;
      }
    }

    return { data: current, version: entry.currentVersion };
  }
}
