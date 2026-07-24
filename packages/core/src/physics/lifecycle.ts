import type { PhysicsBackend, PhysicsRealmConfig } from "./interface.ts";
import { PhysicsRealm } from "./realm.ts";

export type BootstrapPhase = "app-start" | "scene-start" | "on-demand";

interface PendingRealm {
  config: Omit<PhysicsRealmConfig, "id">;
  phase: BootstrapPhase;
  realm: PhysicsRealm | null;
}

export class PhysicsLifecycle {
  private backend: PhysicsBackend;
  private pending: PendingRealm[] = [];
  private realms: Map<number, PhysicsRealm> = new Map();
  private realmNames: Map<string, number> = new Map();

  constructor(backend: PhysicsBackend) {
    this.backend = backend;
  }

  registerRealm(name: string, config: Omit<PhysicsRealmConfig, "id">, phase: BootstrapPhase = "scene-start"): void {
    this.pending.push({ config: { ...config }, phase, realm: null });
  }

  bootstrap(phase: BootstrapPhase): void {
    for (const pending of this.pending) {
      if (pending.phase === phase && pending.realm === null) {
        const realm = new PhysicsRealm(this.backend, pending.config);
        pending.realm = realm;
        this.realms.set(realm.id, realm);
        this.realmNames.set(pending.config.name, realm.id);
      }
    }
  }

  getRealm(id: number): PhysicsRealm | undefined {
    return this.realms.get(id);
  }

  getRealmByName(name: string): PhysicsRealm | undefined {
    const id = this.realmNames.get(name);
    return id !== undefined ? this.realms.get(id) : undefined;
  }

  createRealmNow(config: Omit<PhysicsRealmConfig, "id">): PhysicsRealm {
    const realm = new PhysicsRealm(this.backend, config);
    this.realms.set(realm.id, realm);
    this.realmNames.set(config.name, realm.id);
    return realm;
  }

  destroyRealm(id: number): void {
    const realm = this.realms.get(id);
    if (realm) {
      realm.destroy();
      this.realms.delete(id);
      for (const [name, rid] of this.realmNames) {
        if (rid === id) {
          this.realmNames.delete(name);
          break;
        }
      }
    }
  }

  destroyAll(): void {
    for (const realm of this.realms.values()) {
      realm.destroy();
    }
    this.realms.clear();
    this.realmNames.clear();
    this.pending = [];
  }

  stepAll(dt: number): void {
    this.backend.stepAll(dt);
  }

  getRealmCount(): number {
    return this.realms.size;
  }

  listRealms(): string[] {
    return [...this.realmNames.keys()];
  }
}
