// ============================================================================
// runtime.ts — app-wide singletons: SessionManager + FeedServer + cleanup.
// ============================================================================

import { SessionManager, writeFeedDiscovery } from "./registry";
import { FeedServer } from "./feed-server";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger();

export const sessions = new SessionManager();
export const feedServer = new FeedServer(sessions);

let started = false;
let cleanupFeed: (() => void) | null = null;

export async function startTargetRuntime(): Promise<void> {
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
  sessions.stop();
  void feedServer.stop();
  cleanupFeed?.();
  cleanupFeed = null;
}
