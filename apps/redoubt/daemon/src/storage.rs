//! storage.rs — free-space pre-flight checks.
//!
//! Before a backup runs we estimate the incoming delta and compare it to
//! free space on the repository's storage:
//!
//!   - filesystem repos → `rclone about local:<path>` (one code path reuses
//!     the rclone module; statvfs under the hood)
//!   - rclone repos → `rclone about <remote>:` (null fields where the remote
//!     can't report → "unknown")
//!
//! Estimates: first run = a quick source-dir size walk (no exclude matching —
//! upper bound); later runs = last snapshot's total size × DELTA_FRACTION
//! with a floor (incrementals are small).

use serde_json::json;
use serde_json::Value;

use crate::config::RepoLocation;

const DELTA_FRACTION: f64 = 0.15;
const DELTA_FLOOR: u64 = 64 * 1024 * 1024; // 64 MiB
const WARN_FREE_FLOOR: u64 = 5 * 1024 * 1024 * 1024; // 5 GiB
const WARN_FACTOR: f64 = 2.0;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCheck {
    pub ok: bool,
    pub warn: bool,
    pub free: Option<u64>,
    pub total: Option<u64>,
    pub estimate: u64,
    pub reason: String,
}

/// Quick recursive byte-total over a local dir (errors skipped — permission
/// denials shouldn't block an estimate).
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            } else if md.is_file() {
                total = total.saturating_add(md.len());
            }
        }
    }
    total
}

/// Estimated incoming bytes for the next run of this plan's sources.
pub fn estimate_delta(sources: &[String], last_snapshot_bytes: Option<u64>) -> u64 {
    match last_snapshot_bytes {
        Some(sz) => ((sz as f64) * DELTA_FRACTION) as u64 | DELTA_FLOOR as u64,
        None => sources
            .iter()
            .map(|s| dir_size(std::path::Path::new(s)))
            .sum::<u64>()
            .max(DELTA_FLOOR),
    }
}

fn remote_for(loc: &RepoLocation) -> String {
    match loc {
        RepoLocation::Filesystem { path } => format!("local:{path}"),
        RepoLocation::Rclone { remote, .. } => remote.clone(),
    }
}

/// Free-space probe → StorageCheck. `estimate` = expected incoming bytes.
/// `force` bypasses the block (UI passes it from a "run anyway" action).
pub async fn check(loc: &RepoLocation, estimate: u64, force: bool) -> StorageCheck {
    let remote = remote_for(loc);
    let about = crate::rclone::about(&remote).await;
    let Ok(about) = about else {
        return StorageCheck {
            ok: true,
            warn: true,
            free: None,
            total: None,
            estimate,
            reason: format!("free space unknown ({}): {}", remote, about.unwrap_err()),
        };
    };
    let free = about.get("free").and_then(Value::as_u64);
    let total = about.get("total").and_then(Value::as_u64);
    let Some(free) = free else {
        return StorageCheck {
            ok: true,
            warn: false,
            free: None,
            total,
            estimate,
            reason: "remote doesn't report free space".into(),
        };
    };
    if free < estimate && !force {
        return StorageCheck {
            ok: false,
            warn: true,
            free: Some(free),
            total,
            estimate,
            reason: format!("not enough free space: {free} < estimated {estimate}"),
        };
    }
    let warn = free < (estimate as f64 * WARN_FACTOR) as u64 || free < WARN_FREE_FLOOR;
    StorageCheck {
        ok: true,
        warn,
        free: Some(free),
        total,
        estimate,
        reason: if warn { "storage running low" } else { "ok" }.into(),
    }
}

pub fn warning_event(loc: &RepoLocation, check: &StorageCheck) -> serde_json::Value {
    json!({
        "location": format!("{loc:?}"),
        "free": check.free,
        "total": check.total,
        "estimate": check.estimate,
        "reason": check.reason,
    })
}
