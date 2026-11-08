//! notify.rs — desktop notifications from the daemon (no UI window needed).
//!
//! Prefers `notify-send` (libnotify — ubiquitous on desktops); silently
//! degrades when absent. The UI additionally relays job events as toasts
//! when it's open.

use tokio::process::Command;

pub async fn send(title: &str, body: &str) -> bool {
    let Ok(status) = Command::new("notify-send")
        .arg("--app-name=Redoubt")
        .arg(title)
        .arg(body)
        .status()
        .await
    else {
        return false;
    };
    status.success()
}
