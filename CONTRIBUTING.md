# Contributing to DownDraft

Thanks for your interest. DownDraft is early-stage and still moving — small,
focused PRs land fastest.

## Setup

See [`development.md`](./development.md) for the full setup. The short version:

```bash
git clone https://github.com/knackstedt/downdraft.git
cd downdraft
bun install                    # installs deps + fetches prebuilt native cdylibs
```

The `postinstall` fetch downloads and SHA-256-verifies native binaries from the
`native-v<version>` GitHub release. If it fails, build locally with
`bun run build:native` (requires a Rust toolchain).

## Testing your changes

```bash
bun run tsc          # TypeScript checks (both project configs)
bun run lint         # oxlint
bun test             # unit tests (bun test --isolate)
cargo check --manifest-path packages/platform-native/native-rs/Cargo.toml
```

`bun test` runs with `--isolate` because several suites load shared WASM/FFI
state that is not safe to share between test files in one process. `examples/packaging-smoke` is the self-contained end-to-end packaging check (the
`apps/` e2e harness targets separate app repos and does not run in CI).

## Conventions worth knowing

- **Tri-runtime**: engine and app code must run under Bun, Node+tsx, and Deno.
  Don't reach for `Bun.*`, `bun:ffi`, or `bun:test` in runtime code — use the
  `ffi-adapter.ts` / `platform/runtime.ts` abstractions.
- **Native ABI**: all Rust cdylibs export `dd_abi_version`, checked at library
  load. Bump it when the FFI surface changes incompatibly.
- **Regenerating exports**: `packages/engine/package.json`'s exports map is
  generated — run `node scripts/gen-engine-exports.mjs` after adding/removing a
  library or module directory.
- **Versioning**: the root `package.json` is the version source of truth; run
  `bun run bump:version` then `bun install` to keep `bun.lock` in sync.
- **`no-for-of` lint rule**: iteration over hot-path collections uses indexed
  loops to avoid iterator allocation overhead in per-frame code paths. The
  rule exists to keep accidental `for…of` out of render/sim hot loops — it is
  not a blanket ban on the syntax in cold code, but oxlint can't distinguish
  the two, so expect to either restructure or add a scoped disable.

See `AGENTS.md` for the full architecture notes and agent-facing rules.

## Reporting security issues

Please do **not** open public issues for security reports — see
[`SECURITY.md`](./SECURITY.md).
