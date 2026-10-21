import { SimWorkerHost } from "@downdraft/engine";

export class TargetSimHost extends SimWorkerHost {
  constructor() {
    super(new SharedArrayBuffer(64 * 1024));
  }

  protected createWorker(): Worker {
    return new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer());
  }
}
