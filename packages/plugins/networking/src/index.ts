import type { Plugin } from "@downdraft/core";
import { createTransport, MockTransport, WebSocketTransport } from "./transport.ts";
import { ReplicationManager } from "./replication.ts";
import type { NetTransport, NetMessage, TransportType } from "./transport.ts";
import type { ReplicationConfig, ReplicatedComponent, ReplicatedField, ReplicationMode, ReplicationSnapshot } from "./replication.ts";

export { createTransport, MockTransport, WebSocketTransport, ReplicationManager };
export type { NetTransport, NetMessage, TransportType, ReplicationConfig, ReplicatedComponent, ReplicatedField, ReplicationMode, ReplicationSnapshot };

export interface NetworkingPluginConfig {
  transport: TransportType;
  tickRate: number;
  isServer: boolean;
  url?: string;
}

export const NetworkingPlugin: Plugin = {
  name: "networking",
  version: "0.1.0",
  register(ctx) {
    const config: NetworkingPluginConfig = {
      transport: "websocket",
      tickRate: 20,
      isServer: false,
    };

    const transport = createTransport(config.transport);
    const replication = new ReplicationManager(transport, config.isServer, {
      tickRate: config.tickRate,
    });

    ctx.registerResource("networkConfig", config);
    ctx.registerResource("networkTransport", transport);
    ctx.registerResource("networkReplication", replication);

    ctx.registerSystem({
      name: "network-update",
      priority: 100,
      update: (dt: number) => {
        replication.update(dt);
      },
    });

    ctx.onDispose(() => {
      transport.disconnect();
      console.log("[networking] disposed");
    });
  },
};
