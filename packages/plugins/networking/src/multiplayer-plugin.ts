import { createLogger, MultiInputChannel, MultiInputSABBridge, MultiInputSABWriter, MultiInputState, type Plugin, Stage } from "@downdraft/core";
import { ConnectionManager } from "./connection.ts";
import { LobbyManager } from "./lobby.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";
import { MockPlatformAdapter } from "./platform-adapter.ts";
import { RemoteInputBridge } from "./remote-input.ts";
import { ReplicationManager } from "./replication.ts";
import { SessionManager } from "./session.ts";
import type { TransportType } from "./transport.ts";
import { createTransport } from "./transport.ts";

const log = createLogger();

export interface MultiplayerPluginConfig {
  maxPlayers: number;
  isHost: boolean;
  platform?: PlatformAdapter;
  transportType?: TransportType;
  tickRate: number;
  url?: string;
  metadata?: Record<string, string>;
}

export const DEFAULT_MULTIPLAYER_CONFIG: MultiplayerPluginConfig = {
  maxPlayers: 8,
  isHost: false,
  transportType: "mock",
  tickRate: 20,
};

export function createMultiplayerPlugin(config: Partial<MultiplayerPluginConfig> = {}): Plugin {
  const merged: MultiplayerPluginConfig = { ...DEFAULT_MULTIPLAYER_CONFIG, ...config };
  return {
    name: "multiplayer",
    version: "0.1.0",
    dependencies: ["networking"],
    register(ctx) {
      const platform = merged.platform ?? new MockPlatformAdapter();
      const channel = MultiInputChannel;
      const sab = channel.allocate();
      const multiState = new MultiInputState(merged.maxPlayers);
      const writer = new MultiInputSABWriter(sab, channel);
      const bridge = new MultiInputSABBridge(sab, multiState, channel);

      const transport = createTransport(merged.transportType ?? "mock");
      const replication = new ReplicationManager(transport, merged.isHost, {
        tickRate: merged.tickRate,
      });

      const session = new SessionManager({
        maxPlayers: merged.maxPlayers,
        isHost: merged.isHost,
        platform,
        transport,
        metadata: merged.metadata,
      });

      const lobby = new LobbyManager(platform, {
        maxPlayers: merged.maxPlayers,
        publicLobby: true,
        metadata: merged.metadata,
      });

      const connection = new ConnectionManager(platform, transport);
      const remoteInput = new RemoteInputBridge(writer, platform, merged.maxPlayers);

      ctx.registerResource("multiplayerConfig", merged);
      ctx.registerResource("multiplayerPlatform", platform);
      ctx.registerResource("multiplayerSAB", sab);
      ctx.registerResource("multiplayerInputState", multiState);
      ctx.registerResource("multiplayerInputWriter", writer);
      ctx.registerResource("multiplayerInputBridge", bridge);
      ctx.registerResource("multiplayerSession", session);
      ctx.registerResource("multiplayerLobby", lobby);
      ctx.registerResource("multiplayerConnection", connection);
      ctx.registerResource("multiplayerRemoteInput", remoteInput);
      ctx.registerResource("multiplayerReplication", replication);

      ctx.registerSystem(Stage.Input, () => {
        bridge.poll();
      });

      ctx.registerSystem(Stage.Update, (sysCtx) => {
        replication.update(sysCtx.dt);
        session.tick_(sysCtx.dt);
        connection.updatePeerRTTs();
      });

      ctx.onDispose(() => {
        connection.disconnectAll();
        session.stop().catch((err) => {
          log.error("multiplayer", `Session stop error: ${err}`);
        });
        log.info("multiplayer", "disposed");
      });
    },
  };
}

export const MultiplayerPlugin: Plugin = createMultiplayerPlugin();
