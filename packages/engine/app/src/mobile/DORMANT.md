# DORMANT — Capacitor mobile host

`createDowndraftMobileApp` and friends (`mobile-bridge`, `touch-*`,
`webgpu-guard`) target the system WebView via Capacitor. Mobile packaging
(`draft mobile`, `packages/mobile-shell`, `packages/cli/src/mobile.ts`)
warns that it is unmaintained and depends on the dormant electron-vite
mobile pipeline in `../vite/mobile.ts`.

Deletion tracked in Phase 7 of
`docs/refactor/native-rearchitecture-plan.md`.
