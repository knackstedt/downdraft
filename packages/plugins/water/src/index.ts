import type { Plugin, PluginContext } from "@downdraft/core";
import { DEFAULT_WAVE_CONFIG, type GerstnerWaveConfig } from "./gerstner.ts";
import { WaterRenderPass } from "./render.ts";
import { WaterSABChannel, WATER_SAB_LAYOUT } from "./sab.ts";

export { GerstnerWaveParams, GerstnerWaveConfig, DEFAULT_WAVE_CONFIG, gerstnerHeight, gerstnerDisplacement, gerstnerNormal, packWaveData, packWaveUniforms } from "./gerstner.ts";
export { WaterRenderPass, WATER_RENDER_LAYOUT } from "./render.ts";
export type { WaterRenderResources } from "./render.ts";
export { WaterSABChannel, WATER_SAB_LAYOUT } from "./sab.ts";

export const WaterPlugin: Plugin = {
  name: "water",
  version: "0.1.0",
  register(ctx: PluginContext) {
    const config: GerstnerWaveConfig = { ...DEFAULT_WAVE_CONFIG };
    const renderPass = new WaterRenderPass(config);

    const sabChannel = ctx.allocateSABChannel("water", 1);
    const waterSAB = new WaterSABChannel(sabChannel, config);
    renderPass.setSABChannel(sabChannel);

    ctx.registerResource("waterConfig", config);
    ctx.registerResource("waterRenderPass", renderPass);
    ctx.registerResource("waterSAB", waterSAB);

    ctx.registerSystem(3, function waterUpdate(ctx) {
      const dt = ctx.dt;
      renderPass.update(dt);
      waterSAB.update(dt);
      waterSAB.write();
      renderPass.writeSAB();
    });

    ctx.onDispose(() => {
      renderPass.destroy();
    });
  },
};
