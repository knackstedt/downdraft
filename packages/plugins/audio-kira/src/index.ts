import type { Plugin, PluginContext } from "@downdraft/core";
import { audioBackendRegistry } from "@downdraft/core";
import { KiraAudioBackend } from "./backend.ts";

export { KiraAudioBackend };

export const AudioKiraPlugin: Plugin = {
  name: "audio-kira",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const backend = new KiraAudioBackend();
    audioBackendRegistry.register("kira", backend);

    ctx.registerResource("audioConfig", {
      masterVolume: 1.0,
      channelCount: 8,
      sampleRate: 44100,
      bufferSize: 1024,
      spatialEnabled: true,
      maxSources: 64,
      backend: "kira",
    });

    ctx.registerResource("audioBackend", backend);

    ctx.onDispose(() => {
      audioBackendRegistry.unregister("kira");
    });
  },
};
