import { createLogger, type Plugin, Stage } from "@downdraft/core";
import type { ReplicatedComponent, ReplicatedField, ReplicationConfig, ReplicationMode, ReplicationSnapshot } from "./replication";
import { ReplicationManager } from "./replication";
import type { RPCDefinition, RPCHandler } from "./rpc";
import type { NetMessage, NetTransport, TransportType } from "./transport";
import { createTransport } from "./transport";

const log = createLogger();

export { ReplicationManager } from "./replication";
export { RPCManager } from "./rpc";
export { createTransport, MockTransport, WebSocketTransport } from "./transport";
export { createWebRTCTransport, isValidIceCandidate, WebRTCTransport, WebSocketSignalingClient } from "./webrtc";
export type { SignalingClient, SignalingMessage, SignalingMessageType } from "./webrtc";
export type { NetMessage, NetTransport, ReplicatedComponent, ReplicatedField, ReplicationConfig, ReplicationMode, ReplicationSnapshot, RPCDefinition, RPCHandler, TransportType };

    export { createMockPlatformAdapter, MockPlatformAdapter } from "./platform-adapter";
    export type { PlatformAdapter, PlatformConnectionState, PlatformId, PlatformLobbyData, PlatformPlayerInfo, PlatformSessionConfig } from "./platform-adapter";

export { SessionManager } from "./session";
export type { SessionConfig, SessionInfo, SessionState } from "./session";

export { LobbyManager } from "./lobby";
export type { LobbyConfig, LobbyState } from "./lobby";

export { ConnectionManager } from "./connection";
export type { ConnectionState, PeerInfo } from "./connection";

export { REMOTE_INPUT_MSG_TYPE, RemoteInputBridge } from "./remote-input";
export type { RemoteInputPacket } from "./remote-input";

export { createMultiplayerPlugin, MultiplayerPlugin } from "./multiplayer-plugin";
export type { MultiplayerPluginConfig } from "./multiplayer-plugin";

export { createEpicEOSAdapter, EpicEOSAdapter } from "./epic-adapter";
export type { EpicEOSConfig } from "./epic-adapter";

export { createRCSAdapter, RCSAdapter } from "./rcs-adapter";
export type { RCSConfig } from "./rcs-adapter";

export { DeltaDecoder, DeltaEncoder, InterestManager, InterpolationManager } from "./enhanced-replication";
export type { DeltaSnapshot, EntityPosition, InterestArea, InterpolationBuffer } from "./enhanced-replication";

export { AuthorityManager } from "./authority";
export type { AuthorityLevel, EntityAuthority } from "./authority";

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
