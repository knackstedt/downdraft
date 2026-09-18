import { watch, type FSWatcher } from "fs";
import { createLogger } from "../util/logger";
import type { ScriptingSystem } from "./script";

const log = createLogger();

type CleanupFn = () => void;

interface WatchEntry {
  watcher: FSWatcher | null;
  path: string;
  onReload?: (path: string) => void;
  cleanups: CleanupFn[];
  lastReload: number;
  debounceMs: number;
}

export class HotReloader {
  private scripting: ScriptingSystem;
  private entries: Map<string, WatchEntry> = new Map();
  private globalCleanups: CleanupFn[] = [];
  private enabled: boolean = true;

  constructor(scripting: ScriptingSystem) {
    this.scripting = scripting;
  }

  watch(name: string, path: string, onReload?: (path: string) => void): void {
    const entry: WatchEntry = {
      watcher: null,
      path,
      onReload,
      cleanups: [],
      lastReload: 0,
      debounceMs: 100,
    };

    try {
      entry.watcher = watch(path, (eventType) => {
        if (eventType !== "change") return;
        if (!this.enabled) return;
        const now = Date.now();
        if (now - entry.lastReload < entry.debounceMs) return;
        entry.lastReload = now;
        this.reloadScript(name, path);
      });
    } catch {
      entry.watcher = null;
    }

    this.entries.set(name, entry);
  }

  registerCleanup(name: string, fn: CleanupFn): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.cleanups.push(fn);
    }
  }

  registerGlobalCleanup(fn: CleanupFn): void {
    this.globalCleanups.push(fn);
  }

  private async reloadScript(name: string, path: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;

    for (let i = entry.cleanups.length - 1; i >= 0; i--) {
      try {
        entry.cleanups[i]();
      } catch (err) {
        log.error("HotReloader", `Cleanup error for "${name}": ${err}`);
      }
    }
    entry.cleanups = [];

    try {
      await this.scripting.hotReload(name, path);
      if (entry.onReload) entry.onReload(path);
    } catch (err) {
      log.error("HotReloader", `Reload error for "${name}": ${err}`);
    }
  }

  async triggerReload(name: string, path: string): Promise<void> {
    await this.reloadScript(name, path);
  }

  async reloadAll(): Promise<void> {
    for (const [name, entry] of this.entries) {
      await this.reloadScript(name, entry.path);
    }
  }

  unwatch(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;

    for (let i = entry.cleanups.length - 1; i >= 0; i--) {
      try {
        entry.cleanups[i]();
      } catch {
        // ignore
      }
    }

    if (entry.watcher) {
      try {
        entry.watcher.close();
      } catch {
        // ignore
      }
    }

    this.entries.delete(name);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getWatchedScripts(): string[] {
    return [...this.entries.keys()];
  }

  dispose(): void {
    for (const name of this.entries.keys()) {
      this.unwatch(name);
    }
    for (let i = this.globalCleanups.length - 1; i >= 0; i--) {
      try {
        this.globalCleanups[i]();
      } catch {
        // ignore
      }
    }
    this.globalCleanups = [];
  }
}
