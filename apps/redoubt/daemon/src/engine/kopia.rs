//! engine/kopia.rs — EngineAdapter for kopia.
//!
//! One kopia config file per repository (`<data_dir>/kopia/<repo-id>.config`),
//! a shared cache dir, the repo password passed via KOPIA_PASSWORD env (never
//! argv). rclone-backed repos route through kopia's rclone provider, which
//! spawns `rclone serve webdav` internally — covering every rclone remote.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::bins::{self, Tool};
use crate::config::{data_dir, RepoLocation, Repository};

use super::{EngineAdapter, MountHandle, SnapshotInfo};

pub struct KopiaAdapter {
    bin: PathBuf,
    rclone: Option<PathBuf>,
}

impl KopiaAdapter {
    pub fn new() -> anyhow::Result<Self> {
        let bin = bins::resolve(Tool::Kopia)
            .ok_or_else(|| anyhow::anyhow!("kopia binary not found — set REDOUBT_KOPIA_BIN or run bins.ensure"))?;
        Ok(Self { bin, rclone: bins::resolve(Tool::Rclone) })
    }

    /// When the binary wasn't resolvable at construction, retry (post-download).
    #[allow(dead_code)]
    pub fn available() -> bool {
        bins::resolve(Tool::Kopia).is_some()
    }
}

fn cfg_file(repo: &Repository) -> PathBuf {
    data_dir().join("kopia").join(format!("{}.config", repo.id))
}

fn cache_dir() -> PathBuf {
    data_dir().join("kopia-cache")
}

/// CLI args for the repository location, shared by create/connect/sync-to.
fn location_args(loc: &RepoLocation, verb: &str, rclone: &Option<PathBuf>) -> Vec<String> {
    match loc {
        RepoLocation::Filesystem { path } => vec!["filesystem".into(), format!("--path={path}")],
        RepoLocation::Rclone { remote, path } => {
            let mut v = vec![
                "rclone".into(),
                format!("--remote-path={remote}:{path}"),
            ];
            if let Some(bin) = rclone {
                v.push(format!("--rclone-exe={}", bin.display()));
            }
            // Always point at the daemon-managed rclone.conf — never the
            // user's default file.
            v.push(format!(
                "--rclone-args=--config={}",
                crate::rclone::config_path().display()
            ));
            let _ = verb;
            v
        }
    }
}

async fn run(bin: &Path, args: &[String], password: &str) -> anyhow::Result<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("KOPIA_PASSWORD", password)
        .env("KOPIA_CHECK_FOR_UPDATES", "0")
        .env("KOPIA_CACHE_DIRECTORY", cache_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().with_context(|| format!("spawning {}", bin.display()))?;
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut s) = child.stdout.take() {
        s.read_to_string(&mut out).await.ok();
    }
    if let Some(mut s) = child.stderr.take() {
        s.read_to_string(&mut err).await.ok();
    }
    let status = child.wait().await?;
    if !status.success() {
        let tail: Vec<&str> = err.trim().lines().collect();
        let msg = tail.last().copied().unwrap_or("unknown kopia error");
        bail!("kopia {}: {msg}", args.first().map(String::as_str).unwrap_or(""));
    }
    Ok(out)
}

fn base_args(repo: &Repository) -> Vec<String> {
    vec![
        format!("--config-file={}", cfg_file(repo).display()),
        "--disable-file-logging".into(),
    ]
}

// ── JSON shapes (kopia --json output) ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KSnapshot {
    id: String,
    source: KSource,
    #[serde(default)]
    start_time: String,
    #[serde(default)]
    end_time: String,
    #[serde(default)]
    root_entry: Option<KRoot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KSource {
    #[serde(default)]
    host: String,
    #[serde(default)]
    user_name: String,
    path: String,
}

#[derive(Deserialize)]
struct KRoot {
    #[serde(default)]
    summ: Option<KSumm>,
}

#[derive(Deserialize)]
struct KSumm {
    #[serde(default)]
    size: u64,
    #[serde(default)]
    files: u64,
}

fn parse_time(s: &str) -> u64 {
    // RFC3339 → ms. Kopia stamps nanoseconds; chrono isn't a dep — parse via
    // a small hand-rolled path: strip to seconds + Z, use time crate? Keep it
    // dependency-free: jiff-free epoch parse via `date`-free math is brittle;
    // use time-rs? We have none — do a minimal parse.
    parse_rfc3339_ms(s).unwrap_or(0)
}

/// Minimal RFC3339 (…Z) → unix ms. Nonconforming input → None.
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    let (date, time) = s.split_once('T')?;
    let time = time.trim_end_matches('Z');
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut d = date.split('-');
    let (y, m, day) = (
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<u32>().ok()?,
    );
    let mut t = hms.split(':');
    let (hh, mm, ss) = (
        t.next()?.parse::<u32>().ok()?,
        t.next()?.parse::<u32>().ok()?,
        t.next()?.parse::<u32>().ok()?,
    );
    // days since epoch (civil → days, Howard Hinnant's algorithm)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hh as i64 * 3600 + mm as i64 * 60 + ss as i64;
    let frac_ms = frac
        .get(..3)
        .and_then(|f| f.parse::<u64>().ok())
        .map(|f| f * 10u64.pow(3 - frac.len().min(3) as u32))
        .unwrap_or(0);
    Some((secs * 1000 + frac_ms as i64) as u64)
}

impl From<KSnapshot> for SnapshotInfo {
    fn from(k: KSnapshot) -> Self {
        let (size, files) = k
            .root_entry
            .and_then(|r| r.summ)
            .map(|s| (s.size, s.files))
            .unwrap_or((0, 0));
        SnapshotInfo {
            id: k.id,
            source: k.source.path,
            host: k.source.host,
            user: k.source.user_name,
            start_time: parse_time(&k.start_time),
            end_time: parse_time(&k.end_time),
            size_bytes: size,
            file_count: files,
        }
    }
}

#[async_trait::async_trait]
impl EngineAdapter for KopiaAdapter {
    async fn create_repository(&self, repo: &Repository, password: &str) -> anyhow::Result<()> {
        if let Some(dir) = cfg_file(repo).parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut args = base_args(repo);
        args.push("repository".into());
        args.push("create".into());
        args.extend(location_args(&repo.location, "create", &self.rclone));
        match run(&self.bin, &args, password).await {
            Ok(_) => Ok(()),
            // A repo already lives there — adopt it by connecting instead of
            // failing. The caller's keybox is authoritative: if `password`
            // doesn't match the existing repo the connect errors honestly.
            Err(e) if format!("{e}").contains("existing data") || format!("{e}").contains("invalid repository password") => {
                self.connect(repo, password).await
            }
            Err(e) => Err(e),
        }
    }

    async fn connect(&self, repo: &Repository, password: &str) -> anyhow::Result<()> {
        let mut args = base_args(repo);
        args.push("repository".into());
        args.push("connect".into());
        args.extend(location_args(&repo.location, "connect", &self.rclone));
        run(&self.bin, &args, password).await.map(|_| ())
    }

    async fn snapshot_create(
        &self,
        repo: &Repository,
        source: &str,
        password: &str,
        tags: &[(String, String)],
        ignore_patterns: &[String],
    ) -> anyhow::Result<SnapshotInfo> {
        // Kopia has no per-snapshot ignore flag — ignore rules live in the
        // per-source policy. Apply the profile's patterns first (idempotent;
        // they persist in the repo alongside .kopiaignore file support).
        if !ignore_patterns.is_empty() {
            let mut args = base_args(repo);
            args.extend(["policy".into(), "set".into(), source.into()]);
            for pat in ignore_patterns {
                args.push(format!("--add-ignore={pat}"));
            }
            run(&self.bin, &args, password).await?;
        }
        let mut args = base_args(repo);
        args.push("snapshot".into());
        args.push("create".into());
        args.push("--json".into());
        for (k, v) in tags {
            args.push(format!("--tags={k}:{v}"));
        }
        args.push(source.into());
        let out = run(&self.bin, &args, password).await?;
        // --json emits one manifest object; logs may precede it — take the
        // last line that parses as a manifest.
        let mut last_err = anyhow::anyhow!("no snapshot manifest in kopia output");
        for line in out.lines() {
            if let Ok(snap) = serde_json::from_str::<KSnapshot>(line) {
                return Ok(snap.into());
            }
            if line.trim_start().starts_with('{') {
                last_err = anyhow::anyhow!("unparseable manifest line");
            }
        }
        Err(last_err)
    }

    async fn snapshot_list(&self, repo: &Repository, password: &str) -> anyhow::Result<Vec<SnapshotInfo>> {
        let mut args = base_args(repo);
        args.extend(["snapshot".into(), "list".into(), "-a".into(), "--json".into()]);
        let out = run(&self.bin, &args, password).await?;
        let snaps: Vec<KSnapshot> = serde_json::from_str(out.trim())
            .with_context(|| format!("parsing snapshot list: {}", &out[..out.len().min(200)]))?;
        Ok(snaps.into_iter().map(Into::into).collect())
    }

    async fn snapshot_delete(&self, repo: &Repository, snap_id: &str, password: &str) -> anyhow::Result<()> {
        let mut args = base_args(repo);
        args.extend(["snapshot".into(), "delete".into(), snap_id.into(), "--delete".into()]);
        run(&self.bin, &args, password).await.map(|_| ())
    }

    async fn restore(&self, repo: &Repository, snap_ref: &str, target: &str, password: &str) -> anyhow::Result<()> {
        std::fs::create_dir_all(target)?;
        let mut args = base_args(repo);
        args.extend(["restore".into(), snap_ref.into(), target.into()]);
        run(&self.bin, &args, password).await.map(|_| ())
    }

    async fn repository_status(&self, repo: &Repository, password: &str) -> anyhow::Result<String> {
        let mut args = base_args(repo);
        args.extend(["repository".into(), "status".into()]);
        run(&self.bin, &args, password).await
    }

    async fn maintenance(&self, repo: &Repository, password: &str) -> anyhow::Result<()> {
        let mut args = base_args(repo);
        args.extend(["maintenance".into(), "run".into()]);
        run(&self.bin, &args, password).await.map(|_| ())
    }

    async fn sync_to(&self, repo: &Repository, dest: &RepoLocation, password: &str) -> anyhow::Result<()> {
        let mut args = base_args(repo);
        args.push("repository".into());
        args.push("sync-to".into());
        args.extend(location_args(dest, "sync-to", &self.rclone));
        run(&self.bin, &args, password).await.map(|_| ())
    }

    async fn mount(&self, repo: &Repository, dir: &Path, password: &str) -> anyhow::Result<MountHandle> {
        std::fs::create_dir_all(dir)?;
        let mut args = base_args(repo);
        args.extend(["mount".into(), "all".into(), dir.to_string_lossy().into_owned()]);
        let mut cmd = Command::new(&self.bin);
        cmd.args(&args)
            .env("KOPIA_PASSWORD", password)
            .env("KOPIA_CHECK_FOR_UPDATES", "0")
            .env("KOPIA_CACHE_DIRECTORY", cache_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let child = cmd.spawn().context("spawning kopia mount")?;
        Ok(MountHandle { child, dir: dir.to_path_buf() })
    }
}
