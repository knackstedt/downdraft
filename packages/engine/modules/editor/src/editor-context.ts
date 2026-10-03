// ============================================================================
// EditorContext — the editor's backend object.
//
// Composes an `EngineContext` (the standalone editing world from
// `@downdraft/engine/mcp`: World + Scene + GameWorld + Hierarchy +
// AssetManager + MaterialLibrary + CheckpointManager + SaveSystem +
// UndoRedoManager) with editor session state: the `EditorDocument`,
// `SelectionModel`, `EditorCommandRegistry`, and filesystem access.
//
// Design-document mode (Phase 0–5): the EngineContext is standalone — the
// editor owns a private World/Scene on the main thread and the game's
// renderer maps entities to visuals via an `EditorSceneAdapter`.
// Live-sim mode (Phase 6) swaps in `EngineContext.fromGame()` backed by the
// game's world — the command layer above doesn't change.
// ============================================================================

import type { Entity } from "@downdraft/engine";
import { EngineContext } from "@downdraft/engine/mcp";

import { EditorCommandRegistry } from "./commands/registry";
import { EditorDocument } from "./document";
import { SelectionModel } from "./selection";

// ── Filesystem abstraction ──
// The editor runs in the JS runtime process (Bun/Node/Deno), so `node:fs`
// covers all hosts — but it is lazy-imported so the module stays loadable in
// non-node test contexts. `createNodeFs()` resolves at call time.

export interface EditorFs {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export function createNodeFs(): EditorFs {
  return {
    async readText(path: string): Promise<string> {
      const fs = await import("node:fs/promises");
      return fs.readFile(path, "utf8");
    },
    async writeText(path: string, text: string): Promise<void> {
      const fs = await import("node:fs/promises");
      await fs.writeFile(path, text, "utf8");
    },
    async exists(path: string): Promise<boolean> {
      const fs = await import("node:fs/promises");
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ── Scene adapter (game-provided visual bridge) ──
// The design world is pure ECS data; the adapter maps entities to whatever
// the game uses to draw them (ModelRenderer, custom passes). Phase 0 is
// headless — no adapter is required. Phase 1 ships the generic adapter.

export interface EditorRay {
  origin: [number, number, number];
  dir: [number, number, number];
}

export interface EditorSceneAdapter {
  /** Push an entity's visual state to the renderer (spawn/update). */
  syncEntity?(entityKey: string): void;
  /** Remove an entity's visual. */
  removeEntity?(entityKey: string): void;
  /**
   * Pick: screen-space pointer position → entity key, or null. The adapter
   * owns the camera, so it computes the world ray itself.
   */
  pickAt?(x: number, y: number, w: number, h: number): string | null;
  /** World-space bounds for framing/marquee/outline. */
  bounds?(entityKey: string): { min: [number, number, number]; max: [number, number, number] } | null;
}

export interface EditorContextOptions {
  /** Provide a pre-built EngineContext (e.g. `EngineContext.fromGame()` for
   *  live-world editing). When omitted a standalone design world is created. */
  engine?: EngineContext;
  sceneName?: string;
  fs?: EditorFs | null;
  adapter?: EditorSceneAdapter;
}

export class EditorContext {
  readonly engine: EngineContext;
  readonly document: EditorDocument;
  readonly selection: SelectionModel;
  readonly commands: EditorCommandRegistry;
  readonly fs: EditorFs | null;
  adapter: EditorSceneAdapter | null;
  /**
   * Entity key produced by the most recent `entity.restore` — lets
   * `hierarchy.setParentToRestore` in the same undo batch re-parent
   * children to the restored (new) key. Internal; not for public use.
   */
  lastRestoredKey: string | null = null;
  /**
   * Entity keys are physical ("index.generation") — despawn frees the slot
   * and respawn yields a different key. `entity.restore` registers an
   * alias oldKey→newKey here so journaled inverses and params carrying a
   * stale key keep resolving (redo after an undo-remove relies on this).
   */
  private keyAliases = new Map<string, string>();
  /** Component name the transform commands read/write. Games with a
   *  differently-named transform component can override via module config. */
  transformComponent = "transform";

  constructor(opts: EditorContextOptions = {}) {
    this.engine = opts.engine ?? new EngineContext({ sceneName: opts.sceneName ?? "editor-scene" });
    this.document = new EditorDocument(this.engine.scene, opts.sceneName ?? this.engine.scene.name);
    this.selection = new SelectionModel();
    this.commands = new EditorCommandRegistry(this);
    this.fs = opts.fs === undefined ? createNodeFs() : opts.fs;
    this.adapter = opts.adapter ?? null;

    // Document dirty tracking: any applied mutating command dirties the doc
    // unless it opts out via `marksDirty: false` — file-state commands
    // (scene.save/open/new) call markClean themselves, and auto-dirtying
    // after dispatch would stomp the clean flag.
    this.commands.onDispatched((entry) => {
      const cmd = this.commands.get(entry.command);
      if (cmd?.mutating && cmd.marksDirty !== false) {
        this.document.markDirty({ kind: "data", entity: entry.params["entity"] as string | undefined });
      }
    });
  }

  // ── Entity helpers (delegate to engine + document) ──

  key(entity: Entity): string {
    return this.document.key(entity);
  }

  /** Follow the restore-alias chain for a possibly stale entity key. */
  resolveKey(key: string): string {
    let k = key;
    const seen = new Set<string>();
    while (this.keyAliases.has(k) && !seen.has(k)) {
      seen.add(k);
      k = this.keyAliases.get(k)!;
    }
    return k;
  }

  /** Record that oldKey now refers to newKey (entity restored under a new id). */
  registerKeyAlias(oldKey: string, newKey: string): void {
    if (oldKey !== newKey) this.keyAliases.set(oldKey, newKey);
  }

  clearKeyAliases(): void {
    this.keyAliases.clear();
  }

  parseEntity(key: string): Entity | null {
    return this.document.parse(this.resolveKey(key));
  }

  isAliveKey(key: string): boolean {
    return this.document.isAliveKey(this.resolveKey(key));
  }

  dispose(): void {
    // No timers/subscriptions held yet — placeholder for adapter teardown,
    // autosave timers, and the UI shell.
  }
}
