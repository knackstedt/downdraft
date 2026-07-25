import { engineConfig, initEngine, sabBuffers, stopEngine } from "@downdraft/core/main";
import type { ElectrobunRPC, RPCMessage } from "@downdraft/core/platform/rpc";

const rpc: ElectrobunRPC = engineConfig.rpc;

rpc.setSendFn((msg: RPCMessage) => {
  rpc.receive(msg);
});

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

window.downdraft = {
  rpc,
  sabBuffers,
  initEngine,
  stopEngine,
};

console.log("[DownDraft] Bridge initialized — window.downdraft ready");
