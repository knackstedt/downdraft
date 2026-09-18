// ============================================================================
// polyfill.spec.ts — Orchestrator: render every scene in browser + native,
// then compare the screenshots.
//
// Run:  bun test tests/pixi-polyfill/polyfill.spec.ts
//
// Environment:
//   PIXI_POLYFILL_ONLY=sceneId   render/compare only one scene (debugging)
//   PIXI_POLYFILL_KEEP_ARTIFACTS=1  keep screenshots even on pass (default: keep)
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { renderBrowser } from "./browser/render";
import { compareScreenshots } from "./compare";
import { disposeNativeHost, renderNative } from "./native/render";
import { SCENES } from "./scenes/registry";

const ARTIFACTS = join(import.meta.dir, "artifacts");
const ONLY = process.env.PIXI_POLYFILL_ONLY;

const scenes = ONLY ? SCENES.filter((s) => s.id === ONLY) : SCENES;

beforeAll(() => {
  if (scenes.length === 0) {
    console.warn("[pixi-polyfill] no scenes selected; PIXI_POLYFILL_ONLY=" + ONLY);
  }
});

afterAll(async () => {
  await disposeNativeHost();
});

describe("pixi-polyfill visual parity", () => {
  for (const scene of scenes) {
    describe(`scene: ${scene.id} (${scene.name})`, () => {
      let browserPath: string;
      let nativePath: string;
      let diffPath: string;

      it("renders in browser (Playwright + WebGPU)", async () => {
        browserPath = join(ARTIFACTS, `${scene.id}-browser.png`);
        const res = await renderBrowser(scene.id, browserPath);
        expect(res.width).toBeGreaterThan(0);
        expect(res.height).toBeGreaterThan(0);
      }, 120000);

      it("renders in native (Bun + wgpu-native)", async () => {
        nativePath = join(ARTIFACTS, `${scene.id}-native.png`);
        const res = await renderNative(scene.id, nativePath);
        expect(res.width).toBeGreaterThan(0);
        expect(res.height).toBeGreaterThan(0);
      }, 120000);

      it("browser and native screenshots match", async () => {
        diffPath = join(ARTIFACTS, `${scene.id}-diff.png`);
        const result = compareScreenshots(browserPath, nativePath, {
          diffPath,
          maxMeanPerChannel: scene.maxMeanPerChannel ?? 6.0,
          mismatchTolerance: 24,
        });
        if (!result.pass) {
          console.error(
            `[pixi-polyfill] ${scene.id} mismatch: ` +
              `mean=${result.meanPerChannel.toFixed(2)} ` +
              `max=${result.maxDiff} ` +
              `mismatch=${result.mismatchPercent.toFixed(2)}%`,
          );
        }
        expect(result.pass).toBe(true);
      }, 60000);
    });
  }
});
