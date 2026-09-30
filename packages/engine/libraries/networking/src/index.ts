import type { ReplicatedComponent, ReplicatedField, ReplicationConfig, ReplicationMode, ReplicationSnapshot } from "./replication";
import type { RPCDefinition, RPCHandler } from "./rpc";
import type { NetMessage, NetTransport, TransportType } from "./transport";

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

export { createEpicEOSAdapter, EpicEOSAdapter } from "./epic-adapter";
export type { EpicEOSConfig } from "./epic-adapter";

export { createRCSAdapter, RCSAdapter } from "./rcs-adapter";
export type { RCSConfig } from "./rcs-adapter";

export { DeltaDecoder, DeltaEncoder, InterestManager, InterpolationManager } from "./enhanced-replication";
export type { DeltaSnapshot, EntityPosition, InterestArea, InterpolationBuffer } from "./enhanced-replication";

export { AuthorityManager } from "./authority";
export type { AuthorityLevel, EntityAuthority } from "./authority";

// Engine library descriptor (declarative GameModule wiring)
export { NetworkClientTok, NetworkingLib } from "./library";
export type { NetworkingLibConfig } from "./library";


export { LanDiscovery, MdnsBrowser } from "./discovery";
export type { LanBeacon, LanDiscoveryOptions, LanPeer, MdnsBrowseOptions, MdnsService } from "./discovery";
