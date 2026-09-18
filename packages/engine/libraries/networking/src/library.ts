// ============================================================================
// NetworkingLib — declarative engine library descriptor for @downdraft/engine/libraries/networking
//
// Games declare `libraries: [NetworkingLib]` (or with config override) in their
// GameModule. The host creates the ConnectionManager (sim-side only — networking
// state is simulated on the sim thread) and exposes it via the NetworkClientTok
// typed token.
//
// The platform adapter (Epic EOS, RCS, Mock, etc.) is game-specific, so games
// pass it via the config. Games that need full control can still import
// ConnectionManager / SessionManager / ReplicationManager directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { ConnectionManager } from "./connection";
import type { PlatformAdapter } from "./platform-adapter";
import type { NetTransport } from "./transport";

// ── Config ──

export interface NetworkingLibConfig {
  /** Platform adapter (Epic EOS, RCS, Mock, etc.). Required. */
  platform: PlatformAdapter;
  /** Optional network transport (defaults to null — set by the platform). */
  transport?: NetTransport;
  /** Max reconnect attempts before giving up. Default: 5. */
  maxReconnectAttempts?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side connection manager. Inject in sim systems that send/receive net messages. */
export const NetworkClientTok = resourceToken<ConnectionManager>("networking:client");

// ── Descriptor ──

export const NetworkingLib: EngineLibrary<NetworkingLibConfig> = {
  name: "networking",
  version: "1.0.0",

  // No SAB channels — networking state lives in-process on the sim thread;
  // replication snapshots are synced via the main SimBuffer or RPC events.
  sabChannels: [],

  provides: [NetworkClientTok],

  sim: {
    create(config, ctx) {
      const client = new ConnectionManager(config.platform, config.transport);
      ctx.provide(NetworkClientTok, client);
      return client;
    },
    dispose(client) {
      // ConnectionManager has no destroy() — disconnectAll() tears down peers.
      (client as ConnectionManager).disconnectAll();
    },
    // tick is game-specific (calls client.updatePeerRTTs(), processes
    // replication snapshots, dispatches RPCs, etc.) — games wire this via
    // onReady or a sim system.
  },

  tickPhase: "pre-physics",

  // No renderer setup — networking is entirely sim-side.

  defaultConfig: {
    maxReconnectAttempts: 5,
  } as NetworkingLibConfig,
};
