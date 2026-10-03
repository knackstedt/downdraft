// ============================================================================
// EditorCommandRegistry — the single mutation path for the editor.
//
// Every editor operation is a registered `EditorCommand`. The Blitz UI, the
// generated `editor_*` MCP tools, the undo journal, and (later) network
// replication all dispatch through this one registry — a command invoked by a
// human click and by an agent call are the same code path.
//
// Journal model:
//   - `apply` returns a `CommandOutcome` carrying `inverse` — an array of
//     `CommandInvocation`s that fully reverts the mutation. Inverses are plain
//     data (command id + params), so the journal is serializable, diffable,
//     and observable by agents (`editor_journal`).
//   - Mutating commands with an inverse push onto the undo stack; undo
//     re-dispatches the inverse (source "undo" — journaled to the event log
//     but not re-stacked); redo re-dispatches the original invocation.
//   - Non-mutating commands (reads, selection) land in the event log only.
// ============================================================================

import { createLogger } from "@downdraft/engine";
import type { EditorContext } from "../editor-context";

const log = createLogger();

export type EditorCommandSource = "ui" | "mcp" | "internal" | "net" | "undo" | "redo";

/** A replayable invocation — the journal stores these, never closures. */
export interface CommandInvocation {
  command: string;
  params: Record<string, unknown>;
}

export interface CommandOutcome<R = unknown> {
  /** The value returned to the caller (and surfaced via MCP). */
  value: R;
  /**
   * Invocations that revert this mutation, in order. Absent for
   * non-mutating commands and for irreversible mutations (documented on the
   * command itself — those still journal, but cannot be undone).
   */
  inverse?: CommandInvocation[];
  /** Human/agent-readable description, e.g. `Spawn entity "crate"`. */
  description?: string;
}

export interface EditorParamSchema {
  type: "object";
  properties: Record<string, {
    type: "string" | "number" | "integer" | "boolean" | "object" | "array";
    description?: string;
    items?: { type: string };
    default?: unknown;
  }>;
  required?: string[];
}

export interface EditorCommand<P extends Record<string, unknown> = Record<string, unknown>, R = unknown> {
  /** Dotted id — "entity.spawn", "transform.set". MCP tool names derive
   *  from it (`editor_entity_spawn`). */
  id: string;
  /** Human-readable label for journals/menus. */
  title: string;
  /**
   * True when the command mutates the document. Mutating commands push to
   * the undo stack when they return an `inverse`. Read-only commands are
   * journaled to the event log only.
   */
  mutating: boolean;
  /**
   * Defaults to `mutating`. Set `false` on commands that manage the
   * document's file state themselves (scene.save/open/new) so dispatch
   * doesn't re-dirty the doc after their own markClean.
   */
  marksDirty?: boolean;
  params?: EditorParamSchema;
  apply(ctx: EditorContext, params: P): CommandOutcome<R> | Promise<CommandOutcome<R>>;
}

export interface JournalEntry {
  seq: number;
  command: string;
  params: Record<string, unknown>;
  inverse: CommandInvocation[] | null;
  result: unknown;
  source: EditorCommandSource;
  description: string;
  at: number;
  /**
   * Set on transaction entries: the forward invocations that produced the
   * batch, replayed by redo() (a batch's `command` is "__transaction__").
   */
  replays?: CommandInvocation[];
}

export class EditorCommandError extends Error {}

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

export class EditorCommandRegistry {
  private ctx: EditorContext;
  private commands = new Map<string, EditorCommand>();
  private undoStack: JournalEntry[] = [];
  private redoStack: JournalEntry[] = [];
  private eventLog: JournalEntry[] = [];
  private seq = 0;
  private maxUndo = 100;
  private maxEvents = 500;
  private listeners = new Set<(entry: JournalEntry) => void>();
  /** Open transaction: member entries buffer here until endTransaction. */
  private txn: { label: string; source: EditorCommandSource; members: JournalEntry[] } | null = null;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
  }

  register(cmd: EditorCommand): void {
    if (this.commands.has(cmd.id)) {
      throw new EditorCommandError(`Duplicate editor command: ${cmd.id}`);
    }
    this.commands.set(cmd.id, cmd);
  }

  registerAll(cmds: EditorCommand[]): void {
    cmds.forEach((c) => this.register(c));
  }

  get(id: string): EditorCommand | undefined {
    return this.commands.get(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  list(): EditorCommand[] {
    return [...this.commands.values()];
  }

  /** Subscribe to every dispatched command (applied or journaled). */
  onDispatched(fn: (entry: JournalEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Validate `params` against the command's declared schema. Only `required`
   * presence and declared primitive types are checked — nested object shapes
   * are passed through (component payloads are open-ended by design).
   */
  private validate(cmd: EditorCommand, params: Record<string, unknown>): Record<string, unknown> {
    const schema = cmd.params;
    if (!schema) return params;
    const required = schema.required ?? [];
    required.forEach((key) => {
      if (params[key] === undefined || params[key] === null) {
        throw new EditorCommandError(`${cmd.id}: missing required param "${key}"`);
      }
    });
    for (const [key, spec] of Object.entries(schema.properties)) {
      const v = params[key];
      if (v === undefined || v === null) continue;
      if (!JSON_SCHEMA_TYPES.has(spec.type)) continue;
      const t = spec.type;
      const ok =
        (t === "string" && typeof v === "string") ||
        (t === "boolean" && typeof v === "boolean") ||
        (t === "number" && typeof v === "number") ||
        (t === "integer" && typeof v === "number" && Number.isInteger(v)) ||
        (t === "array" && Array.isArray(v)) ||
        (t === "object" && typeof v === "object" && !Array.isArray(v));
      if (!ok) {
        throw new EditorCommandError(
          `${cmd.id}: param "${key}" expected ${t}, got ${Array.isArray(v) ? "array" : typeof v}`,
        );
      }
    }
    return params;
  }

  /**
   * Dispatch a command. Returns the command's `value`. Mutating commands
   * with inverses push onto the undo stack (unless dispatched as an undo
   * step). Every dispatch lands in the event log regardless.
   */
  async dispatch(
    commandId: string,
    params: Record<string, unknown> = {},
    source: EditorCommandSource = "internal",
  ): Promise<unknown> {
    const cmd = this.commands.get(commandId);
    if (!cmd) throw new EditorCommandError(`Unknown editor command: ${commandId}`);

    const validated = this.validate(cmd, params);
    let outcome: CommandOutcome;
    try {
      outcome = await cmd.apply(this.ctx, validated);
    } catch (e) {
      const msg = `${commandId} failed: ${e instanceof Error ? e.message : String(e)}`;
      log.error("EditorCommands", msg);
      throw new EditorCommandError(msg);
    }

    const entry: JournalEntry = {
      seq: ++this.seq,
      command: commandId,
      params: validated,
      inverse: outcome.inverse ?? null,
      result: outcome.value,
      source,
      description: outcome.description ?? `${cmd.title} (${commandId})`,
      at: Date.now(),
    };
    this.recordEvent(entry);

    const isReplay = source === "undo" || source === "redo";
    if (this.txn && cmd.mutating) {
      // Inside a transaction: journal the member to the event log but hold
      // it off the undo stack — endTransaction commits one merged entry.
      this.txn.members.push(entry);
    } else if (cmd.mutating && outcome.inverse && source !== "undo") {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    }
    if (!isReplay && cmd.mutating) {
      this.redoStack.length = 0;
    }

    this.emit(entry);
    return outcome.value;
  }

  /**
   * Group a run of mutating dispatches into ONE undo entry. Use for gizmo
   * drags, multi-entity ops, marquee moves — anything where N fine-grained
   * commands should undo as a single gesture. Non-mutating dispatches still
   * land in the event log. Nested transactions are not supported (throws).
   */
  beginTransaction(label: string, source: EditorCommandSource = "internal"): void {
    if (this.txn) throw new EditorCommandError(`Transaction already open: "${this.txn.label}"`);
    this.txn = { label, source, members: [] };
  }

  /** Abort the open transaction — members stay applied, nothing is journaled
   *  to the undo stack (each member's own apply still ran). */
  abortTransaction(): void {
    this.txn = null;
  }

  /** Commit the open transaction as a single undoable journal entry. */
  endTransaction(): void {
    const txn = this.txn;
    this.txn = null;
    if (!txn) return;
    const withInverses = txn.members.filter((m) => m.inverse?.length);
    if (withInverses.length === 0) return;
    const inverse: CommandInvocation[] = [];
    for (let i = withInverses.length - 1; i >= 0; i--) {
      inverse.push(...withInverses[i]!.inverse!);
    }
    const entry: JournalEntry = {
      seq: ++this.seq,
      command: "__transaction__",
      params: {},
      inverse,
      replays: txn.members.map((m) => ({ command: m.command, params: m.params })),
      result: txn.members.at(-1)?.result ?? null,
      source: txn.source,
      description: txn.label,
      at: Date.now(),
    };
    this.recordEvent(entry);
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit(entry);
  }

  get inTransaction(): boolean {
    return this.txn !== null;
  }

  async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    if (entry.inverse) {
      for (let i = 0; i < entry.inverse.length; i++) {
        const inv = entry.inverse[i]!;
        await this.dispatch(inv.command, inv.params, "undo");
      }
    }
    this.redoStack.push(entry);
    return true;
  }

  async redo(): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    if (entry.replays?.length) {
      // Transaction: replay each member's forward invocation.
      for (let i = 0; i < entry.replays.length; i++) {
        await this.dispatch(entry.replays[i]!.command, entry.replays[i]!.params, "redo");
      }
    } else {
      // Re-dispatch the original invocation — it re-journals a fresh inverse.
      await this.dispatch(entry.command, entry.params, "redo");
    }
    return true;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** The undoable journal — newest last. */
  getJournal(): JournalEntry[] { return [...this.undoStack]; }
  getRedoStack(): JournalEntry[] { return [...this.redoStack]; }
  /** Every dispatched command (mutating and read-only), newest last. */
  getEventLog(limit = 100): JournalEntry[] {
    return this.eventLog.slice(-limit);
  }

  private recordEvent(entry: JournalEntry): void {
    this.eventLog.push(entry);
    if (this.eventLog.length > this.maxEvents) this.eventLog.shift();
  }

  private emit(entry: JournalEntry): void {
    this.listeners.forEach((fn) => {
      try { fn(entry); } catch (e) { log.error("EditorCommands", `listener error: ${e}`); }
    });
  }
}
