import type { RPC } from "@downdraft/core";

declare global {
  interface Window {
    downdraft: {
      rpc: RPC;
      sabBuffers: Record<string, SharedArrayBuffer>;
      initEngine: (canvas: HTMLCanvasElement) => Promise<void>;
      stopEngine: () => void;
    };
  }
}

export { };

