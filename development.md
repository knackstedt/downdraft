# Development Setup

How to get the engine repo and a game (e.g. **sandjongg**) running locally.

## Prerequisites

- **git** and **curl**
- **Bun** — the repo's package manager, test runner, and default JS runtime:

  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

- **A graphical session** for `draft dev` (it opens a real winit window over
  X11/Wayland). On a headless box use the e2e tests instead, or set
  `DOWNDRAFT_GPU=swiftshader` for CPU rendering.
- **Rust/cargo** — *optional for running games, required for Rust-side
  development*. Normal setup uses prebuilt binaries (fetched below); you only
  need the toolchain to modify crates under `native/` dirs or when no prebuilt
  bundle exists for your platform. See "Building the native libraries".

## 1. Engine install

```bash
git clone git@github.com:knackstedt/downdraft.git
cd downdraft
bun install
```

The `@downdraft/platform-native` postinstall automatically downloads the
prebuilt native cdylibs (`downdraft-native-<platform>-<arch>.tar.gz`) from the
`native-v<version>` GitHub release — no Rust toolchain required. If the fetch
is skipped (offline, missing release artifact), run it manually:

```bash
bun run fetch:native   # in packages/platform-native
# or build from source instead:
bun run build:native   # requires cargo — see next section
```

### Building the native libraries (Rust)

The Rust cdylibs (`libdowndraft_platform`, audio, physics, blitz, devtools,
gamepad, secrets) live in the root Cargo workspace under `packages/*/native*/`.
Install the toolchain and system deps, then build:

```bash
# Toolchain — rust-toolchain.toml pins the channel, so plain `cargo` picks it up
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Linux system deps (same set CI installs in native.yml):
#   pkg-config deps for the -sys crates (cpal→alsa, gilrs→libudev,
#   winit→wayland/xkbcommon); cc for linking; python3 for stylo's mako codegen
sudo apt-get install build-essential pkg-config python3 \
  libasound2-dev libudev-dev libwayland-dev libxkbcommon-dev

# Build all crates for the host (release) and stage into <crate>/dist/
bun run build:native
# or a subset / different flavor:
node scripts/build-native.mjs --pkg=downdraft-platform --debug
node scripts/build-native.mjs --target=x86_64-pc-windows-msvc   # cross-compile
```

Locally built libs land in `dist/` dirs that `lib-paths.ts` searches *before*
the fetched `native/<platform>-<arch>/` copies, so your changes take effect
immediately on the next launch. Cross-compiles and Android builds need extra
targets (`rustup target add <triple>`) and, for Android, the NDK — see
`AGENTS.md`.

## 2. Clone a game into `games/`

Games are separate repos that consume `@downdraft/*` packages. By convention
they're cloned under `games/` in this repo (the whole directory is gitignored).

```bash
mkdir -p games
git clone git@github.com:knackstedt/sandjongg.git games/sandjongg
```

A directory counts as a game when it has `downdraft.config.json` or
`src/native-entry.ts`.

## 3. Install the game, then link the engine

Order matters — `bun install` in the game resolves `@downdraft/*` from npm,
and `link:games` then replaces those with symlinks into this repo:

```bash
cd games/sandjongg && bun install && cd ../..
bun run link:games
```

`link:games` symlinks every `@downdraft/*` workspace package into the game's
`node_modules` and adds a `node_modules/.bin/draft` shim. Re-run it after any
`bun install` inside a game (bun will have reverted the links to npm copies).

## 4. Run sandjongg

```bash
cd games/sandjongg
draft dev          # native window + tiered HMR (default)
# or:
bun run dev        # same thing
bun run src/native-entry.ts   # direct boot, no dev shell / no HMR
```

Other runtimes for the dev shell: `draft dev --runtime=node` (tsx + koffi) or
`--runtime=deno`. Success looks like: `bindings installed (gpu, image, assets,
dom)` → `first swapchain acquire ok` → `game-renderer initialized` → MCP
automation harness registered.

## 5. Verify / test

```bash
bun run draft:test -- --game sandjongg          # e2e smoke via MCP harness
DOWNDRAFT_GPU=swiftshader bun test tests/e2e/sandjongg-smoke.spec.ts  # headless
bun run tsc        # engine typecheck
bun run lint       # oxlint
```

## Troubleshooting

- **`draft` not found**: run `bun run link:games` at the repo root (it creates
  the game's `node_modules/.bin/draft` shim), or invoke the CLI via the root
  `node_modules/.bin/draft`.
- **Native lib load errors**: binaries aren't committed — check
  `packages/platform-native/native/<platform>-<arch>/` exists; if not, run
  `bun run fetch:native` or `bun run build:native`.
- **Game resolves npm `@downdraft/*` instead of the local engine**: you ran
  `bun install` in the game after linking — re-run `bun run link:games`.

For engine internals (module contracts, SAB protocols, packaging, Android),
see `AGENTS.md`.
