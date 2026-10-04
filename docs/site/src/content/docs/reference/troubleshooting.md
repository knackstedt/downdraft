---
title: Troubleshooting
description: Common issues and solutions
---

## WebGPU Not Available

**Symptom:** Renderer fails to initialize or shows a blank canvas.

**Solutions:**

1. Ensure you're running on a GPU with WebGPU support
2. Update your GPU drivers to the latest version
3. On Linux, ensure proper Vulkan drivers are installed:
   ```bash
   # Debian/Ubuntu
   sudo apt install mesa-vulkan-drivers vulkan-tools

   # Fedora
   sudo dnf install mesa-vulkan-drivers vulkan-tools

   # Arch
   sudo pacman -S vulkan-driver vulkan-tools
   ```
4. Verify Vulkan is working:
   ```bash
   vulkaninfo
   ```

## Sim Worker Crash

**Symptom:** Error banner appears, simulation freezes.

**Solutions:**

The sim worker supervisor automatically restarts once from a checkpoint. If a second crash occurs in a short window, the render loop halts with a fatal error.

1. Check the console output for the crash reason
2. Try running in debug mode for more verbose logging:
   ```bash
   cd <game-directory> && draft dev --verbose
   ```
3. If the crash is reproducible, use MCP `checkpoint` tools to save state before the crash point

## Native Audio Module Not Loading

**Symptom:** Audio doesn't play, console shows FFI errors.

**Solutions:**

1. The Kira backend (`KiraAudioBackend` / `AudioKiraLib` in `libraries/audio-kira`) loads the `libdowndraft_audio` cdylib over FFI; set `AUDIO_NATIVE_PATH` to point at a specific build.
2. Build the cdylib with `cargo build -p downdraft-audio` (crate under `packages/engine/libraries/audio-kira/native`).

## Deno Runtime Issues

**Symptom:** `draft release` fails with `no libdowndraft_platform build found for linux-x64` after `deno install`, or `deno run src/native-entry.ts` fails with type-stripping errors.

**Solutions:**

1. `deno install` does not run npm lifecycle scripts, so `@downdraft/platform-native`'s postinstall (`native/fetch-native.mjs`) never downloads the engine cdylibs. Either also run `bun install`/`npm install` in the game directory (a normal `node_modules` layout is what the packager expects), or fetch them manually:

   ```bash
   node node_modules/@downdraft/platform-native/native/fetch-native.mjs
   ```

2. Direct `deno run` of the game entry is not supported — Deno refuses to strip TypeScript types from files under `node_modules` (upstream limitation; the published `@downdraft/*` packages ship TypeScript sources). Use the dev shell, which transforms the sources through Vite's ModuleRunner before Deno sees them:

   ```bash
   draft dev --runtime=deno
   ```

   No `deno.json` is required for this path. To make the choice persistent, set `"runtime": "deno"` in `downdraft.config.json`.

3. `deno install` enforces a minimum dependency age by default — freshly published `@downdraft/*` versions are rejected for ~24h. Pass `--minimum-dependency-age=0` (or wait) when consuming a just-published release.

## Build Fails

**Symptom:** `draft release --stage=build` (formerly `draft build`) fails.

**Solutions:**

1. Ensure all dependencies are installed:
   ```bash
   bun install
   ```
2. Clear the build cache:
   ```bash
   rm -rf dist out
   ```
3. Try building with verbose logging:
   ```bash
   draft release --stage=build --mode=prod --out=dist --verbose
   ```

## High CPU Usage in Dev Mode

**Symptom:** CPU usage is high even when the game is idle.

**Solutions:**

This is expected in dev mode due to telemetry, hot reload, and DevTools overhead. Use `prod` mode for performance testing:

```bash
draft release --stage=build --mode=prod --out=dist
```

## Frame Rate Issues on Multi-Monitor Linux (X11)

**Symptom:** Game runs too fast on multi-monitor X11 setups.

**Solutions:**

This is a known X11 issue where the render loop is driven at the fastest monitor's refresh rate. Use the frame rate limiter:

```typescript
renderer.setFrameRateLimit(60); // or your monitor's refresh rate
```

## Blank Screen / White Screen

**Symptom:** The native window opens but shows a blank or black screen.

**Solutions:**

1. Check the terminal output and the devtools overlay console for errors
2. Ensure WebGPU is available (see above)
3. Try running in dev mode to see detailed error messages
4. Check that the correct game is being loaded — run `draft dev` from inside the game directory (the game is inferred from the current directory)
