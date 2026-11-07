//! keybox.rs — repository key wrapping.
//!
//! The kopia repository password is a generated 256-bit secret. It is never
//! stored in the clear: a `keybox.json` (per repository, in the app config
//! dir; a copy also travels inside the repo dir) wraps it in one or more
//! slots:
//!
//!   - `passphrase`: Argon2id(passphrase) → XChaCha20-Poly1305 AEAD wrap.
//!     Unlock/verify needs the passphrase — the daemon's password-revalidate
//!     feature is just a timed `unlock` probe.
//!   - `pq-hybrid` (phase 7): X25519 + ML-KEM-768 hybrid KEM recipient slots
//!     for recovery keys / cross-device unlock.
//!
//! Symmetric AEAD is already quantum-resilient at these sizes; the KEM layer
//! is what makes key transport post-quantum.

use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context};
use argon2::Argon2;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::config::config_dir;

const ARGON_M_KIB: u32 = 64 * 1024;
const ARGON_T: u32 = 3;
const ARGON_P: u32 = 4;
const KEY_LEN: usize = 32;

fn b64e() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseSlot {
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub argon_m_kib: u32,
    pub argon_t: u32,
    pub argon_p: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keybox {
    pub version: u32,
    pub passphrase_slot: PassphraseSlot,
    /// Reserved for phase-7 hybrid X25519+ML-KEM-768 recipient slots.
    #[serde(default)]
    pub kem_slots: Vec<serde_json::Value>,
}

fn derive_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> anyhow::Result<[u8; KEY_LEN]> {
    let params = argon2::Params::new(m, t, p, Some(KEY_LEN))
        .map_err(|e| anyhow::anyhow!("argon2 params: {e}"))?;
    let a2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    a2.hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("argon2: {e}"))?;
    Ok(key)
}

/// Fresh keybox + freshly generated repository password. The sealed payload
/// is the base64 text of the raw secret — the same string kopia gets as its
/// repo password — so `unlock` always yields valid UTF-8.
pub fn create(passphrase: &str) -> anyhow::Result<(Keybox, Zeroizing<String>)> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    let mut secret = [0u8; KEY_LEN];
    let rng = &mut rand::rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);
    rng.fill_bytes(&mut secret);

    let b64 = b64e();
    let encoded = Zeroizing::new(b64.encode(secret));
    secret.fill(0);

    let key = derive_key(passphrase, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
    let ct = XChaCha20Poly1305::new((&key).into())
        .encrypt(XNonce::from_slice(&nonce), encoded.as_bytes())
        .map_err(|e| anyhow::anyhow!("seal: {e}"))?;

    let box_ = Keybox {
        version: 1,
        passphrase_slot: PassphraseSlot {
            salt_b64: b64.encode(salt),
            nonce_b64: b64.encode(nonce),
            ciphertext_b64: b64.encode(ct),
            argon_m_kib: ARGON_M_KIB,
            argon_t: ARGON_T,
            argon_p: ARGON_P,
        },
        kem_slots: vec![],
    };
    Ok((box_, encoded))
}

/// Unwrap the repository password with the passphrase. Returns Err on wrong
/// passphrase or corrupt keybox.
pub fn unlock(box_: &Keybox, passphrase: &str) -> anyhow::Result<Zeroizing<String>> {
    let b64 = b64e();
    let s = &box_.passphrase_slot;
    let salt = b64.decode(&s.salt_b64)?;
    let nonce = b64.decode(&s.nonce_b64)?;
    let ct = b64.decode(&s.ciphertext_b64)?;
    if nonce.len() != 24 {
        bail!("bad nonce in keybox");
    }
    let key = derive_key(passphrase, &salt, s.argon_m_kib, s.argon_t, s.argon_p)?;
    let pt = XChaCha20Poly1305::new((&key).into())
        .decrypt(XNonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| anyhow::anyhow!("wrong passphrase or corrupt keybox"))?;
    Ok(Zeroizing::new(String::from_utf8(pt).context("keybox payload not utf8")?))
}

/// Probe used by the password-reminder flow — true when the passphrase
/// unwraps the box. Same cost as unlock (Argon2id ~200ms).
pub fn verify(box_: &Keybox, passphrase: &str) -> bool {
    unlock(box_, passphrase).is_ok()
}

// ── persistence ──

fn keybox_path(repo_id: &str) -> PathBuf {
    config_dir().join("keyboxes").join(format!("{repo_id}.json"))
}

pub fn save(repo_id: &str, box_: &Keybox) -> anyhow::Result<PathBuf> {
    let path = keybox_path(repo_id);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(box_)?)?;
    fs::rename(&tmp, &path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(path)
}

pub fn load(repo_id: &str) -> anyhow::Result<Keybox> {
    let path = keybox_path(repo_id);
    let text = fs::read_to_string(&path)
        .with_context(|| format!("no keybox for repo {repo_id} ({})", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

/// A second copy inside the repository dir so the wrapped key travels with
/// the backup (restore-on-new-machine story).
pub fn export_into_repo(repo_id: &str, repo_dir: &str) -> anyhow::Result<()> {
    let path = PathBuf::from(repo_dir).join("redoubt-keybox.json");
    fs::write(&path, fs::read(keybox_path(repo_id))?)?;
    Ok(())
}
