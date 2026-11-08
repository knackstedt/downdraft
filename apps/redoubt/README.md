# Redoubt

A Linux backup tool — like Déjà Dup, but more capable — built as a Downdraft
native app + a lightweight Rust daemon (`redoubtd`).

## Architecture

```
┌──────────────────────────┐   JSON-RPC / unix socket   ┌─────────────────┐
│  Downdraft window (UI)   │ ◄────────────────────────► │    redoubtd     │
│  apps/redoubt/src        │                            │  daemon/src     │
└──────────────────────────┘                            └────┬────────────┘
                                                             │
                                    ┌────────────────────────┼────────────┐
                                    ▼                        ▼            ▼
                                 kopia (snapshots,      rclone (remotes, keybox.json
                                  repos, mounts)         sync, about)   (Argon2id +
                                                                        X25519+ML-KEM)
```

- **Daemon** owns all state: config (`~/.config/redoubt`), the kopia/rclone
  binaries, repository keyboxes, the SQLite snapshot catalog, FUSE mounts,
  the scheduler, and the OS keychain entries.
- **UI** is a thin client — secrets never cross the socket.

## Concepts

| Thing | What it is |
|---|---|
| **Repository** | A kopia repository — filesystem dir or `remote:path` on any rclone remote (incl. Proton Drive). Encrypted with a generated 256-bit password stored in a wrapped keybox. |
| **Plan** | Sources → repository, a schedule, and retention (keep ≥N snapshots AND ≤N days). |
| **Target** | An rclone remote or a plain local folder used by repos and syncs. |
| **Sync job** | `rclone sync` (one-way push or pull) or `rclone bisync` (two-way) on a schedule — replication, not snapshots. |
| **Recovery key** | Hybrid X25519 + ML-KEM-768 recipient slot — unlocks a repository without the passphrase. Shown once at creation. |

## Features implemented

- Local + rclone-remote repositories (kopia rclone provider; pinned,
  sha256-verified binary downloads with `bins.ensure`)
- Exclusion profiles (caches, Steam/VMs, node_modules…, `.kopiaignore`
  honored) applied via kopia policy
- Scheduled + on-demand backups with progress events; missed-run catch-up;
  USB target-available triggers
- Retention: max-age cull honoring min-count floor + maintenance
- Storage pre-flight: free-space probe blocks/warns before a run
- Password revalidation reminders (30d default)
- Browse snapshots (`browse.ls`), sqlite catalog + Filelight-style sunburst
  (snapshot contents and local disk), FUSE mount-all browsing
- Full + selective restore
- Sync jobs: push, pull, or bisync
- Repo mirroring to N targets (`kopia repository sync-to`) after each run
- Passwordless unlock via OS keychain + hybrid-PQC recovery keys
- Desktop notifications via `notify-send`

## Daemon RPC sketch

Unix socket at `$XDG_RUNTIME_DIR/downdraft-redoubt/daemon.sock`, JSON-RPC 2.0
newline-delimited:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"daemon.status"}' | nc -U /run/user/$UID/downdraft-redoubt/daemon.sock
```

Key methods: `repo.create/list/unlock/passwordVerify`, `plan.create/list/
runNow`, `snapshot.list/restore/delete`, `browse.ls`, `catalog.build/tree`,
`mount.start/stop/list`, `restore.selective`, `target.*` (rclone remotes),
`sync.create/runNow`, `keybox.addRecipient/recover`, `disk.scan`, `job.list`,
`bins.status/ensure`.

Env overrides for dev/testing: `REDOUBT_SOCK`, `REDOUBT_CONFIG_DIR`,
`REDOUBT_DATA_DIR`, `REDOUBT_KOPIA_BIN`, `REDOUBT_RCLONE_BIN`.

## systemd

`packaging/redoubtd.service` — a user unit to keep scheduled backups running
without launching the UI:

```sh
cp packaging/redoubtd.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now redoubtd
```

## Dev

```sh
cargo build --manifest-path apps/redoubt/daemon/Cargo.toml
bunx draft test --app redoubt        # e2e incl. real backup roundtrip
```

Third-party license notices: `NOTICES.md`.
