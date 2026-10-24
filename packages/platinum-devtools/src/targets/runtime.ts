// ============================================================================
// runtime.ts — app-wide singletons: SessionManager + FeedServer + cleanup.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { FeedServer } from "./feed-server";
import { SessionManager, writeFeedDiscovery } from "./registry";

const log = createLogger();

export const sessions = new SessionManager();
export const feedServer = new FeedServer(sessions);

let started = false;
let refs = 0;
let cleanupFeed: (() => void) | null = null;

/** Refcounted — an embedded mount and the standalone app share the singleton
 *  runtime, and one disposing must not pull discovery/feed out from under
 *  the other. */
export async function startTargetRuntime(): Promise<void> {
  refs++;
  if (started) return;
  started = true;
  // feedRouter must be set before start() — the watcher scans synchronously.
  sessions.feedRouter = (k, p) => feedServer.routeKey(k, p);
  sessions.start();
  try {
    const port = await feedServer.start(0);
    cleanupFeed = writeFeedDiscovery(port, feedServer.feedToken);
    log.info("targets", `feed endpoint ready on ${port}`);
  } catch (e) {
    log.warn("targets", `feed server failed: ${e}`);
  }
}

export function stopTargetRuntime(): void {
  if (refs > 0) refs--;
  if (refs > 0 || !started) return;
  started = false;
  sessions.stop();
  void feedServer.stop();
  cleanupFeed?.();
  cleanupFeed = null;
}
