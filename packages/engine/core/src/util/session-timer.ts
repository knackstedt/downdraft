// ============================================================================
// session-timer.ts — scheduling that survives session teardown
//
// Under the native dev shell the SessionTracker wraps global setTimeout:
// callbacks armed while the session is dead (teardown in flight) self-disarm
// via WeakRef and never run — correct for session-owned work, fatal for
// bound/grace-period timers whose whole job is to fire DURING teardown
// (shutdown-RPC bounds, retire fallbacks, response timeouts). Those must
// route through the tracker's untrackedTimeout. Outside the dev shell
// __ddSession is absent and this is a plain setTimeout.
// ============================================================================

/**
 * setTimeout that is exempt from dev-session tracking. The returned id pairs
 * with plain clearTimeout (the wrapped clear delegates to the platform clear).
 */
export function untrackedTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const tracker = (globalThis as any).__ddSession;
  if (typeof tracker?.untrackedTimeout === "function") {
    return tracker.untrackedTimeout(fn, ms);
  }
  return setTimeout(fn, ms);
}
