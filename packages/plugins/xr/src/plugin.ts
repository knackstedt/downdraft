import type { Plugin, PluginContext } from "@downdraft/core";
import { XRSessionManager } from "./session.ts";
import { XRInputMapper } from "./input.ts";

export const xrPlugin: Plugin = {
  name: "@downdraft/plugin-xr",
  version: "0.1.0",
  register(ctx: PluginContext) {
    ctx.registerResource("xrSessionManager", new XRSessionManager());
    ctx.registerResource("xrInputMapper", new XRInputMapper());
  },
};
