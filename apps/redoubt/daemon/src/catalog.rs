//! catalog.rs — sqlite catalog of snapshot contents.
//!
//! `catalog.build` walks `kopia ls -r -l <snapshot>` once and persists every
//! entry; `catalog.tree` aggregates the flat rows into a size-sorted tree for
//! the sunburst view without another repo round-trip.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Context;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::config::data_dir;
use crate::engine::FsEntry;

fn db_path() -> PathBuf {
    data_dir().join("catalog.db")
}

pub fn conn() -> anyhow::Result<Connection> {
    if let Some(d) = db_path().parent() {
        std::fs::create_dir_all(d)?;
    }
    let c = Connection::open(db_path())?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries(
            snap_id TEXT NOT NULL,
            path    TEXT NOT NULL,
            name    TEXT NOT NULL,
            obj_id  TEXT NOT NULL,
            size    INTEGER NOT NULL,
            is_dir  INTEGER NOT NULL,
            mtime   INTEGER NOT NULL,
            PRIMARY KEY(snap_id, path)
        );",
    )?;
    Ok(c)
}

static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// Replace the entry set for one snapshot.
pub fn store(snap_id: &str, entries: &[FsEntry]) -> anyhow::Result<usize> {
    let mut g = DB.lock().unwrap();
    if g.is_none() {
        *g = Some(conn()?);
    }
    let c = g.as_mut().unwrap();
    let tx = c.transaction()?;
    tx.execute("DELETE FROM entries WHERE snap_id = ?1", [snap_id])?;
    {
        let mut st = tx.prepare(
            "INSERT INTO entries(snap_id,path,name,obj_id,size,is_dir,mtime) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for e in entries {
            st.execute(rusqlite::params![snap_id, e.path, e.name, e.object_id, e.size as i64, e.is_dir, e.mtime as i64])?;
        }
    }
    tx.commit()?;
    Ok(entries.len())
}

/// Aggregated children of `prefix` one level deep — for sunburst arcs and
/// the directory picker. Dir sizes come straight from `ls` output (kopia
/// reports directory totals), so no aggregation pass is needed.
pub fn children(snap_id: &str, prefix: &str) -> anyhow::Result<Vec<Value>> {
    let mut g = DB.lock().unwrap();
    if g.is_none() {
        *g = Some(conn()?);
    }
    let c = g.as_ref().unwrap();
    let depth = prefix.matches('/').count() + usize::from(!prefix.is_empty());
    let like = if prefix.is_empty() { "%".to_string() } else { format!("{prefix}/%") };
    let mut st = c.prepare(
        "SELECT path,name,obj_id,size,is_dir,mtime FROM entries
         WHERE snap_id=?1 AND path LIKE ?2 AND path != '' ORDER BY size DESC",
    )?;
    let rows = st
        .query_map(rusqlite::params![snap_id, like], |r| {
            Ok((
                r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    for (path, name, obj_id, size, is_dir, mtime) in rows {
        if path.matches('/').count() != depth {
            continue;
        }
        out.push(json!({
            "path": path, "name": name, "objectId": obj_id,
            "size": size, "isDir": is_dir != 0, "mtime": mtime,
        }));
    }
    Ok(out)
}

/// Root-level summary for the sunburst — alias of children(snap_id, "").
#[allow(dead_code)]
pub fn roots(snap_id: &str) -> anyhow::Result<Vec<Value>> {
    children(snap_id, "")
}

/// True when a snapshot's catalog has been built.
pub fn has(snap_id: &str) -> anyhow::Result<bool> {
    let mut g = DB.lock().unwrap();
    if g.is_none() {
        *g = Some(conn()?);
    }
    let n: i64 = g
        .as_ref()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM entries WHERE snap_id=?1", [snap_id], |r| r.get(0))
        .unwrap_or(0);
    Ok(n > 0)
}

pub fn drop_snapshot(snap_id: &str) -> anyhow::Result<()> {
    let mut g = DB.lock().unwrap();
    if g.is_none() {
        *g = Some(conn()?);
    }
    g.as_ref()
        .unwrap()
        .execute("DELETE FROM entries WHERE snap_id=?1", [snap_id])
        .context("catalog drop")?;
    Ok(())
}
