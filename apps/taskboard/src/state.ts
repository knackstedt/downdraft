// ============================================================================
// state.ts — Task Board data model + store.
//
// Plain in-memory store with a subscribe() surface and persistence through
// the host settings bridge (<configDir>/settings.json) — debounced so rapid
// card edits collapse into one write.
// ============================================================================

import { downdraft } from "@downdraft/engine/app/main";

export type ColumnId = "backlog" | "doing" | "review" | "done";
export type Priority = "low" | "med" | "high";

export const COLUMNS: { id: ColumnId; title: string; hint: string }[] = [
  { id: "backlog", title: "Backlog", hint: "Not started" },
  { id: "doing", title: "In Progress", hint: "Actively worked" },
  { id: "review", title: "Review", hint: "Needs a second pair of eyes" },
  { id: "done", title: "Done", hint: "Shipped" },
];

export const ASSIGNEES = ["Unassigned", "Ada", "Bjarne", "Grace", "Linus", "Margaret"];

export interface Subtask { title: string; done: boolean }

export interface Task {
  id: string;
  title: string;
  desc: string;
  column: ColumnId;
  priority: Priority;
  assignee: string;
  points: number;
  /** 0-100 — drives the card progress bar. */
  progress: number;
  tags: string[];
  subtasks: Subtask[];
  created: number;
  /** Manual ordering within the "created" sort — conventionally -created
   *  (newest first); drag-drops stamp a fractional midpoint between the
   *  target neighbors so no reindexing pass is needed. */
  ord?: number;
}

export interface ActivityEntry { at: number; text: string }

const SETTINGS_KEY = "taskboard.board.v1";
const seedBase = Date.now() - 14 * 86_400_000;

const SEED: Task[] = [
  { id: "t-101", title: "Draft render pipeline RFC", desc: "Write the proposal for the tile-based forward+ path, including memory budget tables.", column: "done", priority: "high", assignee: "Grace", points: 5, progress: 100, tags: ["docs", "render"], subtasks: [{ title: "Outline", done: true }, { title: "Peer review", done: true }], created: seedBase },
  { id: "t-102", title: "Port asset importer to Rust worker", desc: "Move glTF decode off the render thread into the asset worker.", column: "done", priority: "med", assignee: "Bjarne", points: 8, progress: 100, tags: ["assets"], subtasks: [], created: seedBase + 1 },
  { id: "t-103", title: "Kit gallery app shell", desc: "Tab bar + page container that hosts every showcase screen.", column: "done", priority: "med", assignee: "Ada", points: 3, progress: 100, tags: ["ui"], subtasks: [], created: seedBase + 2 },
  { id: "t-104", title: "Kanban board interactions", desc: "Card open, context-menu moves, column reorder buttons, search filter.", column: "doing", priority: "high", assignee: "Ada", points: 5, progress: 70, tags: ["ui", "kanban"], subtasks: [{ title: "Card markup", done: true }, { title: "Context menu", done: true }, { title: "Search filter", done: false }], created: seedBase + 3 },
  { id: "t-105", title: "WebGPU surface inside scroll area", desc: "Composite an offscreen WebGPU-rendered texture inside a Blitz .dd-scroll region, clipped to the viewport.", column: "doing", priority: "high", assignee: "Margaret", points: 8, progress: 55, tags: ["gpu", "ui"], subtasks: [{ title: "Cube pass", done: true }, { title: "Rect tracking", done: true }, { title: "Scroll clip", done: false }], created: seedBase + 4 },
  { id: "t-106", title: "Widget gallery page", desc: "One scroll page that mounts every standard kit widget with live bindings.", column: "doing", priority: "med", assignee: "Linus", points: 5, progress: 40, tags: ["ui", "gallery"], subtasks: [], created: seedBase + 5 },
  { id: "t-107", title: "Dashboard metrics page", desc: "Per-column progress, assignee table, activity feed, milestone accordion.", column: "review", priority: "med", assignee: "Grace", points: 3, progress: 85, tags: ["ui"], subtasks: [{ title: "Layout", done: true }, { title: "Data wiring", done: false }], created: seedBase + 6 },
  { id: "t-108", title: "Settings persistence", desc: "Board state + preferences roundtrip through downdraft.settings.", column: "review", priority: "low", assignee: "Bjarne", points: 2, progress: 90, tags: ["platform"], subtasks: [], created: seedBase + 7 },
  { id: "t-109", title: "Command palette", desc: "Ctrl+K palette over kit:cmdk with app commands.", column: "review", priority: "low", assignee: "Ada", points: 2, progress: 80, tags: ["ui"], subtasks: [], created: seedBase + 8 },
  { id: "t-110", title: "TV / 10-foot mode", desc: "Couch UI page: shelves, media cards, blade, detail hero, settings rows.", column: "backlog", priority: "med", assignee: "Linus", points: 5, progress: 10, tags: ["ui", "tv"], subtasks: [{ title: "Shelf layout", done: false }, { title: "Nav zones", done: false }], created: seedBase + 9 },
  { id: "t-111", title: "Menu model + in-window fallback", desc: "Full AppMenuModel with accelerators; kit menuBar when backend is inwindow.", column: "backlog", priority: "med", assignee: "Grace", points: 3, progress: 20, tags: ["platform"], subtasks: [], created: seedBase + 10 },
  { id: "t-112", title: "Tray + notifications", desc: "Tray icon with board summary menu; OS notifications on card moves.", column: "backlog", priority: "low", assignee: "Unassigned", points: 2, progress: 0, tags: ["platform"], subtasks: [], created: seedBase + 11 },
  { id: "t-113", title: "Import / export board JSON", desc: "Save/open dialogs round-tripping the board document.", column: "backlog", priority: "low", assignee: "Bjarne", points: 3, progress: 0, tags: ["platform", "io"], subtasks: [], created: seedBase + 12 },
  { id: "t-114", title: "Accessibility pass on kit", desc: "Audit focus rings + nav zones across the gallery.", column: "backlog", priority: "med", assignee: "Margaret", points: 5, progress: 0, tags: ["ui", "a11y"], subtasks: [], created: seedBase + 13 },
];

export interface BoardPrefs {
  compact: boolean;
  notifyOnMove: boolean;
  filterAssignee: string; // "All" or an assignee name
  sort: "created" | "priority" | "points";
  vetoArmed: boolean;
}

type Listener = () => void;

class BoardStore {
  tasks: Task[] = [];
  activity: ActivityEntry[] = [];
  prefs: BoardPrefs = {
    compact: false,
    notifyOnMove: true,
    filterAssignee: "All",
    sort: "created",
    vetoArmed: false,
  };
  search = "";
  /** Quick-filter checkboxes in the board sidebar (module-level, not prefs). */
  highOnly = false;
  subtasksOnly = false;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private nextNum = 200;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(): void { this.listeners.forEach((fn) => fn()); }

  log(text: string): void {
    this.activity.unshift({ at: Date.now(), text });
    if (this.activity.length > 40) this.activity.length = 40;
  }

  /** Persist through the settings bridge, debounced. */
  persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        downdraft.settings?.set(SETTINGS_KEY, { tasks: this.tasks, prefs: this.prefs });
      } catch { /* host without settings */ }
    }, 400);
  }

  load(): void {
    let saved: { tasks?: Task[]; prefs?: Partial<BoardPrefs> } | undefined;
    try { saved = downdraft.settings?.get(SETTINGS_KEY); } catch { /* no bridge */ }
    if (saved?.tasks?.length) {
      this.tasks = saved.tasks;
      Object.assign(this.prefs, saved.prefs ?? {});
      const max = Math.max(...this.tasks.map((t) => Number(t.id.split("-")[1]) || 0));
      this.nextNum = max + 1;
      this.log(`Restored ${this.tasks.length} tasks from settings`);
    } else {
      this.tasks = SEED.map((t) => ({ ...t, subtasks: t.subtasks.map((s) => ({ ...s })) }));
      this.log("Seeded starter board");
    }
  }

  get(id: string): Task | undefined { return this.tasks.find((t) => t.id === id); }

  /** Filtered + sorted view of one column. */
  columnTasks(col: ColumnId): Task[] {
    const q = this.search.trim().toLowerCase();
    const pr = { high: 0, med: 1, low: 2 } as const;
    const list = this.tasks.filter((t) => {
      if (t.column !== col) return false;
      if (this.prefs.filterAssignee !== "All" && t.assignee !== this.prefs.filterAssignee) return false;
      if (this.highOnly && t.priority !== "high") return false;
      if (this.subtasksOnly && t.subtasks.length === 0) return false;
      if (q && !`${t.title} ${t.desc} ${t.tags.join(" ")} ${t.assignee}`.toLowerCase().includes(q)) return false;
      return true;
    });
    switch (this.prefs.sort) {
      case "priority": return list.sort((a, b) => pr[a.priority] - pr[b.priority] || b.created - a.created);
      case "points": return list.sort((a, b) => b.points - a.points || b.created - a.created);
      default: return list.sort((a, b) => (a.ord ?? -a.created) - (b.ord ?? -b.created));
    }
  }

  add(t: Omit<Task, "id" | "created">): Task {
    const task: Task = { ...t, id: `t-${this.nextNum++}`, created: Date.now() };
    this.tasks.unshift(task);
    this.log(`Created "${task.title}" in ${task.column}`);
    this.persist(); this.emit();
    return task;
  }

  update(id: string, patch: Partial<Task>): void {
    const t = this.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.persist(); this.emit();
  }

  move(id: string, col: ColumnId, index?: number): void {
    const t = this.get(id);
    if (!t) return;
    const from = t.column;
    if (from === col && index === undefined) return;
    // index = insertion slot among the column's visible tasks EXCLUDING the
    // dragged card; undefined = append to the bottom.
    const list = this.columnTasks(col).filter((x) => x.id !== id);
    const ordOf = (x: Task): number => x.ord ?? -x.created;
    let ord: number;
    if (index === undefined || index >= list.length) {
      ord = list.length ? ordOf(list[list.length - 1]!) + 1 : 0;
    } else if (index <= 0) {
      ord = ordOf(list[0]!) - 1;
    } else {
      ord = (ordOf(list[index - 1]!) + ordOf(list[index]!)) / 2;
    }
    t.column = col;
    t.ord = ord;
    if (col === "done") t.progress = 100;
    this.log(from === col ? `Reordered "${t.title}"` : `Moved "${t.title}" ${from} → ${col}`);
    this.persist(); this.emit();
  }

  remove(id: string): void {
    const t = this.get(id);
    if (!t) return;
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.log(`Deleted "${t.title}"`);
    this.persist(); this.emit();
  }

  importTasks(tasks: Task[]): void {
    this.tasks = tasks;
    this.log(`Imported ${tasks.length} tasks`);
    this.persist(); this.emit();
  }

  stats() {
    const by = (col: ColumnId) => this.tasks.filter((t) => t.column === col);
    const totalPts = this.tasks.reduce((s, t) => s + t.points, 0);
    const donePts = by("done").reduce((s, t) => s + t.points, 0);
    return {
      total: this.tasks.length,
      perColumn: COLUMNS.map((c) => ({ ...c, count: by(c.id).length, points: by(c.id).reduce((s, t) => s + t.points, 0) })),
      totalPts, donePts,
      completion: totalPts ? Math.round((donePts / totalPts) * 100) : 0,
      perAssignee: ASSIGNEES.slice(1).map((a) => {
        const mine = this.tasks.filter((t) => t.assignee === a);
        return { name: a, open: mine.filter((t) => t.column !== "done").length, done: mine.filter((t) => t.column === "done").length };
      }),
    };
  }
}

export const store = new BoardStore();
