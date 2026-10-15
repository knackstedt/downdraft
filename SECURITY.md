# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than through public issues:

- Use **GitHub private vulnerability reporting** on this repository
  (Security → "Report a vulnerability"), or
- Email the maintainer listed on the GitHub profile
  (<https://github.com/knackstedt>).

Please include reproduction steps and the affected versions/commit. We aim to
acknowledge reports within a week.

## Scope notes

A few areas are worth keeping in mind when evaluating DownDraft:

- **Prebuilt native binaries** are downloaded at `postinstall` from GitHub
  releases and verified against published SHA-256 checksums; a mismatch aborts
  the install. These cdylibs run in-process with full privileges.
- **MCP endpoint** (`draft dev`, `draft mcp run`) binds to loopback only,
  enforces Host/Origin checks, and requires a bearer token by default
  (`MCP_AUTH=0` opts out explicitly). The token is written mode-0600 to
  `~/.downdraft/port/<pid>.token`.
- **Plugins/mods**: `wasm` and `quickjs` plugin formats are hard-isolated;
  `worker-js` plugins are **not** a security sandbox — they run with the host
  runtime's privileges and can reach `node:fs`, FFI, and the network unless
  the runtime is launched restricted. Remote workshop packs are a
  supply-chain surface.
