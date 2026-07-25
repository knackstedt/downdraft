import type { ElectrobunConfig } from "electrobun";

const config: ElectrobunConfig = {
  app: {
    name: "downdraft-engine",
    identifier: "dev.downdraft.engine",
    version: "0.1.0",
    description: "WebGPU-native game engine with AI-first tooling",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      sourcemap: "external",
      define: {
        "process.env.ELECTROBUN_BUILD_ENV": JSON.stringify("dev"),
      },
    },
    views: {
      index: {
        entrypoint: "src/views/index.tsx",
        sourcemap: "inline",
        jsx: { mode: "classic" },
        define: {
          "process.env.NODE_ENV": JSON.stringify("development"),
        },
      },
    },
    copy: {
      "src/views/index.html": "views/index/index.html",
    },
    buildFolder: "build",
    artifactFolder: "artifacts",
    linux: {
      bundleCEF: true,
      bundleWGPU: true,
      defaultRenderer: "cef",
      chromiumFlags: {
        "enable-unsafe-webgpu": true,
        "disable-gpu": false,
        "disable-gpu-sandbox": true,
        "disable-gpu-compositing": true,
        "use-vulkan": true,
        "enable-features": "Vulkan,DefaultEnableVulkan",
      },
    },
  },
};

export default config;
