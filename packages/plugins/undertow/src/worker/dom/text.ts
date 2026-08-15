// ============================================================================
// WorkerText / WorkerComment — worker-side proxies for Text and Comment nodes.
// Both extend CharacterData, which extends WorkerNode. The key property is
// `data` (get/set) which maps to OP_NODE_GET_DATA / OP_NODE_SET_DATA.
// ============================================================================

import * as ids from "../../shared/op-ids";
import { WorkerNode } from "./node";

export class WorkerText extends WorkerNode {
  constructor(id: number, rt: import("../runtime").WorkerRuntime) {
    super(id, rt);
  }

  get data(): Promise<string> {
    return this.rt.call(ids.OP_NODE_GET_DATA, this.handleId, []).then((r) => r.value as string);
  }

  set data(v: string) {
    this.rt.call(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }

  async getData(): Promise<string> {
    const r = await this.rt.call(ids.OP_NODE_GET_DATA, this.handleId, []);
    return r.value as string;
  }

  async setData(v: string): Promise<void> {
    await this.rt.call(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }
}

export class WorkerComment extends WorkerNode {
  constructor(id: number, rt: import("../runtime").WorkerRuntime) {
    super(id, rt);
  }

  get data(): Promise<string> {
    return this.rt.call(ids.OP_NODE_GET_DATA, this.handleId, []).then((r) => r.value as string);
  }

  set data(v: string) {
    this.rt.call(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }

  async getData(): Promise<string> {
    const r = await this.rt.call(ids.OP_NODE_GET_DATA, this.handleId, []);
    return r.value as string;
  }

  async setData(v: string): Promise<void> {
    await this.rt.call(ids.OP_NODE_SET_DATA, this.handleId, [v]);
  }
}
