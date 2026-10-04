---
title: Packaging & Distribution
description: Shipping a game — runtime matrix (bun/node/deno), linux formats (.deb, AppImage, Flatpak), the package.json build block, and native artifact staging
---

`draft release --target=linux` runs an electron-builder-style packager (`packages/cli/scripts/package-desktop.mjs`) that produces real distribution formats — not just a bare binary. A game picks the JS runtime(s) it ships on; the engine doesn't force plurality.

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
native/          engine libdowndraft_*.so + game-native .so/.node
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

Electron-builder-style configuration lives in the game's `package.json`. CLI flags override it per invocation.

```jsonc
{
  "name": "my-game",
  "version": "0.1.0",
  "build": {
    "appId": "com.studio.mygame",
    "productName": "My Game",
    "runtime": "node",                  // default runtime for --runtime
    "executableName": "my-game",
    "icon": "assets/icon.png",
    "files": ["README.md", "LICENSE"],  // copied into the appdir root
    "linux": {
      "target": ["deb", "AppImage", "flatpak"], // default for --format
      "category": "Game",
      "maintainer": "Studio <hello@studio.example>",
      "synopsis": "Short launcher description",
      "description": "Longer package description",
      "icon": "assets/icon-256.png"
    },
    "deb": {
      "section": "games",
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

Game-owned Rust artifacts in `<game>/native/dist/<platform>-<arch>/` are staged into `native/` beside the engine cdylibs — both `.so`/`.dll`/`.dylib` (C-ABI FFI) and `.node` (napi-rs) files. `.node` addons load under all three desktop runtimes (Node natively, Bun's napi impl, Deno's node-api layer). See [Native Modules (Rust)](/guides/native-modules/) for the crate-side conventions.

## System requirements for each builder

| Format | Required tool |
|---|---|
| `dir` | none (bundled with the engine) |
| `deb` | `dpkg-deb` |
| `appimage` | none — `appimagetool` auto-downloads on first use |
| `flatpak` | `flatpak-builder` + a Flatpak runtime/SDK matching `build.flatpak.runtimeVersion` |

## Verifying a package

`dir` and extracted `.deb` trees run in place. For AppImage without FUSE use `./MyGame.AppImage --appimage-extract-and-run`. Flatpak bundles install per-user (`flatpak install --user <bundle>`) and run via `flatpak run <appId>`.
