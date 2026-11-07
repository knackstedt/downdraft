//! secrets.rs — OS keychain access for repository passwords.
//!
//! secret-service (gnome-keyring / keepassxc / kwallet) via the `keyring`
//! crate. Every call degrades to None/false when no session keyring exists —
//! callers then fall back to interactive passphrase prompts (the keybox
//! unwrap path works regardless; the keyring only removes the typing).

const SERVICE: &str = "redoubt";

fn entry(repo_id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, repo_id).ok()
}

/// Cached repository password — None when no keyring or no entry.
pub fn get(repo_id: &str) -> Option<String> {
    entry(repo_id)?.get_password().ok()
}

/// Remember the repository password for unattended scheduled runs.
pub fn store(repo_id: &str, password: &str) -> bool {
    match entry(repo_id) {
        Some(e) => e.set_password(password).is_ok(),
        None => false,
    }
}

/// Keyring present and writable? Probed once, cheaply.
pub fn available() -> bool {
    match entry("__probe__") {
        Some(e) => e.set_password("probe").is_ok(),
        None => false,
    }
}

/// Forget a stored password — wired to repo.delete/unlock-forget in a later
/// phase.
#[allow(dead_code)]
pub fn forget(repo_id: &str) -> bool {
    match entry(repo_id) {
        Some(e) => e.delete_credential().is_ok(),
        None => false,
    }
}
