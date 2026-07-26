import { engineConfig, initEngine, sabBuffers, stopEngine } from "@downdraft/core/main";
import type { RPC, RPCMessage } from "@downdraft/core/platform/rpc";
import { createLogger } from "@downdraft/core/util/logger";

const log = createLogger();

const rpc: RPC = engineConfig.rpc;

rpc.setSendFn((msg: RPCMessage) => {
  rpc.receive(msg);
});

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

window.downdraft = {
  rpc,
  sabBuffers,
  initEngine,
  stopEngine,
};

log.info("DownDraft", "Bridge initialized — window.downdraft ready");
