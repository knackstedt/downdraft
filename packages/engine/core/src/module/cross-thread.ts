// ============================================================================
// Cross-thread plugin contract — shared dependency graph across sim + renderer
//
// In a multi-threaded Downdraft game, the sim worker and renderer each have
// their own ModuleHost with their own DI graph. Some resources (like SABs)
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
 *
 * NOTE: experimental — no engine library or module currently creates
 * cross-thread tokens, so the `threadMismatches`/`incompleteShared` checks in
 * `buildCrossThreadReport` are inert. Also, `ModuleHost.snapshot()` only
 * covers Module/RendererModule plugins — EngineLibrary descriptors are not
 * part of the cross-thread report yet.
 */
export function crossThreadToken<T>(key: string, thread: ThreadTag): CrossThreadToken<T> {
  const token = resourceToken<T>(key) as CrossThreadToken<T>;
  (token as any).__thread = thread;
  return token;
}

// ── Cross-thread dependency report ──

export interface ModuleThreadInfo {
  name: string;
  version: string;
  thread: ThreadTag;
  provides: string[];
  requires: string[];
  active: boolean;
  /**
   * Per-token thread tags carried by `CrossThreadToken`s (keyed by token
   * key). Populated by `ModuleHost.snapshot()` / `RendererModuleHost.snapshot()`
   * for tokens created via `crossThreadToken()`.
   */
  tokenThreads?: Record<string, ThreadTag>;
}

export interface CrossThreadReport {
  modules: ModuleThreadInfo[];
  /** Tokens required by one thread but provided by neither. */
  unresolved: string[];
  /** Tokens provided by both threads (expected for shared SABs). */
  shared: string[];
  /** Version conflicts: same plugin name, different version across threads. */
  versionConflicts: { name: string; simVersion?: string; rendererVersion?: string }[];
  /**
   * Tokens whose declared `crossThreadToken` tag doesn't match the thread
   * that provides them (e.g. a "renderer" token provided by a sim module).
   */
  threadMismatches: { token: string; expected: ThreadTag; providedBy: ThreadTag }[];
  /**
   * Tokens tagged "shared" that are provided on only one thread — the other
   * side will inject() nothing (or a stale copy).
   */
  incompleteShared: { token: string; providedBy: ThreadTag }[];
}

/**
 * Build a cross-thread dependency report from sim + renderer plugin host
 * snapshots. Used by the `downdraft doctor` devtools panel.
 */
export function buildCrossThreadReport(
  simModules: ModuleThreadInfo[],
  rendererModules: ModuleThreadInfo[],
): CrossThreadReport {
  const all = [...simModules, ...rendererModules];
  const providedBy = new Map<string, ThreadTag[]>();

  for (let _i = 0, _it = all, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active) continue;
    p.provides.forEach((tok) => {
      const threads = providedBy.get(tok) ?? [];
      if (!threads.includes(p.thread)) threads.push(p.thread);
      providedBy.set(tok, threads);
    });
  }

  const required = new Set<string>();
  for (let _i = 0, _it = all, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active) continue;
    p.requires.forEach((tok) => { required.add(tok);; });
  }

  const unresolved: string[] = [];
  const shared: string[] = [];
  for (const [tok, threads] of providedBy.entries()) {
    if (threads.length > 1) shared.push(tok);
  }
  for (const tok of required.values()) {
    if (!providedBy.has(tok)) unresolved.push(tok);
  }

  // Thread-tag validation — enforce the declared CrossThreadToken contract.
  // A "sim" token must be provided by a sim module, a "renderer" token by a
  // renderer module, and a "shared" token by both (one side only is flagged
  // as incompleteShared).
  const threadMismatches: CrossThreadReport["threadMismatches"] = [];
  const incompleteShared: CrossThreadReport["incompleteShared"] = [];
  for (let _i = 0, _it = all, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active || !p.tokenThreads) continue;
    for (let _i = 0, _it = p.provides, _n = _it.length; _i < _n; _i++) { const tok = _it[_i];
      const tag = p.tokenThreads[tok];
      if (!tag) continue;
      if ((tag === "sim" || tag === "renderer") && p.thread !== tag) {
        threadMismatches.push({ token: tok, expected: tag, providedBy: p.thread });
      }
    }
  }
  for (let _i = 0, _it = all, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active || !p.tokenThreads) continue;
    for (let _i = 0, _it = p.provides, _n = _it.length; _i < _n; _i++) { const tok = _it[_i];
      if (p.tokenThreads[tok] !== "shared") continue;
      const threads = providedBy.get(tok) ?? [];
      if (threads.length < 2 && !incompleteShared.some((e) => e.token === tok)) {
        incompleteShared.push({ token: tok, providedBy: p.thread });
      }
    }
  }

  // Version conflicts
  const byName = new Map<string, { sim?: string; renderer?: string }>();
  for (let _i = 0, _it = simModules, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active) continue;
    const entry = byName.get(p.name) ?? {};
    entry.sim = p.version;
    byName.set(p.name, entry);
  }
  for (let _i = 0, _it = rendererModules, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (!p.active) continue;
    const entry = byName.get(p.name) ?? {};
    entry.renderer = p.version;
    byName.set(p.name, entry);
  }
  const versionConflicts: CrossThreadReport["versionConflicts"] = [];
  for (const [name, versions] of byName.entries()) {
    if (versions.sim && versions.renderer && versions.sim !== versions.renderer) {
      versionConflicts.push({ name, simVersion: versions.sim, rendererVersion: versions.renderer });
    }
  }

  return { modules: all, unresolved, shared, versionConflicts, threadMismatches, incompleteShared };
}
