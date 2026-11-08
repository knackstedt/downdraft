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

/// A filesystem entry inside a snapshot (browse/catalog row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    /// Path relative to the snapshot root ("" = root itself).
    pub path: String,
    pub size: u64,
    /// kopia content/object id — doubles as the address for `ls <objId>`
    /// and selective `restore <objId>`.
    pub object_id: String,
    pub is_dir: bool,
    /// ms epoch
    pub mtime: u64,
}

/// A live FUSE mount child — killing it on drop unmounts.
#[allow(dead_code)]
pub struct MountHandle {
    pub child: tokio::process::Child,
    pub dir: std::path::PathBuf,
}

impl Drop for MountHandle {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
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

    /// List one directory level inside a snapshot — `kopia ls -l <objId>`.
    async fn browse(&self, repo: &Repository, object_id: &str, password: &str) -> Result<Vec<FsEntry>>;

    /// Full recursive listing — `kopia ls -r -l <snapshotId>` — feeds the
    /// catalog/sunburst. Returns flat entries with relative paths.
    async fn catalog_dump(&self, repo: &Repository, snapshot_id: &str, password: &str) -> Result<Vec<FsEntry>>;

    /// `kopia restore <objectId> <dir>` — restore one object (file or dir
    /// subtree) rather than a whole snapshot.
    async fn restore_object(&self, repo: &Repository, object_id: &str, target_dir: &Path, password: &str) -> Result<()>;

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
