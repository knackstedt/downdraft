// ============================================================================
// store.ts — UI-side mirror of daemon state + view state. Refreshes through
// daemon RPCs and daemon push events; pages re-render on notify().
// ============================================================================

import type { DaemonStatus, JobInfo, Plan, Repository, SnapshotInfo, SyncJob, Target } from "./protocol";

export type ModalKind = "new-repo" | "new-plan" | "restore" | "unlock-repo" | "new-remote";

export interface RemoteTypeDef {
  type: string;
  label: string;
  oauth: boolean;
  params: { key: string; label: string; secret: boolean; optional?: boolean }[];
}

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

  /** Snapshots for the plan selected on the Snapshots page. */
  snapshots: SnapshotInfo[] = [];
  snapshotsPlanId: string | null = null;
  snapshotsLoading = false;
  selectedSnapIdx = 0;

  /** Modal + form state: which dialog is open, and the current field values
   *  (kit input onChange writes here; submit handlers read it). */
  modal: ModalKind | null = null;
  modalPayload: Record<string, string> = {};
  form: Record<string, string> = {};
  formError: string | null = null;
  busy = false;

  /** Add-remote wizard: type catalog + OAuth progress. */
  remoteTypes: RemoteTypeDef[] = [];
  authState: { flowId: number; state: "waiting" | "done"; token?: string } | null = null;
  /** Cached per-remote free-space readouts from target.about. */
  about: Record<string, { total?: number; used?: number; free?: number } | "error"> = {};

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
