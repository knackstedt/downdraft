//! engine/mod.rs — the backup-engine adapter contract.
//!
//! Everything engine-specific lives behind `EngineAdapter` so a ResticAdapter
//! can land later without touching scheduling/retention/IPC. Kopia is the v1
//! implementation (engine/kopia.rs).
//!
//! All methods take the repository password explicitly — the caller resolves
//! it from the keyring/keybox unlock cache (state.rs).

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::config::{RepoLocation, Repository};

pub mod kopia;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub user: String,
    pub start_time: u64,
    pub end_time: u64,
    pub size_bytes: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RepoStats {
    pub total_size_bytes: u64,
    pub snapshot_count: u64,
    pub raw: serde_json::Value,
}

/// A live FUSE mount child — dropping/killing it unmounts (phase 5).
#[allow(dead_code)]
pub struct MountHandle {
    pub child: tokio::process::Child,
    pub dir: std::path::PathBuf,
}

#[async_trait::async_trait]
pub trait EngineAdapter: Send + Sync {
    /// `kopia repository create <provider>` — also connects (config file is
    /// written by this call).
    async fn create_repository(&self, repo: &Repository, password: &str) -> Result<()>;

    /// `kopia repository connect <provider>` — needed when the local config
    /// file was lost (new machine / wiped config dir).
    async fn connect(&self, repo: &Repository, password: &str) -> Result<()>;

    /// One snapshot of `source` — returns the created manifest.
    async fn snapshot_create(
        &self,
        repo: &Repository,
        source: &str,
        password: &str,
        tags: &[(String, String)],
        ignore_patterns: &[String],
    ) -> Result<SnapshotInfo>;

    async fn snapshot_list(&self, repo: &Repository, password: &str) -> Result<Vec<SnapshotInfo>>;

    async fn snapshot_delete(&self, repo: &Repository, snap_id: &str, password: &str) -> Result<()>;

    /// Restore `snap_id` (or `snap_id/sub/path`) into `target` dir.
    async fn restore(&self, repo: &Repository, snap_ref: &str, target: &str, password: &str) -> Result<()>;

    /// `kopia repository status` — raw text + parsed headline numbers.
    async fn repository_status(&self, repo: &Repository, password: &str) -> Result<String>;

    /// `kopia maintenance run` — compaction/GC after retention culls (phase 4).
    #[allow(dead_code)]
    async fn maintenance(&self, repo: &Repository, password: &str) -> Result<()>;

    /// `kopia repository sync-to <dest>` — mirror this repo to another
    /// location (the N-target multiplexing path).
    async fn sync_to(&self, repo: &Repository, dest: &RepoLocation, password: &str) -> Result<()>;

    /// `kopia mount all <dir>` — FUSE browse of every snapshot (phase 5).
    /// Caller owns the child; killing it unmounts.
    #[allow(dead_code)]
    async fn mount(&self, repo: &Repository, dir: &Path, password: &str) -> Result<MountHandle>;
}
