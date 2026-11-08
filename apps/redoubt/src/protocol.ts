// ============================================================================
// protocol.ts — wire types shared with redoubtd (mirror of daemon/src/ipc.rs
// and daemon/src/config.rs serde types). Keep in sync — fields are
// camelCase on the wire.
// ============================================================================

// ── RPC envelope (newline-delimited JSON-RPC 2.0 over the unix socket) ──

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcEvent {
  jsonrpc: "2.0";
  method: string; // "job.progress", "storage.warning", "password.due", …
  params?: unknown;
}

// ── Domain types (mirror config.rs) ──

export interface DaemonStatus {
  version: string;
  pid: number;
  socketPath: string;
  uptimeSec: number;
  kopiaBin: string | null;
  rcloneBin: string | null;
  counts: { plans: number; repositories: number; targets: number; syncs: number };
}

export type ScheduleKind =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "hourly" }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export interface Schedule {
  rule: ScheduleKind;
  onTargetAvailable: boolean;
  onAcOnly: boolean;
}

export interface Retention {
  /** Never expire below this many snapshots for a plan's sources. */
  minCount: number;
  /** Cull snapshots older than this (0/null = keep forever). */
  maxAgeDays: number | null;
}

export interface Repository {
  id: string;
  name: string;
  location: { provider: "filesystem"; path: string } | { provider: "rclone"; remote: string; path: string };
  mirrors: Mirror[];
  createdAt: number;
  lastPasswordVerifiedAt?: number;
}

export interface Mirror {
  id: string;
  location: Repository["location"];
  schedule: Schedule | null;
}

export interface PlanSource {
  path: string;
  excludeProfileId: string;
  extraExcludes: string[];
}

export interface Plan {
  id: string;
  name: string;
  sources: PlanSource[];
  repositoryId: string;
  schedule: Schedule | null;
  retention: Retention;
  enabled: boolean;
  lastRunAt?: number;
}

export interface Target {
  id: string;
  name: string;
  kind: "rclone" | "local";
  /** rclone remote name, or absolute path for kind "local". */
  ref: string;
}

export interface SyncJob {
  id: string;
  name: string;
  localPath: string;
  remote: string;
  direction: "oneway" | "twoway";
  schedule: Schedule | null;
  enabled: boolean;
}

export interface JobInfo {
  id: string;
  kind: string;
  planId?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  result?: { snapshots?: SnapshotInfo[]; [k: string]: unknown };
}

export interface SnapshotInfo {
  id: string;
  source: string;
  host: string;
  user: string;
  startTime: number;
  endTime: number;
  sizeBytes: number;
  fileCount: number;
}
