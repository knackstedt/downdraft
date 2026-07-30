import { engineConfig, initEngine, stopEngine } from "@downdraft/core/main";
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
      initEngine: (canvas: HTMLCanvasElement) => Promise<void>;
      stopEngine: () => void;
    };
  }
}

window.downdraft = {
  rpc,
  initEngine,
  stopEngine,
};

log.info("DownDraft", "Bridge initialized — window.downdraft ready");
