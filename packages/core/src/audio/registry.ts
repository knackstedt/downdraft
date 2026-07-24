import type { AudioBackend } from "./interface.ts";

class AudioBackendRegistry {
  private backends: Map<string, AudioBackend> = new Map();
  private defaultBackend: AudioBackend | null = null;

  register(name: string, backend: AudioBackend): void {
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

  get(name: string): AudioBackend | undefined {
    return this.backends.get(name);
  }

  getDefault(): AudioBackend | null {
    return this.defaultBackend;
  }

  setDefault(name: string): void {
    const backend = this.backends.get(name);
    if (!backend) throw new Error(`Audio backend "${name}" not registered`);
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

export const audioBackendRegistry = new AudioBackendRegistry();
