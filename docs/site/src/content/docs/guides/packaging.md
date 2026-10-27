---
title: Packaging & Distribution
description: Shipping an app — runtime matrix (bun/node/deno), linux formats (.deb, AppImage, Flatpak), the package.json build block, and native artifact staging
---

`draft release --target=linux` runs an electron-builder-style packager (`packages/cli/scripts/package-desktop.mjs`) that produces real distribution formats — not just a bare binary. An app picks the JS runtime(s) it ships on; the engine doesn't force plurality.

## Quick start

```bash
# Staged app dir only (what you'd debug)
draft release --target=linux --format=dir

# Everything, every runtime
draft release --target=linux --runtime=all --format=deb,appimage,flatpak

# A single pinned combination, driven by package.json
draft release --target=linux
```

## The runtime matrix

`--runtime` selects the JS host embedded in the package (`bun` / `node` / `deno` / `all`). The produced appdir is identical in shape across runtimes — everything resolves relative to `dirname(process.execPath)`:

```
<exe>            compiled binary (bun) or launcher script (node/deno)
node | deno      shipped runtime binary (emit runtimes only)
bundle/          emitted .mjs tree + index.js + node_modules/ (koffi)
native/          engine libdowndraft_*.so + app-native .so/.node
dd-assets/       ?url / new URL / import.meta.glob staged payloads
```

| `--runtime` | What `<exe>` is | Notes |
|---|---|---|
| `bun` | `bun build --compile` binary (delegates to `package-native.mjs`) | Single self-contained executable; `$bunfs`-embedded bundle. |
| `node` | Shell launcher → `node bundle/index.js` | Ships a Node binary + emitted `.mjs` tree + `koffi`/`@koromix/koffi-linux-*` in `bundle/node_modules/`. Browser-style `Worker` is polyfilled. |
| `deno` | Shell launcher → `deno run -A bundle/index.js` | Ships a Deno binary + emitted `.mjs` tree. `deno compile` isn't used — it can't anchor the asset/worker tree. |
| `all` | One appdir per runtime | Convenience expansion for release matrices. |

`node`/`deno` runtimes are **linux-only today** — win/mac targets still produce bun binaries (a warning is printed).

## The `build` block

Electron-builder-style configuration lives in the app's `package.json`. CLI flags override it per invocation.

```jsonc
{
  "name": "my-app",
  "version": "0.1.0",
  "build": {
    "appId": "com.studio.myapp",
    "productName": "My App",
    "runtime": "node",                  // default runtime for --runtime
    "executableName": "my-app",
    "icon": "assets/icon.png",
    "files": ["README.md", "LICENSE"],  // copied into the appdir root
    "linux": {
      "target": ["deb", "AppImage", "flatpak"], // default for --format
      "category": "App",
      "maintainer": "Studio <hello@studio.example>",
      "synopsis": "Short launcher description",
      "description": "Longer package description",
      "icon": "assets/icon-256.png"
    },
    "deb": {
      "section": "apps",
      "priority": "optional",
      "depends": ["libc6", "libstdc++6", "libvulkan1"]
    },
    "flatpak": {
      "runtime": "org.freedesktop.Platform",
      "runtimeVersion": "25.08",
      "sdk": "org.freedesktop.Sdk",
      "finishArgs": [
        "--socket=wayland", "--socket=fallback-x11", "--share=ipc",
        "--device=dri", "--socket=pulseaudio",
        "--filesystem=home", "--share=network"
      ]
    }
  }
}
```

## Formats

### `dir`

The staged appdir verbatim — the intermediate every other format wraps, and the fastest way to smoke-test a package (`./<exe>` runs in place).

### `deb`

`dpkg-deb` output installing to `/usr/lib/<exe>` with a `/usr/bin` symlink, freedesktop `.desktop` entry, hicolor icon set (48/128/256, resized via `jimp`), and AppStream metainfo. `DEBIAN/control` fields come from `build.linux`/`build.deb`.

### `appimage`

AppDir + `AppRun` → `appimagetool`. The tool is downloaded on first use to `~/.cache/downdraft/tools/` (and its own runtime blob on first build). No FUSE is required — both appimagetool and the produced AppImage run via `APPIMAGE_EXTRACT_AND_RUN`/`--appimage-extract-and-run`.

### `flatpak`

Generates a manifest and runs `flatpak-builder` + `flatpak build-bundle`. Defaults: `org.freedesktop.Platform` 25.08 / `org.freedesktop.Sdk`; sandbox permissions via `build.flatpak.finishArgs` (default grants wayland+x11, IPC, GPU, audio, home fs, network).

Two flatpak-specific rules to know:

- **Icons must be named `<appId>.png`** — flatpak only exports icons whose basename matches the app-id. The packager handles this; if you see "non-allowed export filename" warnings, the icon name is wrong.
- **`strip` must stay off for compiled binaries** — `bun build --compile` appends the bundle past the ELF sections and `strip` silently deletes it, degrading the app to a bare `bun` CLI. The generated manifest sets `build-options: { strip: false }` — keep it if you hand-edit the manifest.

## Native artifacts

App-owned Rust artifacts in `<app>/native/dist/<platform>-<arch>/` are staged into `native/` beside the engine cdylibs — both `.so`/`.dll`/`.dylib` (C-ABI FFI) and `.node` (napi-rs) files. `.node` addons load under all three desktop runtimes (Node natively, Bun's napi impl, Deno's node-api layer). See [Native Modules (Rust)](/guides/native-modules/) for the crate-side conventions.

## System requirements for each builder

| Format | Required tool |
|---|---|
| `dir` | none (bundled with the engine) |
| `deb` | `dpkg-deb` |
| `appimage` | none — `appimagetool` auto-downloads on first use |
| `flatpak` | `flatpak-builder` + a Flatpak runtime/SDK matching `build.flatpak.runtimeVersion` |

## Verifying a package

`dir` and extracted `.deb` trees run in place. For AppImage without FUSE use `./MyApp.AppImage --appimage-extract-and-run`. Flatpak bundles install per-user (`flatpak install --user <bundle>`) and run via `flatpak run <appId>`.

## Native packaging (`draft release`)

`draft release` is the unified build + package pipeline; the legacy `build`, `dist`, `export`, `mobile`, and `build-apps` commands were removed — see the [CLI reference](/reference/cli/) for the replacement invocations.

```
draft release [--app=<name>] [--apps=<csv>] [--target=<win|linux|mac|android|all>]
              [--stage=<build|package|release>] [--mode=<dev|debug|prod>]
              [--runtime=<bun|node|deno|all>] [--format=<csv>]
              [--out=<dir>] [--mcp] [--verbose]
```

All stages compile the same artifact via `scripts/package-native.mjs`: a standalone Bun binary (`<out>/<app>-<target>`) plus a sibling `native/` cdylib and `dd-assets/` staging tree. `--mcp` retains the MCP endpoint in the packaged binary (stripped by default via `__DD_MCP_STRIP__`). `--target=android` invokes `packages/cli/scripts/package-mobile.mjs` (native winit+wgpu shell + embedded libnode — see "Android: genuinely native port" above); the old Capacitor path is removed.

**Linux packaging** goes through `packages/cli/scripts/package-desktop.mjs`, an electron-builder-style system with a runtime matrix:

- `--runtime=bun|node|deno|all` — the JS host inside the package. `bun` delegates to `package-native.mjs` (compiled binary); `node`/`deno` emit an `.mjs` bundle tree next to a shipped runtime binary + launcher script (same appdir layout either way: `<exe>` + `bundle/` + `native/` + `dd-assets/`). Resolution anchor is `dirname(process.execPath)` in all three.
- `--format=dir,deb,appimage,flatpak` — `dir` is the staged appdir verbatim; `deb` uses `dpkg-deb` (`/usr/lib/<exe>` + `/usr/bin` symlink + desktop file + hicolor icons); `appimage` assembles an AppDir and invokes `appimagetool` (auto-downloaded to `~/.cache/downdraft/tools/`; works without FUSE via `APPIMAGE_EXTRACT_AND_RUN`); `flatpak` generates a manifest and runs `flatpak-builder` + `build-bundle` (icon must be named `<appId>.png` to export; `strip` must stay off — it deletes the `.bun` trailer from compiled binaries).
- Electron-builder-style config lives in the app `package.json` `build` block: `appId`, `productName`, `icon`, `runtime`, `executableName`, `files`, `linux.target/category/maintainer/synopsis/icon`, `deb.{section,priority,depends}`, `flatpak.{runtime,runtimeVersion,sdk,finishArgs}`.
- App-native artifacts in `<app>/native/dist/<platform>-<arch>/` (`.so`/`.dll`/`.dylib` + `.node` napi addons) are staged into `native/` — napi `.node` addons load under all three desktop runtimes.
- `--runtime=node|deno` is linux-only today; win/mac still compile to bun binaries. The full `(deb, appimage, flatpak) × (bun, node, deno)` matrix is verified launching on-device.
- **CI coverage**: `examples/packaging-smoke/` is a tracked fixture standing in for "an app" (real apps are separate repos) — its `DD_PACKAGING_SMOKE=1` env var runs the packaged entry headless (worker roundtrip, `createGlob` asset staging, `new URL(...)` asset refs) and prints `DD_SMOKE_OK`. `.github/workflows/packaging.yml` builds and launches the full `(dir, deb, appimage, flatpak) × (bun, node, deno)` matrix on every push/PR; flatpak needs `flatpak` + `flatpak-builder` and a `--user` Flathub install of `org.freedesktop.Platform//25.08` + `org.freedesktop.Sdk//25.08`.
- Asset-glob staging scans source for `import.meta.glob("pat")`, `_glob("pat")`, `globAssets("pat")`, and `createGlob(dir)("pat")` in all three packagers. `globAssets(pattern, import.meta)` receives the *raw* `import.meta` — its `meta.dir` is not rewritten, so headless/packaged code without the native host's `__nativeGlob` should use `createGlob(import.meta.dir)` (the `import.meta.dir` expression IS rewritten to the staged dd-assets dir). Under the dev `ModuleRunner`, `import.meta.glob` exists on every meta object but is a **throwing stub** (only literal call sites get statically replaced) — `globAssets` tolerates the throw and falls through to the filesystem glob, and `__nativeGlob` is not yet installed when module-top-level `globAssets` calls run (installAssetGlob fires inside `createNativeHost`, after the entry graph evaluates).

Windows binaries are stamped with version info and icons by `package-native.mjs` via `resedit` (in-place `.rsrc` regeneration — the `.bun` trailer is preserved).

