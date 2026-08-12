import { resolve } from "path";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "falling-sand",
  html: {
    title: "Falling Sand",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
  // --- WASM backend (Rust sand-native) ---
  // Alias @sand-native/sand_native to the wasm-pack output so Vite can
  // resolve it in the renderer build. Must be an absolute path — Vite's
  // alias replacement doesn't resolve relative paths.
  rendererAliases: [
    { find: /^@sand-native\/sand_native$/, replacement: resolve(__dirname, "./sand-native/pkg/sand_native.js") },
  ],
  // Exclude @sand-native from dep pre-bundling (it's already pre-built by
  // wasm-pack) and handle .wasm assets.
  rendererPlugins: [
    {
      name: "sand-native-wasm",
      config(config: any) {
        // Ensure .wasm files are treated as assets
        const assetsInclude = config.assetsInclude as any;
        if (Array.isArray(assetsInclude)) {
          (config.assetsInclude as any) = [...assetsInclude, "**/*.wasm"];
        } else if (typeof assetsInclude === "string") {
          (config.assetsInclude as any) = [assetsInclude, "**/*.wasm"];
        } else {
          (config.assetsInclude as any) = "**/*.wasm";
        }
        // Exclude @sand-native from Vite's dep pre-bundling — it's already
        // pre-built by wasm-pack and pre-bundling would break the WASM loading.
        const optimizeDeps = config.optimizeDeps as any;
        if (optimizeDeps) {
          if (Array.isArray(optimizeDeps.exclude)) {
            optimizeDeps.exclude.push("@sand-native/sand_native");
          } else {
            optimizeDeps.exclude = ["@sand-native/sand_native"];
          }
        } else {
          (config.optimizeDeps as any) = { exclude: ["@sand-native/sand_native"] };
        }
      },
    },
  ],
});
