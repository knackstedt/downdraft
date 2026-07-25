import { Electroview } from "electrobun/view";
import { createRoot } from "react-dom/client";
import { App } from "../../packages/ui/src/renderer/App.tsx";
import type { DownDraftRPC } from "../rpc-schema.ts";

const rpc = Electroview.defineRPC<DownDraftRPC>({
  handlers: {
    requests: {},
    messages: {
      input: () => {},
    },
  },
});

const electroview = new Electroview({ rpc });

const compatRpc = {
  call: (method: string, ...args: unknown[]) => {
    const req = (electroview.rpc as any).request;
    if (req && typeof req[method] === "function") {
      return req[method](args[0]);
    }
    return Promise.reject(new Error(`[RPC] Unknown method: ${method}`));
  },
  emit: (event: string, payload?: unknown) => {
    const send = (electroview.rpc as any).send;
    if (send && typeof send[event] === "function") {
      send[event](payload);
    }
  },
  on: (_channel: string, _fn: (payload: unknown) => void) => () => {},
  registerHandler: (_channel: string, _handler: unknown) => {},
  setSendFn: (_fn: unknown) => {},
  receive: (_msg: unknown) => {},
};

let gpuRenderer: GPURenderer | null = null;

(window as any).downdraft = {
  rpc: compatRpc,
  sabBuffers: {},
  initEngine: async (canvas: HTMLCanvasElement) => {
    console.log("[DownDraft] initEngine called with canvas", canvas);
    gpuRenderer = new GPURenderer(canvas);
    const ok = await gpuRenderer.init();
    if (!ok) {
      console.error("[DownDraft] GPU renderer failed to init");
      gpuRenderer = null;
    }
  },
  stopEngine: () => {
    console.log("[DownDraft] stopEngine called");
    gpuRenderer?.stop();
    gpuRenderer = null;
  },
};

const container = document.getElementById("ui-overlay");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
