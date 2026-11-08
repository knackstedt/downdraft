//! rclone.rs — rclone remote management.
//!
//! The daemon owns a dedicated `rclone.conf` (config dir, 0600) — user
//! remotes never mix with the system file, and `--config <path>` is passed
//! everywhere (including to kopia's rclone provider via --rclone-args).
//!
//! Remotes are created non-interactively (`rclone config create`) except
//! OAuth backends, which go through `rclone authorize <type>`: it opens the
//! user's browser itself and prints the token JSON on stdout — we capture
//! it via authorizePoll and feed it into `config create`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{bail, Context};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use crate::bins::{self, Tool};
use crate::config::config_dir;

/// Curated remote types for the add-remote wizard. `params` lists the
/// fields the UI should render; `secret` marks password-style inputs.
pub fn remote_types() -> Value {
    json!([
        { "type": "protondrive", "label": "Proton Drive", "params": [
            { "key": "username", "label": "Email", "secret": false },
            { "key": "password", "label": "Password", "secret": true },
            { "key": "mailbox_password", "label": "Mailbox password (if set)", "secret": true, "optional": true },
            { "key": "2fa", "label": "2FA code (if enabled)", "secret": false, "optional": true },
        ], "oauth": false },
        { "type": "drive", "label": "Google Drive", "params": [], "oauth": true },
        { "type": "dropbox", "label": "Dropbox", "params": [], "oauth": true },
        { "type": "box", "label": "Box", "params": [], "oauth": true },
        { "type": "onedrive", "label": "OneDrive", "params": [], "oauth": true },
        { "type": "s3", "label": "S3 / compatible", "params": [
            { "key": "provider", "label": "Provider (AWS, Minio, Wasabi, …)", "secret": false },
            { "key": "access_key_id", "label": "Access key", "secret": false },
            { "key": "secret_access_key", "label": "Secret key", "secret": true },
            { "key": "region", "label": "Region", "secret": false, "optional": true },
            { "key": "endpoint", "label": "Endpoint (S3-compatible)", "secret": false, "optional": true },
        ], "oauth": false },
        { "type": "b2", "label": "Backblaze B2", "params": [
            { "key": "account", "label": "Application key ID", "secret": false },
            { "key": "key", "label": "Application key", "secret": true },
        ], "oauth": false },
        { "type": "sftp", "label": "SFTP / SSH", "params": [
            { "key": "host", "label": "Host", "secret": false },
            { "key": "user", "label": "User", "secret": false },
            { "key": "pass", "label": "Password", "secret": true, "optional": true },
            { "key": "key_file", "label": "Key file", "secret": false, "optional": true },
            { "key": "port", "label": "Port", "secret": false, "optional": true },
        ], "oauth": false },
        { "type": "webdav", "label": "WebDAV / Nextcloud", "params": [
            { "key": "url", "label": "URL", "secret": false },
            { "key": "user", "label": "User", "secret": false },
            { "key": "pass", "label": "Password", "secret": true },
        ], "oauth": false },
    ])
}

pub fn config_path() -> PathBuf {
    config_dir().join("rclone.conf")
}

fn bin() -> anyhow::Result<PathBuf> {
    bins::resolve(Tool::Rclone)
        .ok_or_else(|| anyhow::anyhow!("rclone binary not found — set REDOUBT_RCLONE_BIN or run bins.ensure"))
}

fn base_cmd() -> anyhow::Result<Command> {
    let mut c = Command::new(bin()?);
    c.arg(format!("--config={}", config_path().display()));
    Ok(c)
}

/// Password fields get `rclone obscure`d before being written — rclone
/// stores reversibly-obscured secrets; writing the obscured form keeps the
/// plain text out of config files and argv where possible.
pub async fn obscure(plain: &str) -> anyhow::Result<String> {
    let out = Command::new(bin()?)
        .arg("obscure")
        .arg(plain)
        .output()
        .await?;
    if !out.status.success() {
        bail!("rclone obscure failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `rclone config create <name> <type> k=v …` into our managed conf.
pub async fn config_create(name: &str, rtype: &str, params: &HashMap<String, String>) -> anyhow::Result<()> {
    let mut cmd = base_cmd()?;
    cmd.args(["config", "create", name, rtype]);
    for (k, v) in params {
        if !v.is_empty() {
            cmd.arg(format!("{k}={v}"));
        }
    }
    // Ensure the conf dir exists before rclone writes it.
    if let Some(d) = config_path().parent() {
        std::fs::create_dir_all(d)?;
    }
    let out = cmd.output().await?;
    if !out.status.success() {
        bail!("rclone config create: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(config_path(), std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// `rclone listremotes` — names only (one per line, trailing ':').
pub async fn list_remotes() -> anyhow::Result<Vec<String>> {
    let out = base_cmd()?.arg("listremotes").output().await?;
    if !out.status.success() {
        bail!("rclone listremotes: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().trim_end_matches(':').to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// `rclone config delete <name>`.
pub async fn config_delete(name: &str) -> anyhow::Result<()> {
    let out = base_cmd()?.args(["config", "delete", name]).output().await?;
    if !out.status.success() {
        bail!("rclone config delete: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// `rclone about <remote> --json` — `{total,used,free,usedTrash,other}` —
/// fields are null on remotes that can't report (many cloud types).
pub async fn about(remote: &str) -> anyhow::Result<Value> {
    let remote = remote.trim_end_matches(':');
    let out = base_cmd()?
        .args(["about", &format!("{remote}:"), "--json"])
        .output()
        .await?;
    if !out.status.success() {
        bail!("rclone about {remote}: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(serde_json::from_slice(&out.stdout).unwrap_or(json!({})))
}

/// Liveness probe — `rclone lsd remote: --max-depth 1`.
pub async fn test_remote(remote: &str) -> anyhow::Result<()> {
    let remote = remote.trim_end_matches(':');
    let out = base_cmd()?
        .args(["lsd", &format!("{remote}:"), "--max-depth", "1"])
        .output()
        .await?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Read the type of an existing remote stanza (for repo-create flows).
/// Read the type of an existing remote stanza (for repo-create flows).
#[allow(dead_code)]
pub async fn remote_type(name: &str) -> anyhow::Result<Option<String>> {
    let text = std::fs::read_to_string(config_path()).unwrap_or_default();
    let mut in_stanza = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_stanza = &t[1..t.len() - 1] == name;
            continue;
        }
        if in_stanza && t.starts_with("type") {
            return Ok(t.split('=').nth(1).map(|v| v.trim().to_string()));
        }
    }
    Ok(None)
}

/// Merge stanzas from the user's own rclone.conf into ours (dedup by name).
pub async fn import_user_conf() -> anyhow::Result<Vec<String>> {
    let user_conf = dirs::config_dir()
        .map(|d| d.join("rclone").join("rclone.conf"))
        .filter(|p| p.exists());
    let Some(user_conf) = user_conf else {
        return Ok(vec![]);
    };
    let theirs = std::fs::read_to_string(&user_conf)?;
    let ours_path = config_path();
    let mut ours = std::fs::read_to_string(&ours_path).unwrap_or_default();
    let mut imported = Vec::new();
    let mut stanza: Option<String> = None;
    let mut body: Vec<String> = Vec::new();
    let flush = |stanza: Option<String>, body: &mut Vec<String>, ours: &mut String, imported: &mut Vec<String>| {
        if let Some(name) = stanza {
            if !ours.contains(&format!("[{name}]")) {
                ours.push_str(&format!("\n[{name}]\n"));
                for l in body.iter() {
                    ours.push_str(l);
                    ours.push('\n');
                }
                imported.push(name);
            }
        }
        body.clear();
    };
    for line in theirs.lines() {
        let t = line.trim_end();
        if t.starts_with('[') && t.ends_with(']') {
            flush(stanza.take(), &mut body, &mut ours, &mut imported);
            stanza = Some(t[1..t.len() - 1].to_string());
        } else {
            body.push(line.to_string());
        }
    }
    flush(stanza, &mut body, &mut ours, &mut imported);
    if let Some(d) = ours_path.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(&ours_path, ours)?;
    Ok(imported)
}

// ── OAuth authorize flow ──

/// Live `rclone authorize` child — stdout accumulates until the token JSON
/// appears, then the child exits.
pub struct AuthorizeFlow {
    pub child: Child,
    pub buf: String,
    pub started_at: std::time::Instant,
}

pub static FLOWS: Mutex<Option<HashMap<u64, AuthorizeFlow>>> = Mutex::new(None);
static FLOW_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Spawn `rclone authorize <type>` — it opens the user's browser and waits
/// for the OAuth redirect, printing `paste this token → {json}` on stdout.
pub async fn authorize_start(rtype: &str) -> anyhow::Result<u64> {
    let mut cmd = base_cmd()?;
    cmd.args(["authorize", rtype]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn().context("spawning rclone authorize")?;
    let id = FLOW_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    FLOWS.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(id, AuthorizeFlow { child, buf: String::new(), started_at: std::time::Instant::now() });
    Ok(id)
}

/// Poll a flow: waiting / done(token) / expired. Reaps finished children.
pub async fn authorize_poll(id: u64) -> anyhow::Result<Value> {
    // Take the stdout pipe out of the flow so no MutexGuard is held across
    // the read await.
    let mut out = {
        let mut flows = FLOWS.lock().unwrap();
        flows
            .get_or_insert_with(HashMap::new)
            .get_mut(&id)
            .context("no such authorize flow")?
            .child
            .stdout
            .take()
    };
    if let Some(ref mut o) = out {
        let mut b = vec![0u8; 8192];
        if let Ok(n) = tokio::time::timeout(std::time::Duration::from_millis(50), o.read(&mut b)).await {
            let n = n?;
            let mut flows = FLOWS.lock().unwrap();
            if let Some(f) = flows.get_or_insert_with(HashMap::new).get_mut(&id) {
                f.buf.push_str(&String::from_utf8_lossy(&b[..n]));
            }
        }
    }
    let mut flows = FLOWS.lock().unwrap();
    let map = flows.get_or_insert_with(HashMap::new);
    let Some(flow) = map.get_mut(&id) else {
        bail!("no such authorize flow");
    };
    flow.child.stdout = out;
    // Token appears as: paste this token → {"access_token":...} ←
    if let Some(start) = flow.buf.find("paste this") {
        let tail = &flow.buf[start..];
        if let (Some(a), Some(b)) = (tail.find('{'), tail.rfind('}')) {
            if b > a {
                let token: Value = serde_json::from_str(&tail[a..=b]).context("bad token json")?;
                map.remove(&id);
                return Ok(json!({ "state": "done", "token": token.to_string() }));
            }
        }
    }
    match flow.child.try_wait() {
        Ok(Some(status)) => {
            map.remove(&id);
            bail!("authorize exited early ({status})");
        }
        Ok(None) => {}
        Err(e) => {
            map.remove(&id);
            bail!("authorize poll: {e}");
        }
    }
    if flow.started_at.elapsed() > std::time::Duration::from_secs(300) {
        map.remove(&id);
        bail!("authorize timed out");
    }
    Ok(json!({ "state": "waiting" }))
}

/// `rclone sync / bisync` runners land in phase 6 — the rclone module is
/// ready for them via base_cmd().
#[allow(dead_code)]
pub fn sync_cmd() -> anyhow::Result<Command> {
    base_cmd()
}
