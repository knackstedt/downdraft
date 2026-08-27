import { type Plugin, type PluginContext, resourceToken } from "@downdraft/core";
import { XRInputMapper } from "./input";
import { XRSessionManager } from "./session";

/** Token for the XR session manager provided by `xrPlugin`. */
export const XRSessionManagerTok = resourceToken<XRSessionManager>("xrSessionManager");
/** Token for the XR input mapper provided by `xrPlugin`. */
export const XRInputMapperTok = resourceToken<XRInputMapper>("xrInputMapper");

export const xrPlugin: Plugin = {
  name: "@downdraft/plugin-xr",
  version: "0.1.0",
  provides: [XRSessionManagerTok, XRInputMapperTok],
  register(ctx: PluginContext) {
    const session = new XRSessionManager();
    const input = new XRInputMapper();
    ctx.provide(XRSessionManagerTok, session);
    ctx.provide(XRInputMapperTok, input);
    ctx.onDispose(() => {
      session.destroy();
    });
  },
};
