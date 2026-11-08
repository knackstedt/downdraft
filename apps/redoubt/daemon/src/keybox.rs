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

/// A hybrid X25519 + ML-KEM-768 recipient slot: the repo password is
/// re-wrapped under HKDF(ss_x25519 ‖ ss_mlkem). Decapsulation needs the
/// recipient's private keys — the "recovery key" string — so losing the
/// passphrase isn't a total loss, and the wrap stays sound if either KEM
/// falls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KemSlot {
    pub label: String,
    /// Recipient public keys (slot identity — a recovery key matches the
    /// slot whose pubkeys it generated).
    pub pk_x25519_b64: String,
    pub pk_mlkem_b64: String,
    /// Ephemeral X25519 pubkey (ECDH half of the hybrid wrap).
    pub eph_x25519_b64: String,
    /// ML-KEM-768 ciphertext.
    pub ct_mlkem_b64: String,
    /// AEAD nonce + wrapped repo password under the combined secret.
    pub nonce_b64: String,
    pub wrapped_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keybox {
    pub version: u32,
    pub passphrase_slot: PassphraseSlot,
    #[serde(default)]
    pub kem_slots: Vec<KemSlot>,
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

// ── hybrid X25519 + ML-KEM-768 recipient slots ──

use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519Pub, StaticSecret};

const RECOVERY_MAGIC: &str = "redoubt-recovery-v1";
const HKDF_INFO: &[u8] = b"redoubt-kem-recipient-v1";

fn hkdf_wrap_key(ss_x25519: &[u8], ss_mlkem: &[u8]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(None, &[ss_x25519, ss_mlkem].concat());
    let mut out = [0u8; KEY_LEN];
    hk.expand(HKDF_INFO, &mut out).expect("hkdf 32");
    out
}

/// Serialized recovery key handed to the user once: the recipient's
/// private halves. Format: `redoubt-recovery-v1.<b64(x_sk‖mlkem_dk‖x_pk‖mlkem_ek)>`
/// — pubkeys travel along so `recover` can find the matching slot.
#[derive(Serialize, Deserialize)]
struct RecoveryKey {
    x_sk_b64: String,
    mlkem_dk_b64: String,
    x_pk_b64: String,
    mlkem_ek_b64: String,
}

/// Generate a recipient slot wrapping `repo_password` + the recovery key
/// string (show once, then drop — we keep only the public slot).
pub fn add_recipient(
    box_: &mut Keybox,
    label: &str,
    repo_password: &str,
) -> anyhow::Result<String> {
    let mut rng = rand::rng();
    let b64 = b64e();

    // X25519 half — recipient static keypair + ephemeral ECDH.
    let x_sk = StaticSecret::random();
    let x_pk = X25519Pub::from(&x_sk);
    let eph_sk = StaticSecret::random();
    let eph_pk = X25519Pub::from(&eph_sk);
    let ss_x = eph_sk.diffie_hellman(&x_pk);

    // ML-KEM-768 half — deterministic keypair from a generated 64B seed;
    // the seed IS the recovery secret (compact — a phrase-able 64 bytes).
    use ml_kem::kem::KeyExport;
    let mut seed = ml_kem::Seed::default();
    rand::RngCore::fill_bytes(&mut rng, seed.as_mut_slice());
    let mlkem_dk = ml_kem::DecapsulationKey768::from_seed(seed);
    let mlkem_ek = mlkem_dk.encapsulation_key().clone();
    let mut enc_seed = ml_kem::B32::default();
    rand::RngCore::fill_bytes(&mut rng, enc_seed.as_mut_slice());
    let (mlkem_ct, ss_k) = mlkem_ek.encapsulate_deterministic(&enc_seed);

    let mut key = hkdf_wrap_key(ss_x.as_bytes(), ss_k.as_slice());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut nonce);
    let wrapped = XChaCha20Poly1305::new((&key).into())
        .encrypt(XNonce::from_slice(&nonce), repo_password.as_bytes())
        .map_err(|e| anyhow::anyhow!("wrap: {e}"))?;
    key.fill(0);

    box_.kem_slots.push(KemSlot {
        label: label.into(),
        pk_x25519_b64: b64.encode(x_pk.as_bytes()),
        pk_mlkem_b64: b64.encode(mlkem_ek.to_bytes().as_slice()),
        eph_x25519_b64: b64.encode(eph_pk.as_bytes()),
        ct_mlkem_b64: b64.encode(mlkem_ct.as_slice()),
        nonce_b64: b64.encode(nonce),
        wrapped_b64: b64.encode(wrapped),
    });

    let rec = RecoveryKey {
        x_sk_b64: b64.encode(x_sk.to_bytes()),
        mlkem_dk_b64: b64.encode(seed.as_slice()),
        x_pk_b64: b64.encode(x_pk.as_bytes()),
        mlkem_ek_b64: b64.encode(mlkem_ek.to_bytes().as_slice()),
    };
    let blob = b64.encode(serde_json::to_vec(&rec)?);
    Ok(format!("{RECOVERY_MAGIC}.{blob}"))
}

/// Unwrap the repo password using a recovery key — decapsulates whichever
/// slot's pubkeys match the key material.
pub fn unlock_with_recovery(box_: &Keybox, recovery: &str) -> anyhow::Result<Zeroizing<String>> {
    let b64 = b64e();
    let blob = recovery
        .strip_prefix(&format!("{RECOVERY_MAGIC}."))
        .context("not a redoubt recovery key")?;
    let rec: RecoveryKey = serde_json::from_slice(&b64.decode(blob)?)?;

    let _x_pk_bytes: [u8; 32] = b64
        .decode(&rec.x_pk_b64)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad x25519 pubkey"))?;
    let mlkem_ek_bytes = b64.decode(&rec.mlkem_ek_b64)?;

    let slot = box_
        .kem_slots
        .iter()
        .find(|s| s.pk_x25519_b64 == rec.x_pk_b64 && b64.decode(&s.pk_mlkem_b64).map(|v| v == mlkem_ek_bytes).unwrap_or(false))
        .context("recovery key matches no slot in this keybox")?;

    // Decapsulate X25519: static_sk × ephemeral_pk.
    let x_sk_bytes: [u8; 32] = b64.decode(&rec.x_sk_b64)?.try_into().map_err(|_| anyhow::anyhow!("bad x25519 sk"))?;
    let eph_pk_bytes: [u8; 32] = b64.decode(&slot.eph_x25519_b64)?.try_into().map_err(|_| anyhow::anyhow!("bad eph pk"))?;
    let x_sk = StaticSecret::from(x_sk_bytes);
    let ss_x = x_sk.diffie_hellman(&X25519Pub::from(eph_pk_bytes));

    // Decapsulate ML-KEM-768 — rebuild the DK from its seed.
    use ml_kem::kem::Decapsulate;
    let seed_bytes = b64.decode(&rec.mlkem_dk_b64)?;
    let seed: ml_kem::Seed = seed_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad mlkem seed"))?;
    let dk = ml_kem::DecapsulationKey768::from_seed(seed);
    let ct_bytes = b64.decode(&slot.ct_mlkem_b64)?;
    let ct = ml_kem::ml_kem_768::Ciphertext::try_from(ct_bytes.as_slice())
        .map_err(|_| anyhow::anyhow!("bad mlkem ct"))?;
    let ss_k = dk.decapsulate(&ct);

    let key = hkdf_wrap_key(ss_x.as_bytes(), ss_k.as_slice());
    let nonce = b64.decode(&slot.nonce_b64)?;
    let ct = b64.decode(&slot.wrapped_b64)?;
    if nonce.len() != 24 {
        bail!("bad nonce in kem slot");
    }
    let pt = XChaCha20Poly1305::new((&key).into())
        .decrypt(XNonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| anyhow::anyhow!("recovery unwrap failed"))?;
    Ok(Zeroizing::new(String::from_utf8(pt).context("slot payload not utf8")?))
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
