// ============================================================================
// Cross-thread plugin contract — shared dependency graph across sim + renderer
//
// In a multi-threaded Downdraft game, the sim worker and renderer each have
// their own PluginHost with their own DI graph. Some resources (like SABs)
// are shared across threads — the sim writes, the renderer reads. Cross-thread
// tokens declare these shared resources so both hosts can validate the
// dependency graph and the doctor panel can display the full picture.
//
// A `CrossThreadToken<T>` is a `ResourceToken<T>` with an explicit `thread`
// tag ("sim" | "renderer" | "shared"). The sim host provides sim-thread
// tokens; the renderer host provides renderer-thread tokens; shared tokens
// (like SABs) are provided by both (sim writes, renderer reads).
// ============================================================================

import { resourceToken, type ResourceToken } from "../ecs/resource";

export type ThreadTag = "sim" | "renderer" | "shared";

// ── Cross-thread token ──

/**
 * A ResourceToken with an explicit thread tag. Used by the cross-thread
 * dependency validator and the doctor panel to display which thread provides
 * each resource.
 */
export interface CrossThreadToken<T> extends ResourceToken<T> {
  readonly __thread: ThreadTag;
}

/**
 * Create a cross-thread resource token. The token is a standard ResourceToken
 * (compatible with provide/inject) with an added `__thread` tag for
 * cross-thread validation and diagnostics.
 */
export function crossThreadToken<T>(key: string, thread: ThreadTag): CrossThreadToken<T> {
  const token = resourceToken<T>(key) as CrossThreadToken<T>;
  (token as any).__thread = thread;
  return token;
}

// ── Cross-thread dependency report ──

export interface PluginThreadInfo {
  name: string;
  version: string;
  thread: ThreadTag;
  provides: string[];
  requires: string[];
  active: boolean;
}

export interface CrossThreadReport {
  plugins: PluginThreadInfo[];
  /** Tokens required by one thread but provided by neither. */
  unresolved: string[];
  /** Tokens provided by both threads (expected for shared SABs). */
  shared: string[];
  /** Version conflicts: same plugin name, different version across threads. */
  versionConflicts: { name: string; simVersion?: string; rendererVersion?: string }[];
}

/**
 * Build a cross-thread dependency report from sim + renderer plugin host
 * snapshots. Used by the `downdraft doctor` devtools panel.
 */
export function buildCrossThreadReport(
  simPlugins: PluginThreadInfo[],
  rendererPlugins: PluginThreadInfo[],
): CrossThreadReport {
  const all = [...simPlugins, ...rendererPlugins];
  const providedBy = new Map<string, ThreadTag[]>();

  for (const p of all) {
    if (!p.active) continue;
    for (const tok of p.provides) {
      const threads = providedBy.get(tok) ?? [];
      if (!threads.includes(p.thread)) threads.push(p.thread);
      providedBy.set(tok, threads);
    }
  }

  const required = new Set<string>();
  for (const p of all) {
    if (!p.active) continue;
    for (const tok of p.requires) required.add(tok);
  }

  const unresolved: string[] = [];
  const shared: string[] = [];
  for (const [tok, threads] of providedBy) {
    if (threads.length > 1) shared.push(tok);
  }
  for (const tok of required) {
    if (!providedBy.has(tok)) unresolved.push(tok);
  }

  // Version conflicts
  const byName = new Map<string, { sim?: string; renderer?: string }>();
  for (const p of simPlugins) {
    if (!p.active) continue;
    const entry = byName.get(p.name) ?? {};
    entry.sim = p.version;
    byName.set(p.name, entry);
  }
  for (const p of rendererPlugins) {
    if (!p.active) continue;
    const entry = byName.get(p.name) ?? {};
    entry.renderer = p.version;
    byName.set(p.name, entry);
  }
  const versionConflicts: CrossThreadReport["versionConflicts"] = [];
  for (const [name, versions] of byName) {
    if (versions.sim && versions.renderer && versions.sim !== versions.renderer) {
      versionConflicts.push({ name, simVersion: versions.sim, rendererVersion: versions.renderer });
    }
  }

  return { plugins: all, unresolved, shared, versionConflicts };
}
