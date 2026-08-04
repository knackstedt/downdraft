// Window.downdraft bridge for IPC communication
// In web config, this is declared in packages/app/src/renderer/bridge.ts
// In node config, bridge.ts is not included, so we declare it here
// Must match bridge.ts declaration exactly to avoid TS2687
export { };

declare global {
  interface Window {
    downdraft: {
      rpc: { call: (channel: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
      initEngine: (canvas: HTMLCanvasElement) => Promise<void>;
      stopEngine: () => void;
    };
  }
}
