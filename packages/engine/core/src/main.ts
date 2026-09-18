import { RPC } from "./platform/rpc";
import { GPUDeviceManager } from "./render/device";
import { SurfaceManager } from "./render/surface";
import { createLogger } from "./util/logger";

const log = createLogger();

const rpc = new RPC();

export interface EngineConfig {
  rpc: RPC;
}

export const engineConfig: EngineConfig = { rpc };

let deviceManager: GPUDeviceManager | null = null;
let surface: SurfaceManager | null = null;
let rafId: number = 0;

export async function initEngine(canvas: HTMLCanvasElement): Promise<void> {
  deviceManager = new GPUDeviceManager();
  const device = await deviceManager.requestDevice();
  if (!device) {
    log.error("DownDraft", "Failed to acquire GPU device");
    return;
  }

  surface = new SurfaceManager(device);
  surface.configure(canvas, {
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const format = surface.getFormat() ?? "bgra8unorm";

  const render = () => {
    if (!device || !surface) return;
    const texture = surface.getCurrentTexture();
    if (!texture) return;
    const encoder = device.createCommandEncoder();
    const view = texture.createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0.1, b: 0.2, a: 1 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);

  log.info("DownDraft", `Engine initialized (format: ${format})`);
}

export function stopEngine(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  surface = null;
  deviceManager = null;
  log.info("DownDraft", "Engine stopped");
}
