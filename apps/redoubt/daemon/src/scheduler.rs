//! scheduler.rs — plan scheduling + retention culling.
//!
//! A 30s tick evaluates each enabled plan's next run: interval/hourly/daily/
//! weekly rules against `last_run_at` (persisted on the Plan). Missed runs
//! catch up once at daemon start (overdue > half the interval). USB-mount
//! triggers land in phase 6 via `notify_target_available`.
//!
//! After every successful backup the retention pass runs: snapshots older
//! than `retention.max_age_days` are deleted — but never below
//! `retention.min_count` per source — then `maintenance` compacts.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::time::interval;

use crate::config::{Plan, ScheduleRule};
use crate::engine::{EngineAdapter, SnapshotInfo};
use crate::ipc::{run_plan, DaemonState};
use crate::notify;

const TICK_SECS: u64 = 30;

/// Milliseconds until `rule` next fires, given `last` (ms epoch, 0 = never)
/// and `now`. None rule → never.
fn due_in_ms(rule: &ScheduleRule, last: u64, now: u64) -> Option<u64> {
    let elapsed = now.saturating_sub(last);
    match rule {
        ScheduleRule::Interval { every_minutes } => {
            let period = *every_minutes as u64 * 60_000;
            Some(if last == 0 || elapsed >= period { 0 } else { period - elapsed })
        }
        ScheduleRule::Hourly => {
            let period = 3_600_000;
            Some(if last == 0 || elapsed >= period { 0 } else { period - elapsed })
        }
        ScheduleRule::Daily { hour, minute } | ScheduleRule::Weekly { hour, minute, .. } => {
            let (h, m) = (*hour, *minute);
            let day_ms = 86_400_000;
            let now_time = now % day_ms;
            let target = (h as u64 * 3600 + m as u64 * 60) * 1000;
            let mut wait = if now_time < target { target - now_time } else { day_ms - (now_time - target) };
            if last == 0 && now_time >= target { wait = 0; }
            if let ScheduleRule::Weekly { weekday, .. } = rule {
                let wd = ((now / day_ms) + 4) % 7; // epoch = Thursday
                let target_wd = *weekday as u64;
                let days_ahead = (target_wd + 7 - wd) % 7;
                wait += days_ahead * day_ms;
            }
            // If it already ran within this window, push to the next window.
            if last != 0 && wait < day_ms && now - last < wait { wait += day_ms; }
            Some(wait)
        }
    }
}

/// Snapshots to delete for retention: keep ≥ min_count per source, cull
/// those older than max_age_days.
pub fn cull_set(snaps: &[SnapshotInfo], min_count: u32, max_age_days: Option<u32>, now: u64) -> Vec<String> {
    let Some(max_age) = max_age_days else { return vec![] };
    let cutoff = now.saturating_sub(max_age as u64 * 86_400_000);
    let mut by_source: std::collections::HashMap<&str, Vec<&SnapshotInfo>> = Default::default();
    for s in snaps {
        by_source.entry(s.source.as_str()).or_default().push(s);
    }
    let mut doomed = Vec::new();
    for (_, mut list) in by_source {
        // newest first
        list.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        let keep = min_count as usize;
        for s in list.iter().skip(keep) {
            if s.start_time < cutoff {
                doomed.push(s.id.clone());
            }
        }
    }
    doomed
}

async fn retention_pass(state: &Arc<DaemonState>, plan: &Plan) -> anyhow::Result<usize> {
    if plan.retention.max_age_days.is_none() {
        return Ok(0);
    }
    let engine = state.engine()?;
    let repo = state.get_repository(&plan.repository_id)?;
    let pw = state.repo_password_any(&repo.id)?;
    let snaps = engine.snapshot_list(&repo, &pw).await?;
    let now = crate::ipc::now_ms_pub();
    let doomed: Vec<String> = {
        let mine: Vec<SnapshotInfo> = snaps
            .into_iter()
            .filter(|s| plan.sources.iter().any(|src| s.source == src.path))
            .collect();
        cull_set(&mine, plan.retention.min_count, plan.retention.max_age_days, now)
    };
    if doomed.is_empty() {
        return Ok(0);
    }
    let n = doomed.len();
    for id in &doomed {
        if let Err(e) = engine.snapshot_delete(&repo, id, &pw).await {
            tracing::warn!("retention: delete {id} failed: {e}");
        }
    }
    let _ = engine.maintenance(&repo, &pw).await;
    state.emit("retention.culled", json!({ "planId": plan.id, "deleted": n }));
    tracing::info!("retention: culled {n} snapshot(s) for plan {}", plan.name);
    Ok(n)
}

/// Periodic sweep — password reminders every hour.
async fn reminder_pass(state: &Arc<DaemonState>) {
    let cfg = state.config.lock().unwrap();
    let interval_days = cfg.password_reminder_days;
    if interval_days == 0 {
        return;
    }
    let due: Vec<String> = cfg
        .repositories
        .iter()
        .filter(|r| {
            let last = r.last_password_verified_at.unwrap_or(0);
            crate::ipc::now_ms_pub() > last + interval_days as u64 * 86_400_000
        })
        .map(|r| r.id.clone())
        .collect();
    drop(cfg);
    for id in due {
        state.emit("password.due", json!({ "repositoryId": id }));
    }
}

/// The tick loop — call once from main.
pub async fn run(state: Arc<DaemonState>) {
    // Give the daemon a beat to settle before evaluating missed runs.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let mut tick = interval(Duration::from_secs(TICK_SECS));
    let mut reminder_at = 0u64;
    loop {
        tick.tick().await;
        let now = crate::ipc::now_ms_pub();

        // Hourly password-reminder sweep.
        if now > reminder_at {
            reminder_at = now + 3_600_000;
            reminder_pass(&state).await;
        }

        let plans: Vec<Plan> = {
            let cfg = state.config.lock().unwrap();
            cfg.plans.iter().filter(|p| p.enabled && p.schedule.is_some()).cloned().collect()
        };
        for plan in plans {
            let Some(rule) = plan.schedule.as_ref().map(|s| s.rule.clone()) else { continue };
            let Some(wait) = due_in_ms(&rule, plan.last_run_at.unwrap_or(0), now) else { continue };
            if wait > TICK_SECS * 1000 {
                continue;
            }
            if state.job_running_for(&plan.id) {
                continue;
            }
            tracing::info!("scheduler: running plan {}", plan.name);
            match run_plan(&state, &plan, false).await {
                Ok(job_id) => tracing::info!("scheduler: plan {} → job {job_id}", plan.name),
                Err(e) => {
                    tracing::warn!("scheduler: plan {} failed to start: {e}", plan.name);
                    let _ = notify::send("Redoubt backup failed to start", &format!("{}: {e}", plan.name)).await;
                }
            }
        }
    }
}

/// Called by the backup job on success — record last_run_at + run retention.
pub async fn post_run(state: &Arc<DaemonState>, plan: &Plan) {
    {
        let mut cfg = state.config.lock().unwrap();
        if let Some(p) = cfg.plans.iter_mut().find(|p| p.id == plan.id) {
            p.last_run_at = Some(crate::ipc::now_ms_pub());
        }
        let _ = cfg.save();
    }
    if let Err(e) = retention_pass(state, plan).await {
        tracing::warn!("retention pass failed for {}: {e}", plan.name);
    }
}
