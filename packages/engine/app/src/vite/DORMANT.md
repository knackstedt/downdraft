# DORMANT — Electron-era build pipeline

This directory contains the electron-vite config factory
(`createDowndraftViteConfig`) and its plugin suite — `downdraft-html-plugin`,
`engine-resolve`, `worker-url-guard-plugin`, `scene-module-url-plugin`,
`profiling-prelude-plugin`, `wgsl-validate-plugin`,
`silence-sourcemap-warnings-plugin`, `asset-bake-plugin`, and `mobile.ts`.

The only consumers were per-game `electron.vite.config.ts` files and the
Capacitor mobile path — both dormant. Native dev uses `dev-shell.mjs` +
`native-dev-runtime.ts`, which run Vite directly in middlewareMode via a
RunnableDevEnvironment (the tiered HMR path), not electron-vite.

Still published as `@downdraft/engine/app/vite` until the exports map is
regenerated in Phase 7 of `docs/refactor/native-rearchitecture-plan.md`.
Do not build on this directory.
