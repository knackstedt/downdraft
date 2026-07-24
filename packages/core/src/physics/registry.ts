import type { PhysicsBackend } from "./interface.ts";

class PhysicsBackendRegistry {
  private backends: Map<string, PhysicsBackend> = new Map();
  private defaultBackend: PhysicsBackend | null = null;

  register(name: string, backend: PhysicsBackend): void {
    this.backends.set(name, backend);
    if (!this.defaultBackend) {
      this.defaultBackend = backend;
    }
  }

  unregister(name: string): void {
    const backend = this.backends.get(name);
    if (backend) {
      backend.destroy();
      this.backends.delete(name);
      if (this.defaultBackend === backend) {
        this.defaultBackend = this.backends.values().next().value ?? null;
      }
    }
  }

  get(name: string): PhysicsBackend | undefined {
    return this.backends.get(name);
  }

  getDefault(): PhysicsBackend | null {
    return this.defaultBackend;
  }

  setDefault(name: string): void {
    const backend = this.backends.get(name);
    if (!backend) throw new Error(`Physics backend "${name}" not registered`);
    this.defaultBackend = backend;
  }

  list(): string[] {
    return [...this.backends.keys()];
  }

  destroyAll(): void {
    for (const backend of this.backends.values()) {
      backend.destroy();
    }
    this.backends.clear();
    this.defaultBackend = null;
  }
}

export const physicsBackendRegistry = new PhysicsBackendRegistry();
