// ============================================================================
// artifacts.ts — import profiler artifacts produced by external tools:
//   .cpuprofile (V8/Chrome CPU profile JSON)
//   .heapsnapshot (V8 heap snapshot)
//   JSC heap snapshot (bun:jsc generateHeapSnapshotForDebugging JSON)
//   Chrome trace-event JSON ({traceEvents:[...]} or bare array)
//   folded stacks (speedscope / perf script folded format)
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { createLogger } from "@downdraft/engine/util/logger";
import type { CpuProfile, HeapSnapshotInfo, HeapClassRow, NetworkEvent } from "./model";

const _log = createLogger();

export type ArtifactKind = "cpuprofile" | "heapsnapshot" | "jsc-heap" | "trace" | "folded" | "unknown";

export function detectArtifact(path: string, content?: string): ArtifactKind {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".cpuprofile")) return "cpuprofile";
  if (name.endsWith(".heapsnapshot")) return "heapsnapshot";
  if (name.endsWith(".folded") || name.endsWith(".folded.txt")) return "folded";
  const head = (content ?? (existsSync(path) ? readFileSync(path, "utf8").slice(0, 2048) : "")).trimStart();
  if (head.startsWith("{")) {
    try {
      const j = JSON.parse(existsSync(path) ? readFileSync(path, "utf8") : content!) as Record<string, unknown>;
      if (Array.isArray(j.nodes) && Array.isArray(j.samples)) return "cpuprofile";
      if (Array.isArray(j.traceEvents)) return "trace";
      if (j.snapshot && Array.isArray(j.nodes)) return "heapsnapshot";
      // JSC heap snapshot: {version, nodes: [..]} with nodeTypeNames — or the
      // {nodes, nodeConnections...} debugging format.
      if (j.nodes && (j.nodeConnections || j.nodeTypes || j.version)) return "jsc-heap";
    } catch { /* fall through */ }
  }
  if (head.startsWith("[")) return "trace";
  return "unknown";
}

export interface ImportedArtifact {
  kind: ArtifactKind;
  profile?: CpuProfile;
  heap?: HeapSnapshotInfo;
  network?: NetworkEvent[];
  summary: string;
}

export function importArtifact(path: string): ImportedArtifact {
  const raw = readFileSync(path, "utf8");
  const kind = detectArtifact(path, raw);
  switch (kind) {
    case "cpuprofile": return { kind, profile: parseCpuProfile(JSON.parse(raw)), summary: `cpuprofile ${basename(path)}` };
    case "heapsnapshot": return { kind, heap: parseV8Heap(JSON.parse(raw)), summary: `heapsnapshot ${basename(path)}` };
    case "jsc-heap": return { kind, heap: parseJscHeap(JSON.parse(raw)), summary: `jsc heap ${basename(path)}` };
    case "trace": {
      const ev = JSON.parse(raw);
      const list = Array.isArray(ev) ? ev : ev.traceEvents ?? [];
      return { kind, network: parseTraceNetwork(list), summary: `trace ${basename(path)} (${list.length} events)` };
    }
    case "folded": return { kind, profile: parseFolded(raw), summary: `folded stacks ${basename(path)}` };
    default: return { kind: "unknown", summary: `unrecognized artifact ${basename(path)}` };
  }
}

// ── V8/Chrome CPU profile ──

function parseCpuProfile(j: { nodes?: { id: number; callFrame?: { functionName?: string; url?: string; lineNumber?: number }; hitCount?: number; children?: number[] }[]; startTime?: number; endTime?: number; samples?: number[]; timeDeltas?: number[] }): CpuProfile {
  return {
    nodes: (j.nodes ?? []).map((n) => ({
      id: n.id,
      functionName: n.callFrame?.functionName ?? "?",
      url: n.callFrame?.url ?? "", line: n.callFrame?.lineNumber ?? 0,
      hitCount: n.hitCount ?? 0, children: n.children ?? [],
    })),
    startUs: j.startTime ?? 0, endUs: j.endTime ?? 0,
    samples: j.samples ?? [], timeDeltasUs: j.timeDeltas ?? [],
    source: "artifact",
  };
}

// ── V8 heap snapshot → constructor summary ──

function parseV8Heap(j: {
  snapshot?: { meta?: { node_fields?: string[] }; node_count?: number };
  nodes?: number[];
  node_types?: string[][];
  strings?: string[];
}): HeapSnapshotInfo {
  const meta = j.snapshot?.meta;
  const fields = meta?.node_fields ?? ["type", "name", "id", "self_size", "edge_count", "trace_node_id"];
  const stride = fields.length;
  const nameIdx = fields.indexOf("name");
  const sizeIdx = fields.indexOf("self_size");
  const nodes = j.nodes ?? [];
  const strings = j.strings ?? [];
  const classes = new Map<string, HeapClassRow>();
  let total = 0;
  const count = Math.floor(nodes.length / stride);
  for (let i = 0; i < count; i++) {
    const name = strings[nodes[i * stride + nameIdx]!] ?? "?";
    const size = nodes[i * stride + sizeIdx] ?? 0;
    total += size;
    let row = classes.get(name);
    if (!row) { row = { name, count: 0, shallow: 0 }; classes.set(name, row); }
    row.count++; row.shallow += size;
  }
  const top = [...classes.values()].sort((a, b) => b.shallow - a.shallow).slice(0, 400);
  return {
    format: "v8", totalBytes: total, objectCount: count, takenAt: Date.now(),
    classes: top,
  };
}

// ── JSC heap snapshot (bun:jsc generateHeapSnapshotForDebugging) ──

function parseJscHeap(j: {
  nodes?: number[];
  nodeTypes?: Record<string, number> | string[];
  nodeClassNames?: Record<string, number> | string[];
  strings?: string[];
  version?: number;
  nodeConnections?: { from: number; to: number; type: string; data: number }[];
}): HeapSnapshotInfo {
  // JSC debugging format: nodes are {id,size,classNameIdx,typeIdx,internal}
  // serialized as arrays of 5 u32; nodeTypes/nodeClassNames are name tables.
  const classes = new Map<string, HeapClassRow>();
  let total = 0, count = 0;
  const classNames: string[] = Array.isArray(j.nodeClassNames) ? j.nodeClassNames
    : j.nodeClassNames ? Object.keys(j.nodeClassNames) : [];

  const nodes = j.nodes ?? [];
  // Nodes may be flat u32 arrays of 5 or objects.
  if (nodes.length && typeof nodes[0] === "number") {
    for (let i = 0; i + 4 < nodes.length; i += 5) {
      const classIdx = nodes[i + 2] ?? 0;
      const size = nodes[i + 1] ?? 0;
      const name = classNames[classIdx] ?? `class-${classIdx}`;
      total += size; count++;
      let row = classes.get(name);
      if (!row) { row = { name, count: 0, shallow: 0 }; classes.set(name, row); }
      row.count++; row.shallow += size;
    }
  } else if (Array.isArray(nodes)) {
    (nodes as { size?: number; className?: string; type?: string }[]).forEach((n) => {
      const name = n.className ?? n.type ?? "?";
      const size = n.size ?? 0;
      total += size; count++;
      let row = classes.get(name);
      if (!row) { row = { name, count: 0, shallow: 0 }; classes.set(name, row); }
      row.count++; row.shallow += size;
    });
  }
  const top = [...classes.values()].sort((a, b) => b.shallow - a.shallow).slice(0, 400);
  return {
    format: "jsc", totalBytes: total, objectCount: count, takenAt: Date.now(),
    classes: top,
  };
}

// ── Trace events → network-ish rows ──

function parseTraceNetwork(list: { cat?: string; name?: string; ph?: string; ts?: number; dur?: number; args?: Record<string, unknown>; pid?: number; tid?: number }[]): NetworkEvent[] {
  const out: NetworkEvent[] = [];
  list.forEach((e, i) => {
    if (e.ph === "X" && (e.cat?.includes("net") || e.name?.match(/request|fetch|http/i))) {
      out.push({
        id: `trace-${i}`, ts: (e.ts ?? 0) / 1e6, method: "GET",
        url: String(e.args?.url ?? e.name ?? ""),
        durationMs: (e.dur ?? 0) / 1000, finished: true, protocol: "trace",
      });
    }
  });
  return out;
}

// ── Folded stacks (perf script / speedscope) → synthetic profile tree ──

function parseFolded(raw: string): CpuProfile {
  const nodes: CpuProfile["nodes"] = [{ id: 0, functionName: "root", url: "", line: 0, hitCount: 0, children: [] }];
  const byPath = new Map<string, number>();
  byPath.set("", 0);
  raw.split("\n").forEach((line) => {
    const m = line.match(/^(.*)\s+(\d+(?:\.\d+)?)\s*$/);
    if (!m) return;
    const frames = m[1]!.split(";").filter(Boolean);
    const count = Number(m[2]);
    let path = "";
    let parentId = 0;
    frames.forEach((frame) => {
      path += `/${frame}`;
      let id = byPath.get(path);
      if (id === undefined) {
        id = nodes.length;
        byPath.set(path, id);
        const fn = frame.replace(/ \(.*\)$/, "");
        const loc = frame.match(/\((.*):(\d+)\)/);
        nodes.push({
          id, functionName: fn || "?", url: loc?.[1] ?? "", line: Number(loc?.[2] ?? 0),
          hitCount: 0, children: [],
        });
        nodes[parentId]!.children.push(id);
      }
      nodes[id]!.hitCount += count;
      parentId = id;
    });
    nodes[0]!.hitCount += count;
  });
  return {
    nodes, startUs: 0, endUs: nodes[0]!.hitCount, samples: [], timeDeltasUs: [],
    source: "artifact",
  };
}
