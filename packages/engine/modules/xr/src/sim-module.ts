import { type Module, type ModuleContext, resourceToken } from "@downdraft/core";
import { XRInputMapper } from "./input";
import { XRSessionManager } from "./session";

/** Token for the XR session manager provided by `xrModule`. */
export const XRSessionManagerTok = resourceToken<XRSessionManager>("xrSessionManager");
/** Token for the XR input mapper provided by `xrModule`. */
export const XRInputMapperTok = resourceToken<XRInputMapper>("xrInputMapper");

export const xrModule: Module = {
  name: "@downdraft/module-xr",
  version: "0.1.0",
  provides: [XRSessionManagerTok, XRInputMapperTok],
  register(ctx: ModuleContext) {
    const session = new XRSessionManager();
    const input = new XRInputMapper();
    ctx.provide(XRSessionManagerTok, session);
    ctx.provide(XRInputMapperTok, input);
    ctx.onDispose(() => {
      session.destroy();
    });
  },
};
