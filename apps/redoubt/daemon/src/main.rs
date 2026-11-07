//! redoubtd — Redoubt backup daemon.
//!
//! Owns everything the UI window doesn't: scheduling, retention, repository
//! key management (keybox + keyring), rclone remote config, FUSE mounts,
//! storage checks, sync jobs. The Downdraft app connects over the unix-socket
//! JSON-RPC link (ipc.rs); this binary also runs fine standalone.

mod config;
mod ipc;

use std::sync::Arc;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "redoubtd", version, about = "Redoubt backup daemon")]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the daemon (default when no subcommand is given).
    Run,
    /// Install the systemd user unit (phase 7 — not implemented yet).
    InstallService,
    /// Print version and exit.
    Version,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Cmd::Run) {
        Cmd::Version => {
            println!("redoubtd {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Cmd::InstallService => {
            eprintln!("install-service is not implemented yet (phase 7)");
            std::process::exit(2);
        }
        Cmd::Run => run().await,
    }
}

async fn run() -> anyhow::Result<()> {
    let cfg = config::DaemonConfig::load();
    let state = Arc::new(ipc::DaemonState::new(cfg));
    tracing::info!("redoubtd {} starting", env!("CARGO_PKG_VERSION"));
    ipc::serve(state).await
}
