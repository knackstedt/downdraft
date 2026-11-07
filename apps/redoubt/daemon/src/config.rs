//! config.rs — daemon configuration model.
//!
//! Persisted as TOML at `$XDG_CONFIG_HOME/redoubt/config.toml` (fallback
//! `~/.config/redoubt/config.toml`). Wire types mirror
//! `apps/redoubt/src/protocol.ts` — keep serde names in sync (camelCase).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ── domain types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub location: RepoLocation,
    #[serde(default)]
    pub mirrors: Vec<Mirror>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "camelCase")]
pub enum RepoLocation {
    /// Local path — a directory on this filesystem or a mounted USB drive.
    Filesystem { path: String },
    /// Any rclone remote (`remote:path`) — kopia's rclone provider covers
    /// every backend rclone supports (incl. protondrive).
    Rclone { remote: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub id: String,
    pub location: RepoLocation,
    #[serde(default)]
    pub schedule: Option<Schedule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub sources: Vec<PlanSource>,
    pub repository_id: String,
    #[serde(default)]
    pub schedule: Option<Schedule>,
    #[serde(default)]
    pub retention: Retention,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSource {
    pub path: String,
    #[serde(default = "default_profile")]
    pub exclude_profile_id: String,
    #[serde(default)]
    pub extra_excludes: Vec<String>,
}

fn default_profile() -> String {
    "default".into()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    /// Never expire below this many snapshots for a plan's sources.
    #[serde(default = "default_min_count")]
    pub min_count: u32,
    /// Cull snapshots older than this (None = keep forever).
    #[serde(default)]
    pub max_age_days: Option<u32>,
}

fn default_min_count() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub rule: ScheduleRule,
    /// Also run when the target drive/remote becomes available (USB replug,
    /// network up). Useful for USB-folder targets.
    #[serde(default)]
    pub on_target_available: bool,
    /// Skip runs while on battery.
    #[serde(default)]
    pub on_ac_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduleRule {
    Interval { every_minutes: u32 },
    Hourly,
    Daily { hour: u32, minute: u32 },
    Weekly { weekday: u32, hour: u32, minute: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    pub kind: TargetKind,
    /// rclone remote name, or absolute path for kind "local".
    pub ref_: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Rclone,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJob {
    pub id: String,
    pub name: String,
    pub local_path: String,
    /// `remote:path` — any rclone remote.
    pub remote: String,
    #[serde(default)]
    pub direction: SyncDirection,
    #[serde(default)]
    pub schedule: Option<Schedule>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SyncDirection {
    /// `rclone sync` — mirror local→remote (destructive on remote).
    #[default]
    Oneway,
    /// `rclone bisync` — true two-way sync with conflict handling.
    Twoway,
}

/// A categorized, toggleable set of exclusion globs (gitignore syntax —
/// the `ignore` crate evaluates them for scans, kopia policy gets the same
/// patterns).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub categories: Vec<ExclusionCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionCategory {
    pub id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub patterns: Vec<String>,
}

// ── persisted config ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaemonConfig {
    #[serde(default)]
    pub repositories: Vec<Repository>,
    #[serde(default)]
    pub plans: Vec<Plan>,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub syncs: Vec<SyncJob>,
    #[serde(default)]
    pub exclusion_profiles: Vec<ExclusionProfile>,
    /// Password revalidation interval (days) — 0 disables reminders.
    #[serde(default = "default_remind_days")]
    pub password_reminder_days: u32,
}

fn default_remind_days() -> u32 {
    30
}

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("REDOUBT_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("redoubt")
}

/// Per-app data dir (catalog db, keyboxes, downloaded binaries) — used from
/// phase 2 onward.
#[allow(dead_code)]
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("REDOUBT_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("redoubt")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

impl DaemonConfig {
    pub fn load() -> Self {
        let path = config_path();
        match fs::read_to_string(&path) {
            Ok(text) => match toml::from_str(&text) {
                Ok(cfg) => cfg,
                Err(e) => {
                    tracing::warn!("config parse failed ({path:?}): {e} — starting empty");
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    /// Persist config — called by mutation RPCs in later phases.
    #[allow(dead_code)]
    pub fn save(&self) -> anyhow::Result<()> {
        let dir = config_dir();
        fs::create_dir_all(&dir)?;
        let tmp = dir.join("config.toml.tmp");
        fs::write(&tmp, toml::to_string_pretty(self)?)?;
        fs::rename(&tmp, config_path())?;
        Ok(())
    }
}
