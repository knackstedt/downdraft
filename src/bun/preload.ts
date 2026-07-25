import { defineElectrobunRPC } from "electrobun";
import type { DownDraftRPC } from "../rpc-schema.ts";

const rpc = defineElectrobunRPC<DownDraftRPC, "webview">("webview", {
  handlers: {
    requests: {},
    messages: {
      input: (payload) => {
      },
    },
  },
});

export { rpc };
