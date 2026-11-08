//! ipc.rs — JSON-RPC 2.0 server over a unix socket.
//!
//! Newline-delimited JSON both directions. Requests `{jsonrpc, id, method,
//! params}` get `{jsonrpc, id, result|error}`; daemon events go out as
//! notifications `{jsonrpc, method, params}` on every connected client.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{bail, Context};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;
use zeroize::Zeroizing;

use crate::bins::{self, Tool};
use crate::config::{DaemonConfig, Plan, RepoLocation, Repository};
use crate::engine::kopia::KopiaAdapter;
use crate::engine::{EngineAdapter, SnapshotInfo};
use crate::{jobs, keybox, secrets};

pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("REDOUBT_SOCK") {
        return PathBuf::from(p);
    }
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(runtime).join("downdraft-redoubt").join("daemon.sock")
}

pub struct DaemonState {
    pub config: Mutex<DaemonConfig>,
    pub start: Instant,
    pub events: broadcast::Sender<Value>,
    pub jobs: jobs::JobStore,
    pub job_counter: AtomicU64,
    /// Unlocked repository passwords (in-memory only — the persistent copy
    /// lives in the keybox; keyring caches it across daemon restarts).
    pub repo_keys: Mutex<HashMap<String, Zeroizing<String>>>,
    /// Lazily constructed after bins.ensure lands the kopia binary.
    pub engine: Mutex<Option<Arc<KopiaAdapter>>>,
    /// Live FUSE mounts: repository id → mount child.
    pub mounts: Mutex<HashMap<String, crate::engine::MountHandle>>,
}

impl DaemonState {
    pub fn new(config: DaemonConfig) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            config: Mutex::new(config),
            start: Instant::now(),
            events,
            jobs: Mutex::new(std::collections::VecDeque::new()),
            job_counter: AtomicU64::new(1),
            repo_keys: Mutex::new(HashMap::new()),
            engine: Mutex::new(None),
            mounts: Mutex::new(HashMap::new()),
        }
    }

    /// Broadcast an event notification to every connected client.
    pub fn emit(&self, method: &str, params: Value) {
        let note = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.events.send(note);
    }

    /// Engine adapter — resolves the kopia binary on first use; after a
    /// bins.ensure download this must be retried, so failure is not cached.
    pub fn engine(&self) -> anyhow::Result<Arc<KopiaAdapter>> {
        let mut slot = self.engine.lock().unwrap();
        if let Some(e) = slot.as_ref() {
            return Ok(Arc::clone(e));
        }
        let e = Arc::new(KopiaAdapter::new()?);
        *slot = Some(Arc::clone(&e));
        Ok(e)
    }

    /// Repository password, resolved in order: explicit param → in-memory
    /// cache → OS keyring. Errors with an unlock hint otherwise.
    fn repo_password(&self, repo_id: &str, passphrase: Option<&str>) -> anyhow::Result<Zeroizing<String>> {
        if let Some(p) = passphrase {
            let box_ = keybox::load(repo_id)?;
            let pw = keybox::unlock(&box_, p)?;
            self.repo_keys.lock().unwrap().insert(repo_id.into(), pw.clone());
            return Ok(pw);
        }
        if let Some(pw) = self.repo_keys.lock().unwrap().get(repo_id) {
            return Ok(pw.clone());
        }
        if let Some(pw) = secrets::get(repo_id) {
            let pw = Zeroizing::new(pw);
            self.repo_keys.lock().unwrap().insert(repo_id.into(), pw.clone());
            return Ok(pw);
        }
        bail!("repository {repo_id} is locked — call repo.unlock or pass passphrase")
    }
}

fn status(state: &DaemonState) -> Value {
    let cfg = state.config.lock().unwrap();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "socketPath": socket_path().to_string_lossy(),
        "uptimeSec": state.start.elapsed().as_secs(),
        "kopiaBin": bins::resolve(Tool::Kopia).map(|p| p.to_string_lossy().into_owned()),
        "rcloneBin": bins::resolve(Tool::Rclone).map(|p| p.to_string_lossy().into_owned()),
        "keyring": secrets::available(),
        "counts": {
            "plans": cfg.plans.len(),
            "repositories": cfg.repositories.len(),
            "targets": cfg.targets.len(),
            "syncs": cfg.syncs.len(),
        }
    })
}

impl DaemonState {
    /// Look up a repository by id — public for the scheduler.
    pub fn get_repository(&self, id: &str) -> anyhow::Result<Repository> {
        get_repository(self, id)
    }

    /// Repo password without an interactive passphrase — cache → keyring.
    pub fn repo_password_any(&self, repo_id: &str) -> anyhow::Result<Zeroizing<String>> {
        self.repo_password(repo_id, None)
    }

    /// True when a job is currently running for `plan_id`.
    pub fn job_running_for(&self, plan_id: &str) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .any(|j| j.plan_id.as_deref() == Some(plan_id) && matches!(j.state, crate::jobs::JobState::Running | crate::jobs::JobState::Queued))
    }
}

/// Shared backup-run entry: storage pre-flight → per-source snapshot job →
/// post-run (last_run_at + retention cull). Used by plan.runNow (manual,
/// `force` per param) and the scheduler (automatic).
pub async fn run_plan(state: &Arc<DaemonState>, plan: &Plan, force: bool) -> anyhow::Result<String> {
    let repo = get_repository(state, &plan.repository_id)?;
    let pw = state.repo_password_any(&repo.id)?;
    let engine = state.engine()?;

    // Storage pre-flight: estimate the delta and compare to free space.
    let sources: Vec<String> = plan.sources.iter().map(|s| s.path.clone()).collect();
    let last_bytes = engine
        .snapshot_list(&repo, &pw)
        .await
        .ok()
        .and_then(|snaps| {
            snaps
                .iter()
                .filter(|s| plan.sources.iter().any(|src| s.source == src.path))
                .map(|s| s.size_bytes)
                .max()
        });
    let estimate = crate::storage::estimate_delta(&sources, last_bytes);
    let check = crate::storage::check(&repo.location, estimate, force).await;
    if check.warn {
        state.emit("storage.warning", crate::storage::warning_event(&repo.location, &check));
    }
    if !check.ok {
        bail!("{}", check.reason);
    }

    let plan2 = plan.clone();
    let st = Arc::clone(state);
    let job_id = jobs::spawn(state, "backup", Some(plan.id.clone()), move |st2, jid| {
        let engine = Arc::clone(&engine);
        let repo = repo.clone();
        let plan = plan2.clone();
        let pw = pw.clone();
        let st3 = Arc::clone(&st);
        async move {
            let cfg_excludes = {
                let cfg = st2.config.lock().unwrap();
                cfg.exclusion_profiles.clone()
            };
            let mut created: Vec<SnapshotInfo> = Vec::new();
            let n = plan.sources.len();
            for (i, src) in plan.sources.iter().enumerate() {
                jobs::report(&st2, &jid, i as f32 / n as f32, &format!("snapshotting {}", src.path));
                let patterns: Vec<String> = cfg_excludes
                    .iter()
                    .find(|p| p.id == src.exclude_profile_id)
                    .map(|p| {
                        p.categories
                            .iter()
                            .filter(|c| c.enabled)
                            .flat_map(|c| c.patterns.clone())
                            .collect()
                    })
                    .unwrap_or_default();
                let mut patterns = patterns;
                patterns.extend(src.extra_excludes.clone());
                let tags = vec![("plan".to_string(), plan.name.clone())];
                let snap = engine
                    .snapshot_create(&repo, &src.path, &pw, &tags, &patterns)
                    .await?;
                created.push(snap);
            }
            jobs::report(&st2, &jid, 1.0, "done");
            crate::scheduler::post_run(&st3, &plan).await;
            let _ = crate::notify::send(
                "Redoubt backup complete",
                &format!("{}: {} snapshot(s)", plan.name, created.len()),
            )
            .await;
            Ok(json!({ "snapshots": created }))
        }
    });
    Ok(job_id)
}

/// now_ms exposed for scheduler/retention modules.
pub fn now_ms_pub() -> u64 {
    now_ms()
}

/// Try fusermount3 → fusermount → umount to detach a FUSE mount.
async fn fusermount(dir: &std::path::Path) -> anyhow::Result<()> {
    for bin in ["fusermount3", "fusermount"] {
        if tokio::process::Command::new(bin)
            .args(["-u", &dir.to_string_lossy()])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    let _ = tokio::process::Command::new("umount").arg(dir).status().await;
    Ok(())
}

fn get_repository(state: &DaemonState, id: &str) -> anyhow::Result<Repository> {
    let cfg = state.config.lock().unwrap();
    cfg.repositories
        .iter()
        .find(|r| r.id == id)
        .cloned()
        .with_context(|| format!("no repository {id}"))
}

fn get_plan(state: &DaemonState, id: &str) -> anyhow::Result<Plan> {
    let cfg = state.config.lock().unwrap();
    cfg.plans
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .with_context(|| format!("no plan {id}"))
}

fn p_str<'a>(params: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("missing param {key}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── method handlers ──

async fn repo_create(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let name = p_str(params, "name")?.to_string();
    let passphrase = p_str(params, "passphrase")?.to_string();
    let loc: RepoLocation = serde_json::from_value(
        params.get("location").cloned().context("missing location")?,
    )?;

    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        location: loc.clone(),
        mirrors: vec![],
        created_at: now_ms(),
        last_password_verified_at: Some(now_ms()),
    };

    let (box_, secret) = keybox::create(&passphrase)?;
    state.engine()?.create_repository(&repo, &secret).await?;
    keybox::save(&repo.id, &box_)?;
    if let RepoLocation::Filesystem { path } = &loc {
        let _ = keybox::export_into_repo(&repo.id, path);
    }
    state
        .repo_keys
        .lock()
        .unwrap()
        .insert(repo.id.clone(), secret.clone());
    secrets::store(&repo.id, &secret);

    {
        let mut cfg = state.config.lock().unwrap();
        cfg.repositories.push(repo.clone());
        cfg.save()?;
    }
    Ok(serde_json::to_value(&repo)?)
}

async fn repo_connect(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let repo = get_repository(state, id)?;
    let pw = state.repo_password(id, params.get("passphrase").and_then(Value::as_str))?;
    state.engine()?.connect(&repo, &pw).await?;
    Ok(json!({ "connected": true }))
}

async fn repo_unlock(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let passphrase = p_str(params, "passphrase")?;
    let box_ = keybox::load(id)?;
    let pw = keybox::unlock(&box_, passphrase)?;
    state
        .repo_keys
        .lock()
        .unwrap()
        .insert(id.to_string(), pw.clone());
    if params.get("remember").and_then(Value::as_bool).unwrap_or(true) {
        secrets::store(id, &pw);
    }
    Ok(json!({ "unlocked": true }))
}

async fn repo_password_verify(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let passphrase = p_str(params, "passphrase")?;
    let box_ = keybox::load(id)?;
    let ok = keybox::verify(&box_, passphrase);
    if ok {
        // A successful revalidation both refreshes the reminder clock and
        // re-caches the secret so scheduled runs keep working unattended.
        let pw = keybox::unlock(&box_, passphrase)?;
        state
            .repo_keys
            .lock()
            .unwrap()
            .insert(id.to_string(), pw.clone());
        secrets::store(id, &pw);
        let mut cfg = state.config.lock().unwrap();
        if let Some(r) = cfg.repositories.iter_mut().find(|r| r.id == id) {
            r.last_password_verified_at = Some(now_ms());
        }
        cfg.save()?;
    }
    Ok(json!({ "ok": ok }))
}

fn repo_password_status(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let cfg = state.config.lock().unwrap();
    let repo = cfg
        .repositories
        .iter()
        .find(|r| r.id == id)
        .with_context(|| format!("no repository {id}"))?;
    let interval_days = cfg.password_reminder_days;
    let last = repo.last_password_verified_at.unwrap_or(0);
    let unlocked = state.repo_keys.lock().unwrap().contains_key(id) || secrets::get(id).is_some();
    let due = interval_days > 0 && now_ms() > last + interval_days as u64 * 86_400_000;
    Ok(json!({
        "unlocked": unlocked,
        "lastVerifiedAt": last,
        "intervalDays": interval_days,
        "due": due,
        "keyringAvailable": secrets::available(),
    }))
}

async fn repo_stats(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let repo = get_repository(state, id)?;
    let pw = state.repo_password(id, params.get("passphrase").and_then(Value::as_str))?;
    let text = state.engine()?.repository_status(&repo, &pw).await?;
    Ok(json!({ "status": text }))
}

async fn repo_sync_to(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let repo = get_repository(state, id)?;
    let dest: RepoLocation = serde_json::from_value(
        params.get("location").cloned().context("missing location")?,
    )?;
    let pw = state.repo_password(id, params.get("passphrase").and_then(Value::as_str))?;
    state.engine()?.sync_to(&repo, &dest, &pw).await?;
    Ok(json!({ "synced": true }))
}

fn plan_create(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let mut plan: Plan = serde_json::from_value(params.clone())?;
    if plan.id.is_empty() {
        plan.id = uuid::Uuid::new_v4().to_string();
    }
    let mut cfg = state.config.lock().unwrap();
    if let Some(existing) = cfg.plans.iter_mut().find(|p| p.id == plan.id) {
        *existing = plan.clone();
    } else {
        cfg.plans.push(plan.clone());
    }
    cfg.save()?;
    Ok(serde_json::to_value(&plan)?)
}

fn plan_delete(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?;
    let mut cfg = state.config.lock().unwrap();
    cfg.plans.retain(|p| p.id != id);
    cfg.save()?;
    Ok(json!({ "deleted": id }))
}

async fn plan_run_now(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let id = p_str(params, "id")?.to_string();
    let plan = get_plan(state, &id)?;
    if !plan.enabled {
        bail!("plan {id} is disabled");
    }
    if let Some(p) = params.get("passphrase").and_then(Value::as_str) {
        let _ = state.repo_password(&plan.repository_id, Some(p))?;
    }
    let force = params.get("force").and_then(Value::as_bool).unwrap_or(false);
    let job_id = run_plan(state, &plan, force).await?;
    Ok(json!({ "jobId": job_id }))
}

async fn snapshot_list(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let repo_id = params
        .get("repositoryId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .get("planId")
                .and_then(Value::as_str)
                .and_then(|pid| get_plan(state, pid).ok())
                .map(|p| p.repository_id)
        })
        .context("repositoryId or planId required")?;
    let repo = get_repository(state, &repo_id)?;
    let pw = state.repo_password(&repo_id, params.get("passphrase").and_then(Value::as_str))?;
    let mut snaps = state.engine()?.snapshot_list(&repo, &pw).await?;
    if let Some(pid) = params.get("planId").and_then(Value::as_str) {
        if let Ok(plan) = get_plan(state, pid) {
            snaps.retain(|s| plan.sources.iter().any(|src| s.source == src.path));
        }
    }
    Ok(serde_json::to_value(&snaps)?)
}

async fn snapshot_restore(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let repo_id = p_str(params, "repositoryId")?.to_string();
    let snap = p_str(params, "snapshotId")?.to_string();
    let target = p_str(params, "targetDir")?.to_string();
    let repo = get_repository(state, &repo_id)?;
    let pw = state.repo_password(&repo_id, params.get("passphrase").and_then(Value::as_str))?;
    let engine = state.engine()?;
    let st = Arc::clone(state);
    let job_id = jobs::spawn(state, "restore", None, move |st2, jid| {
        let repo = repo.clone();
        let snap = snap.clone();
        let target = target.clone();
        let engine = Arc::clone(&engine);
        let pw = pw.clone();
        let _ = st;
        async move {
            jobs::report(&st2, &jid, 0.3, "restoring");
            engine.restore(&repo, &snap, &target, &pw).await?;
            Ok(json!({ "restored": snap, "to": target }))
        }
    });
    Ok(json!({ "jobId": job_id }))
}

async fn snapshot_delete(state: &Arc<DaemonState>, params: &Value) -> anyhow::Result<Value> {
    let repo_id = p_str(params, "repositoryId")?;
    let snap = p_str(params, "snapshotId")?;
    let repo = get_repository(state, repo_id)?;
    let pw = state.repo_password(repo_id, params.get("passphrase").and_then(Value::as_str))?;
    state.engine()?.snapshot_delete(&repo, snap, &pw).await?;
    let _ = crate::catalog::drop_snapshot(snap);
    Ok(json!({ "deleted": snap }))
}

async fn bins_ensure(state: &Arc<DaemonState>) -> anyhow::Result<Value> {
    let st = Arc::clone(state);
    let job_id = jobs::spawn(state, "bins.ensure", None, move |st2, jid| {
        let _ = st;
        async move {
            let mut paths = serde_json::Map::new();
            for tool in [Tool::Kopia, Tool::Rclone] {
                jobs::report(&st2, &jid, 0.2, &format!("fetching {}", tool.name()));
                let p = bins::ensure(tool).await?;
                paths.insert(tool.name().into(), json!(p.to_string_lossy()));
            }
            // Binary landed after engine resolution may have failed earlier —
            // force re-resolution on next use.
            *st2.engine.lock().unwrap() = None;
            Ok(json!({ "bins": Value::Object(paths) }))
        }
    });
    Ok(json!({ "jobId": job_id }))
}

async fn dispatch(state: &Arc<DaemonState>, method: &str, params: &Value) -> anyhow::Result<Value> {
    match method {
        "daemon.status" => Ok(status(state)),
        "daemon.version" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),

        "bins.status" => Ok(json!({
            "tools": [
                { "name": "kopia", "path": bins::resolve(Tool::Kopia), "candidates": bins::candidates(Tool::Kopia) },
                { "name": "rclone", "path": bins::resolve(Tool::Rclone), "candidates": bins::candidates(Tool::Rclone) },
            ]
        })),
        "bins.ensure" => bins_ensure(state).await,

        "repo.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.repositories)?)
        }
        "repo.create" => repo_create(state, params).await,
        "repo.connect" => repo_connect(state, params).await,
        "repo.unlock" => repo_unlock(state, params).await,
        "repo.passwordVerify" => repo_password_verify(state, params).await,
        "repo.passwordStatus" => repo_password_status(state, params),
        "repo.stats" => repo_stats(state, params).await,
        "repo.syncNow" => repo_sync_to(state, params).await,

        "plan.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.plans)?)
        }
        "plan.create" => plan_create(state, params),
        "plan.update" => plan_create(state, params),
        "plan.delete" => plan_delete(state, params),
        "plan.runNow" => plan_run_now(state, params).await,

        "snapshot.list" => snapshot_list(state, params).await,
        "snapshot.restore" => snapshot_restore(state, params).await,
        "snapshot.delete" => snapshot_delete(state, params).await,

        "target.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.targets)?)
        }
        "target.types" => Ok(crate::rclone::remote_types()),
        "target.remotes" => Ok(serde_json::to_value(crate::rclone::list_remotes().await?)?),
        "target.about" => {
            let remote = p_str(params, "remote")?;
            Ok(crate::rclone::about(remote).await?)
        }
        "target.test" => {
            let remote = p_str(params, "remote")?;
            crate::rclone::test_remote(remote).await?;
            Ok(json!({ "ok": true }))
        }
        "target.addRemote" => {
            let name = p_str(params, "name")?.to_string();
            let rtype = p_str(params, "type")?.to_string();
            let params_map: std::collections::HashMap<String, String> =
                serde_json::from_value(params.get("params").cloned().unwrap_or(json!({})))?;
            // Obscure password-ish fields before they hit the conf file.
            let mut obscured = std::collections::HashMap::new();
            for (k, v) in &params_map {
                if v.is_empty() {
                    continue;
                }
                if k.contains("pass") || k.contains("secret") || k == "key" {
                    obscured.insert(k.clone(), crate::rclone::obscure(v).await?);
                } else {
                    obscured.insert(k.clone(), v.clone());
                }
            }
            crate::rclone::config_create(&name, &rtype, &obscured).await?;
            let mut cfg = state.config.lock().unwrap();
            cfg.targets.push(crate::config::Target {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.clone(),
                kind: crate::config::TargetKind::Rclone,
                ref_: name.clone(),
            });
            cfg.save()?;
            Ok(json!({ "added": name }))
        }
        "target.addLocal" => {
            let name = p_str(params, "name")?.to_string();
            let path = p_str(params, "path")?.to_string();
            let mut cfg = state.config.lock().unwrap();
            cfg.targets.push(crate::config::Target {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                kind: crate::config::TargetKind::Local,
                ref_: path,
            });
            cfg.save()?;
            Ok(json!({ "added": true }))
        }
        "target.remove" => {
            let id = p_str(params, "id")?;
            let t = {
                let mut cfg = state.config.lock().unwrap();
                let pos = cfg.targets.iter().position(|t| t.id == id).context("no such target")?;
                cfg.targets.remove(pos)
            };
            if matches!(t.kind, crate::config::TargetKind::Rclone) {
                let _ = crate::rclone::config_delete(&t.ref_).await;
            }
            state.config.lock().unwrap().save()?;
            Ok(json!({ "removed": id }))
        }
        "target.importConf" => {
            let imported = crate::rclone::import_user_conf().await?;
            let mut cfg = state.config.lock().unwrap();
            for name in &imported {
                if !cfg.targets.iter().any(|t| t.ref_ == *name) {
                    cfg.targets.push(crate::config::Target {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: name.clone(),
                        kind: crate::config::TargetKind::Rclone,
                        ref_: name.clone(),
                    });
                }
            }
            cfg.save()?;
            Ok(json!({ "imported": imported }))
        }
        "target.authorizeStart" => {
            let rtype = p_str(params, "type")?;
            let id = crate::rclone::authorize_start(rtype).await?;
            Ok(json!({ "flowId": id }))
        }
        "target.authorizePoll" => {
            let id = params.get("flowId").and_then(Value::as_u64).context("flowId")?;
            crate::rclone::authorize_poll(id).await
        }
        "target.authorizeFinish" => {
            // After an OAuth flow completes, create the named remote with the
            // captured token.
            let name = p_str(params, "name")?.to_string();
            let rtype = p_str(params, "type")?.to_string();
            let token = p_str(params, "token")?.to_string();
            let mut params_map = std::collections::HashMap::new();
            params_map.insert("token".into(), token);
            crate::rclone::config_create(&name, &rtype, &params_map).await?;
            let mut cfg = state.config.lock().unwrap();
            cfg.targets.push(crate::config::Target {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.clone(),
                kind: crate::config::TargetKind::Rclone,
                ref_: name.clone(),
            });
            cfg.save()?;
            Ok(json!({ "added": name }))
        }
        "sync.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.syncs)?)
        }
        // ── phase 5: browse / catalog / mounts / selective restore ──
        "browse.ls" => {
            let repo_id = p_str(params, "repositoryId")?.to_string();
            let obj = p_str(params, "objectId")?;
            let repo = get_repository(state, &repo_id)?;
            let pw = state.repo_password_any(&repo.id)?;
            let entries = state.engine()?.browse(&repo, obj, &pw).await?;
            Ok(serde_json::to_value(entries)?)
        }
        "catalog.build" => {
            let repo_id = p_str(params, "repositoryId")?.to_string();
            let snap_id = p_str(params, "snapshotId")?.to_string();
            let repo = get_repository(state, &repo_id)?;
            let pw = state.repo_password_any(&repo.id)?;
            let engine = state.engine()?;
            let job_id = jobs::spawn(state, "catalog", Some(snap_id.clone()), move |st2, jid| {
                let engine = Arc::clone(&engine);
                let repo = repo.clone();
                let snap = snap_id.clone();
                let pw = pw.clone();
                async move {
                    jobs::report(&st2, &jid, 0.2, "walking snapshot…");
                    let entries = engine.catalog_dump(&repo, &snap, &pw).await?;
                    jobs::report(&st2, &jid, 0.8, "indexing…");
                    let n = crate::catalog::store(&snap, &entries)?;
                    jobs::report(&st2, &jid, 1.0, "done");
                    Ok(json!({ "entries": n }))
                }
            });
            Ok(json!({ "jobId": job_id }))
        }
        "catalog.tree" => {
            let snap_id = p_str(params, "snapshotId")?;
            let prefix = params.get("prefix").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "children": crate::catalog::children(snap_id, prefix)? }))
        }
        "catalog.built" => {
            let snap_id = p_str(params, "snapshotId")?;
            Ok(json!({ "built": crate::catalog::has(snap_id)? }))
        }
        "mount.start" => {
            let repo_id = p_str(params, "repositoryId")?.to_string();
            let repo = get_repository(state, &repo_id)?;
            let pw = state.repo_password_any(&repo.id)?;
            let dir = std::env::temp_dir()
                .join(format!("redoubt-mount-{}", &repo.id[..8.min(repo.id.len())]));
            if state.mounts.lock().unwrap().contains_key(&repo.id) {
                bail!("already mounted at {}", dir.display());
            }
            let h = state.engine()?.mount(&repo, &dir, &pw).await?;
            state.mounts.lock().unwrap().insert(repo.id.clone(), h);
            Ok(json!({ "mountPoint": dir }))
        }
        "mount.stop" => {
            let repo_id = p_str(params, "repositoryId")?;
            let h = state.mounts.lock().unwrap().remove(repo_id)
                .context("not mounted")?;
            let _ = fusermount(&h.dir).await;
            drop(h);
            Ok(json!({ "stopped": repo_id }))
        }
        "mount.list" => {
            let mounts = state.mounts.lock().unwrap();
            Ok(json!({
                "mounts": mounts.iter().map(|(id, h)| json!({
                    "repositoryId": id, "mountPoint": h.dir,
                })).collect::<Vec<_>>()
            }))
        }
        "restore.selective" => {
            let repo_id = p_str(params, "repositoryId")?.to_string();
            let repo = get_repository(state, &repo_id)?;
            let pw = state.repo_password_any(&repo.id)?;
            let target = p_str(params, "targetDir")?.to_string();
            let items: Vec<(String, String)> = params
                .get("items")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| {
                    Some((v.get("objectId")?.as_str()?.to_string(), v.get("name")?.as_str()?.to_string()))
                }).collect())
                .unwrap_or_default();
            if items.is_empty() {
                bail!("items[] required");
            }
            let engine = state.engine()?;
            let job_id = jobs::spawn(state, "restore", None, move |st2, jid| {
                let engine = Arc::clone(&engine);
                let repo = repo.clone();
                let pw = pw.clone();
                async move {
                    let n = items.len();
                    for (i, (obj, name)) in items.iter().enumerate() {
                        let dest = std::path::Path::new(&target).join(name);
                        jobs::report(&st2, &jid, i as f32 / n as f32, &format!("restoring {name}"));
                        engine.restore_object(&repo, obj, &dest, &pw).await?;
                    }
                    jobs::report(&st2, &jid, 1.0, "done");
                    Ok(json!({ "restored": items.len(), "to": target }))
                }
            });
            Ok(json!({ "jobId": job_id }))
        }
        "disk.scan" => {
            let paths: Vec<String> = params
                .get("paths")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default();
            if paths.is_empty() {
                bail!("paths[] required");
            }
            let patterns: Vec<String> = {
                let cfg = state.config.lock().unwrap();
                cfg.exclusion_profiles
                    .iter()
                    .flat_map(|p| p.categories.iter())
                    .filter(|c| c.enabled)
                    .flat_map(|c| c.patterns.clone())
                    .collect()
            };
            Ok(crate::diskscan::scan(&paths, &patterns))
        }

        "exclusions.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.exclusion_profiles)?)
        }
        "job.list" => Ok(serde_json::to_value(jobs::list(state))?),
        _ => bail!("unknown method: {method}"),
    }
}

async fn handle_conn(state: Arc<DaemonState>, stream: UnixStream) -> anyhow::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let mut events = state.events.subscribe();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let req: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        let err = json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}});
                        write_half.write_all(err.to_string().as_bytes()).await?;
                        write_half.write_all(b"\n").await?;
                        continue;
                    }
                };
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                let params = req.get("params").cloned().unwrap_or(json!({}));
                let st = Arc::clone(&state);
                let resp = match dispatch(&st, &method, &params).await {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":format!("{e:#}")}}),
                };
                write_half.write_all(resp.to_string().as_bytes()).await?;
                write_half.write_all(b"\n").await?;
            }
            ev = events.recv() => {
                match ev {
                    Ok(note) => {
                        write_half.write_all(note.to_string().as_bytes()).await?;
                        write_half.write_all(b"\n").await?;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}

pub async fn serve(state: Arc<DaemonState>) -> anyhow::Result<()> {
    let path = socket_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    tracing::info!("listening on {}", path.display());

    loop {
        let (stream, _) = listener.accept().await?;
        let st = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = handle_conn(st, stream).await {
                tracing::debug!("conn closed: {e}");
            }
        });
    }
}
