//! jobs.rs — tracked background jobs.
//!
//! Every long-running op (snapshot create, restore, sync, maintenance) runs
//! as a Job: in-memory record + `job.progress`/`job.done` events on the IPC
//! broadcast. Phase 4's scheduler queues through the same path.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;

use crate::ipc::DaemonState;

const KEEP_FINISHED: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    pub state: JobState,
    pub progress: f32,
    pub message: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    /// Reserved for the scheduler's queueing path (phase 4).
    #[allow(dead_code)]
    Queued,
    Running,
    Done,
    Failed,
    /// Reserved for job.cancel (phase 4).
    #[allow(dead_code)]
    Cancelled,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn list(state: &DaemonState) -> Vec<JobInfo> {
    state.jobs.lock().unwrap().iter().cloned().collect()
}

fn update(state: &DaemonState, id: &str, f: impl FnOnce(&mut JobInfo)) {
    let mut jobs = state.jobs.lock().unwrap();
    // jobs is a bounded ring of recent jobs
    if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
        f(j);
        let snap = j.clone();
        drop(jobs);
        state.emit("job.progress", serde_json::to_value(&snap).unwrap_or(json!({})));
    }
}

/// Spawn a tracked job. `work` resolves to a result payload or an error
/// string; either way the job record + a `job.done` event land.
pub fn spawn<F, Fut>(state: &Arc<DaemonState>, kind: &str, plan_id: Option<String>, work: F) -> String
where
    F: FnOnce(Arc<DaemonState>, String) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<serde_json::Value>> + Send + 'static,
{
    let n = state.job_counter.fetch_add(1, Ordering::Relaxed);
    let id = format!("j{n}");
    let info = JobInfo {
        id: id.clone(),
        kind: kind.into(),
        plan_id,
        state: JobState::Running,
        progress: 0.0,
        message: String::new(),
        started_at: now_ms(),
        ended_at: None,
        error: None,
        result: None,
    };
    {
        let mut jobs = state.jobs.lock().unwrap();
        jobs.push_back(info.clone());
        while jobs.len() > KEEP_FINISHED {
            // Never drop a running job — only finished ones from the front.
            if matches!(jobs.front().map(|j| j.state), Some(JobState::Running | JobState::Queued)) {
                break;
            }
            jobs.pop_front();
        }
    }
    state.emit("job.progress", serde_json::to_value(&info).unwrap_or(json!({})));

    let st = Arc::clone(state);
    let jid = id.clone();
    tokio::spawn(async move {
        let outcome = work(Arc::clone(&st), jid.clone()).await;
        let st2 = Arc::clone(&st);
        update(&st2, &jid, |j| {
            j.ended_at = Some(now_ms());
            match outcome {
                Ok(result) => {
                    j.state = JobState::Done;
                    j.progress = 1.0;
                    j.result = Some(result);
                }
                Err(e) => {
                    j.state = JobState::Failed;
                    j.error = Some(format!("{e:#}"));
                }
            }
        });
        let done = st2.jobs.lock().unwrap().iter().find(|j| j.id == jid).cloned();
        if let Some(j) = done {
            st2.emit("job.done", serde_json::to_value(&j).unwrap_or(json!({})));
        }
    });
    id
}

/// Report mid-job progress from inside a job closure.
pub fn report(state: &DaemonState, id: &str, progress: f32, message: &str) {
    update(state, id, |j| {
        j.progress = progress.clamp(0.0, 1.0);
        j.message = message.into();
    });
}

/// JobInfo list is stored as a ring — VecDeque for cheap front pops.
pub type JobStore = Mutex<VecDeque<JobInfo>>;
