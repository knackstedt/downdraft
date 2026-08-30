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

The sim worker supervisor automatically restarts on first crash from a DB checkpoint. If a second crash occurs in a short window, the render loop halts with a fatal error.

1. Check the console output for the crash reason
2. Try running in debug mode for more verbose logging:
   ```bash
   draft dev --game=<game-name> --verbose
   ```
3. If the crash is reproducible, use MCP `checkpoint` tools to save state before the crash point

## Native Audio Module Not Loading

**Symptom:** Audio doesn't play, console shows FFI errors.

**Solutions:**

1. Ensure the native audio library is built:
   ```bash
   cd packages/audio-native && ./build.sh
   ```
2. Verify the library exists for your platform in the expected path
3. Check that Rust is installed if building from source

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
   draft release --stage=build --mode=prod --out=dist --sourcemap
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

This is a known X11 issue where `requestAnimationFrame` fires at the fastest monitor's refresh rate. Use the frame rate limiter:

```typescript
renderer.setFrameRateLimit(60); // or your monitor's refresh rate
```

## Blank Screen / White Screen

**Symptom:** Electron window opens but shows a blank or white screen.

**Solutions:**

1. Check the DevTools console (Ctrl+Shift+I) for errors
2. Ensure WebGPU is available (see above)
3. Try running in dev mode to see detailed error messages
4. Check that the correct game is being loaded (pass `--game=<name>` to `draft dev`)
