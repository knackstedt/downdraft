import { createLogger, type Plugin, Stage } from "@downdraft/core";
import type { ReplicatedComponent, ReplicatedField, ReplicationConfig, ReplicationMode, ReplicationSnapshot } from "./replication.ts";
import { ReplicationManager } from "./replication.ts";
import type { RPCDefinition, RPCHandler } from "./rpc.ts";
import type { NetMessage, NetTransport, TransportType } from "./transport.ts";
import { createTransport } from "./transport.ts";

const log = createLogger();

export { ReplicationManager } from "./replication.ts";
export { RPCManager } from "./rpc.ts";
export { createTransport, MockTransport, WebSocketTransport } from "./transport.ts";
export { createWebRTCTransport, WebRTCTransport, WebSocketSignalingClient } from "./webrtc.ts";
export type { SignalingClient, SignalingMessage, SignalingMessageType } from "./webrtc.ts";
export type { NetMessage, NetTransport, ReplicatedComponent, ReplicatedField, ReplicationConfig, ReplicationMode, ReplicationSnapshot, RPCDefinition, RPCHandler, TransportType };

    export { createMockPlatformAdapter, MockPlatformAdapter } from "./platform-adapter.ts";
    export type { PlatformAdapter, PlatformConnectionState, PlatformId, PlatformLobbyData, PlatformPlayerInfo, PlatformSessionConfig } from "./platform-adapter.ts";

export { SessionManager } from "./session.ts";
export type { SessionConfig, SessionInfo, SessionState } from "./session.ts";

export { LobbyManager } from "./lobby.ts";
export type { LobbyConfig, LobbyState } from "./lobby.ts";

export { ConnectionManager } from "./connection.ts";
export type { ConnectionState, PeerInfo } from "./connection.ts";

export { REMOTE_INPUT_MSG_TYPE, RemoteInputBridge } from "./remote-input.ts";
export type { RemoteInputPacket } from "./remote-input.ts";

export { createMultiplayerPlugin, MultiplayerPlugin } from "./multiplayer-plugin.ts";
export type { MultiplayerPluginConfig } from "./multiplayer-plugin.ts";

export { createEpicEOSAdapter, EpicEOSAdapter } from "./epic-adapter.ts";
export type { EpicEOSConfig } from "./epic-adapter.ts";

export { createRCSAdapter, RCSAdapter } from "./rcs-adapter.ts";
export type { RCSConfig } from "./rcs-adapter.ts";

export { DeltaDecoder, DeltaEncoder, InterestManager, InterpolationManager } from "./enhanced-replication.ts";
export type { DeltaSnapshot, EntityPosition, InterestArea, InterpolationBuffer } from "./enhanced-replication.ts";

export { AuthorityManager } from "./authority.ts";
export type { AuthorityLevel, EntityAuthority } from "./authority.ts";

export interface NetworkingPluginConfig {
  transport: TransportType;
  tickRate: number;
  isServer: boolean;
  url?: string;
}

export const DEFAULT_NETWORKING_CONFIG: NetworkingPluginConfig = {
  transport: "mock",
  tickRate: 20,
  isServer: false,
};

export function createNetworkingPlugin(config: Partial<NetworkingPluginConfig> = {}): Plugin {
  const merged: NetworkingPluginConfig = { ...DEFAULT_NETWORKING_CONFIG, ...config };
  return {
    name: "networking",
    version: "0.2.0",
    register(ctx) {
      const transport = createTransport(merged.transport);
      const replication = new ReplicationManager(transport, merged.isServer, {
        tickRate: merged.tickRate,
      });

      ctx.registerResource("networkConfig", merged);
      ctx.registerResource("networkTransport", transport);
      ctx.registerResource("networkReplication", replication);
      ctx.registerResource("networkRPC", replication.rpc);

      ctx.registerSystem(Stage.Update, (sysCtx) => {
        replication.update(sysCtx.dt);
      });

      if (merged.url) {
        transport.connect(merged.url).catch((err) => {
          log.error("networking", `Failed to connect: ${err}`);
        });
      }

      ctx.onDispose(() => {
        transport.disconnect();
        log.info("networking", "disposed");
      });
    },
  };
}

export const NetworkingPlugin: Plugin = createNetworkingPlugin();
