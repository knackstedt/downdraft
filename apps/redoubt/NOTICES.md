# Third-party notices — Redoubt

Redoubt bundles or downloads pinned builds of the following tools. Both
licenses permit redistribution in unmodified binary form.

## kopia — Apache License 2.0

- Version: **v0.23.1**
- Source: https://github.com/kopia/kopia
- License: https://github.com/kopia/kopia/blob/master/LICENSE (Apache-2.0)
- Pinned SHA-256 (linux-amd64): `416d0f84a3dbb321a8b2d8f0997b1a0a6e915babe79ee76fa6e4d2bd1e1c5178`
- Pinned SHA-256 (linux-arm64): `a4ffbc019e0b0f932e2632054e73ec521dc1e80172a00095369c53ecf4e5a6cb`

Kopia performs repository operations: snapshot create/list/delete,
restore, policy, FUSE mount, `repository sync-to` mirroring. Its rclone
storage provider is marked by upstream as less-tested — Redoubt uses it
per the product requirement of "every backend through rclone".

## rclone — MIT License

- Version: **v1.76.0**
- Source: https://github.com/rclone/rclone
- License: https://github.com/rclone/rclone/blob/master/COPYING (MIT)
- Pinned SHA-256 (linux-amd64): `b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7`
- Pinned SHA-256 (linux-arm64): `ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78`

rclone provides remote storage access (Proton Drive, S3, B2, SFTP,
WebDAV, OAuth providers…), free-space probes (`rclone about`), and the
sync/bisync engine.

## Cryptography (Rust crates)

| Crate | Use | License |
|---|---|---|
| argon2 | passphrase KDF (Argon2id) | MIT/Apache-2.0 |
| chacha20poly1305 | keybox AEAD (XChaCha20-Poly1305) | MIT/Apache-2.0 |
| ml-kem | ML-KEM-768 KEM (FIPS 203) | Apache-2.0 |
| x25519-dalek | X25519 ECDH (hybrid KEM) | BSD-3-Clause |
| hkdf + sha2 | HKDF-SHA256 combiner | MIT/Apache-2.0 |
| rusqlite | snapshot catalog | MIT |
| keyring | OS keychain integration | MIT/Apache-2.0 |

Full dependency graph: `apps/redoubt/daemon/Cargo.lock`.
