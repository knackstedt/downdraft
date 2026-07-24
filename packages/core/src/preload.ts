import type { ElectrobunRPC, RPCMessage } from "@downdraft/core";

declare global {
  interface Window {
    downdraft: {
      rpc: ElectrobunRPC;
      sabBuffers: Record<string, SharedArrayBuffer>;
      initEngine: (canvas: HTMLCanvasElement) => Promise<void>;
      stopEngine: () => void;
    };
  }
}

export {};
