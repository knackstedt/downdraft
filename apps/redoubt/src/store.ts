// ============================================================================
// store.ts — UI-side mirror of daemon state + view state. Refreshes through
// daemon RPCs and daemon push events; pages re-render on notify().
// ============================================================================

import type { DaemonStatus, JobInfo, Plan, Repository, SyncJob, Target } from "./protocol";

export type PageId = "overview" | "plans" | "targets" | "snapshots" | "sync" | "settings";

export const PAGES: { id: PageId; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "plans", title: "Backup Plans" },
  { id: "targets", title: "Targets" },
  { id: "snapshots", title: "Snapshots" },
  { id: "sync", title: "Sync" },
  { id: "settings", title: "Settings" },
];

type Listener = () => void;

class UiStore {
  page: PageId = "overview";
  daemonConnected = false;
  status: DaemonStatus | null = null;
  plans: Plan[] = [];
  repositories: Repository[] = [];
  targets: Target[] = [];
  syncs: SyncJob[] = [];
  jobs: JobInfo[] = [];
  lastError: string | null = null;

  private listeners: Listener[] = [];

  subscribe(cb: Listener): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }

  notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const store = new UiStore();
