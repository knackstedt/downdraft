//! ipc.rs — JSON-RPC 2.0 server over a unix socket.
//!
//! Newline-delimited JSON both directions. Requests `{jsonrpc, id, method,
//! params}` get `{jsonrpc, id, result|error}`; daemon events go out as
//! notifications `{jsonrpc, method, params}` on every connected client.
//!
//! Method set (phase 1): daemon.status, daemon.version + list methods over
//! the config model. Job/engine methods land in later phases.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;

use crate::config::DaemonConfig;

pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("REDOUBT_SOCK") {
        return PathBuf::from(p);
    }
    let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(runtime).join("downdraft-redoubt").join("daemon.sock")
}

fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand.to_string_lossy().into_owned());
        }
    }
    None
}

pub struct DaemonState {
    pub config: Mutex<DaemonConfig>,
    pub start: Instant,
    pub events: broadcast::Sender<Value>,
    pub jobs: Mutex<Vec<Value>>,
    /// Next job id — used once the scheduler (phase 4) starts emitting jobs.
    #[allow(dead_code)]
    pub job_counter: AtomicU64,
}

impl DaemonState {
    pub fn new(config: DaemonConfig) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            config: Mutex::new(config),
            start: Instant::now(),
            events,
            jobs: Mutex::new(Vec::new()),
            job_counter: AtomicU64::new(1),
        }
    }

    /// Broadcast an event notification to every connected client — used by
    /// job progress, storage warnings and password reminders (later phases).
    #[allow(dead_code)]
    pub fn emit(&self, method: &str, params: Value) {
        let note = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        // No subscribers is fine — drop the error.
        let _ = self.events.send(note);
    }
}

fn status(state: &DaemonState) -> Value {
    let cfg = state.config.lock().unwrap();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "socketPath": socket_path().to_string_lossy(),
        "uptimeSec": state.start.elapsed().as_secs(),
        "kopiaBin": which("kopia"),
        "rcloneBin": which("rclone"),
        "counts": {
            "plans": cfg.plans.len(),
            "repositories": cfg.repositories.len(),
            "targets": cfg.targets.len(),
            "syncs": cfg.syncs.len(),
        }
    })
}

fn dispatch(
    state: &Arc<DaemonState>,
    method: &str,
    _params: &Value,
) -> Result<Value, (i64, String)> {
    match method {
        "daemon.status" => Ok(status(state)),
        "daemon.version" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "plan.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.plans).unwrap())
        }
        "repo.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.repositories).unwrap())
        }
        "target.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.targets).unwrap())
        }
        "sync.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.syncs).unwrap())
        }
        "job.list" => {
            let jobs = state.jobs.lock().unwrap();
            Ok(Value::Array(jobs.clone()))
        }
        "exclusions.list" => {
            let cfg = state.config.lock().unwrap();
            Ok(serde_json::to_value(&cfg.exclusion_profiles).unwrap())
        }
        _ => Err((-32601, format!("unknown method: {method}"))),
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
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                let params = req.get("params").cloned().unwrap_or(json!({}));
                let st = Arc::clone(&state);
                let (m, p) = (method.to_string(), params);
                let resp = match tokio::task::spawn_blocking(move || dispatch(&st, &m, &p)).await? {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err((code, message)) => json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
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
    // Clear a stale socket — the pid that owned it is gone if we got here.
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
