//! bins.rs — kopia + rclone binary resolution and pinned download.
//!
//! Resolution order per tool:
//!   1. env override (REDOUBT_KOPIA_BIN / REDOUBT_RCLONE_BIN)
//!   2. bundled alongside the daemon package (`<exe_dir>/bin/<name>` and
//!      `<exe_dir>/../bin/<name>` — draft release asset layout, phase 7)
//!   3. previously downloaded copy in `<data_dir>/bin/<name>-<version>`
//!   4. PATH
//! `ensure()` additionally downloads the pinned build into the data dir,
//! verifies the pinned sha256, extracts and chmods +x.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::config::data_dir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Kopia,
    Rclone,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Tool::Kopia => "kopia",
            Tool::Rclone => "rclone",
        }
    }

    fn env_var(self) -> &'static str {
        match self {
            Tool::Kopia => "REDOUBT_KOPIA_BIN",
            Tool::Rclone => "REDOUBT_RCLONE_BIN",
        }
    }

    fn pinned(self) -> Pinned {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => unimplemented!("unsupported arch {other}"),
        };
        match (self, arch) {
            (Tool::Kopia, "x64") => Pinned {
                version: "0.23.1",
                url: "https://github.com/kopia/kopia/releases/download/v0.23.1/kopia-0.23.1-linux-x64.tar.gz",
                sha256: "416d0f84a3dbb321a8b2d8f0997b1a0a6e915babe79ee76fa6e4d2bd1e1c5178",
                archive_member: "kopia-0.23.1-linux-x64/kopia",
            },
            (Tool::Kopia, "arm64") => Pinned {
                version: "0.23.1",
                url: "https://github.com/kopia/kopia/releases/download/v0.23.1/kopia-0.23.1-linux-arm64.tar.gz",
                sha256: "a4ffbc019e0b0f932e2632054e73ec521dc1e80172a00095369c53ecf4e5a6cb",
                archive_member: "kopia-0.23.1-linux-arm64/kopia",
            },
            (Tool::Rclone, "x64") => Pinned {
                version: "1.76.0",
                url: "https://github.com/rclone/rclone/releases/download/v1.76.0/rclone-v1.76.0-linux-amd64.zip",
                sha256: "b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7",
                archive_member: "rclone-v1.76.0-linux-amd64/rclone",
            },
            (Tool::Rclone, "arm64") => Pinned {
                version: "1.76.0",
                url: "https://github.com/rclone/rclone/releases/download/v1.76.0/rclone-v1.76.0-linux-arm64.zip",
                sha256: "ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78",
                archive_member: "rclone-v1.76.0-linux-arm64/rclone",
            },
            _ => unreachable!(),
        }
    }
}

struct Pinned {
    version: &'static str,
    url: &'static str,
    sha256: &'static str,
    archive_member: &'static str,
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn bin_dir() -> PathBuf {
    data_dir().join("bin")
}

fn downloaded_path(tool: Tool) -> PathBuf {
    bin_dir().join(format!("{}-{}", tool.name(), tool.pinned().version))
}

/// Candidate locations in resolution order (first hit wins).
pub fn candidates(tool: Tool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var(tool.env_var()) {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("bin").join(tool.name()));
            out.push(dir.join("..").join("bin").join(tool.name()));
        }
    }
    out.push(downloaded_path(tool));
    if let Some(p) = which(tool.name()) {
        out.push(p);
    }
    out
}

/// First existing candidate — None when the tool isn't available anywhere.
pub fn resolve(tool: Tool) -> Option<PathBuf> {
    candidates(tool).into_iter().find(|p| p.is_file())
}

fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 1 << 20];
    loop {
        let n = std::io::Read::read(&mut f, &mut buf)?;
        if n == 0 {
            break;
        }
        Digest::update(&mut h, &buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Download + verify + extract the pinned build into the data dir.
/// Returns the binary path. Safe to call when already downloaded (no-op).
pub async fn ensure(tool: Tool) -> anyhow::Result<PathBuf> {
    if let Some(p) = resolve(tool) {
        return Ok(p);
    }
    let pinned = tool.pinned();
    let dir = bin_dir();
    fs::create_dir_all(&dir)?;
    let archive = dir.join(format!("{}.download", tool.name()));
    let out = downloaded_path(tool);

    // curl is universal on desktop linux; spawn it rather than pulling an
    // HTTP crate tree for a two-file downloader.
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "--connect-timeout", "15", "-o"])
        .arg(&archive)
        .arg(pinned.url)
        .stdin(Stdio::null())
        .status()
        .await
        .context("spawning curl — is curl installed?")?;
    if !status.success() {
        bail!("download failed ({})", pinned.url);
    }

    let got = sha256_file(&archive)?;
    if got != pinned.sha256 {
        let _ = fs::remove_file(&archive);
        bail!("sha256 mismatch for {}: got {got}", pinned.url);
    }

    extract_member(&archive, pinned.archive_member, &out).await?;
    let _ = fs::remove_file(&archive);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&out, fs::Permissions::from_mode(0o755))?;
    }
    tracing::info!("{} {} downloaded → {}", tool.name(), pinned.version, out.display());
    Ok(out)
}

async fn extract_member(archive: &Path, member: &str, out: &Path) -> anyhow::Result<()> {
    let name = archive.to_string_lossy();
    if name.ends_with(".tar.gz") {
        // tar -xzf archive -C dir member → move to out
        let tmp = archive.parent().unwrap().join("extract");
        fs::create_dir_all(&tmp)?;
        let status = Command::new("tar")
            .args(["-xzf"])
            .arg(archive)
            .arg("-C")
            .arg(&tmp)
            .arg(member)
            .status()
            .await?;
        if !status.success() {
            bail!("tar extract failed for {}", archive.display());
        }
        fs::rename(tmp.join(member), out)?;
        let _ = fs::remove_dir_all(&tmp);
        Ok(())
    } else if name.ends_with(".zip") {
        // Pure-rust zip read — unzip isn't guaranteed installed.
        let out = out.to_path_buf();
        let archive = archive.to_path_buf();
        let member = member.to_string();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let f = fs::File::open(&archive)?;
            let mut zip = zip::ZipArchive::new(f)?;
            let mut entry = zip.by_name(&member)?;
            let mut w = fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut w)?;
            Ok(())
        })
        .await?
    } else {
        bail!("unsupported archive: {}", archive.display());
    }
}
