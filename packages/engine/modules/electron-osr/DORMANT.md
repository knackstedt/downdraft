# DORMANT — Electron-only code

This module implements off-screen-rendered web content via Electron's
`webContents` + shared-texture paint path. It is retired along with the
Electron runtime: the native host exposes a no-op `osr` bridge stub, so
any remaining `downdraft.osr` calls resolve to nothing.

Do not build on this code. It will be deleted in the post-bake cleanup
(Track E2).

Replacement (Track D): the Blitz-based native OSR module rasterizes
HTML/CSS to RGBA in-process (`libraries/blitz-ui/native-osr` spike). When
it ships it sets `window.__ddOsrAvailable = true`; consumers should gate
OSR features on that flag rather than on `downdraft.osr` being non-null.
