import type { Plugin } from "@downdraft/core";

export const AudioKiraPlugin: Plugin = {
  name: "audio-kira",
  version: "0.1.0",
  register(ctx) {
    ctx.registerResource("audioConfig", {
      masterVolume: 1.0,
      channelCount: 8,
    });
    ctx.onDispose(() => {
      console.log("[audio-kira] disposed");
    });
  },
};
