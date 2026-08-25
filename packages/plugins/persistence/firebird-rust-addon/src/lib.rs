// firebird-rust-addon/src/lib.rs
//
// NAPI addon that wraps rsfbclient (Rust→libfbclient direct FFI) to provide
// a Firebird embedded save store. Exposes a thin API consumed by
// FirebirdRustSaveStore (TypeScript side).
//
// Schema: one row per slot, two generations (0=current, 1=backup),
// BLOB columns for body and hash. Column `save_ts` avoids the reserved
// word `timestamp`.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use rsfbclient::{builder_native, Execute, Queryable, Row, SimpleConnection};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/// Opaque handle wrapping a Firebird connection.
#[napi]
pub struct FirebirdRustHandle {
    conn: Mutex<Option<SimpleConnection>>,
    lib_path: String,
    db_path: String,
}

#[napi]
impl FirebirdRustHandle {
    /// Open (or create) an embedded Firebird database at `db_path`.
    /// `lib_path` is the path to libfbclient.so (dynamic loading, no compile-time link).
    /// If the database file doesn't exist, it is created.
    #[napi]
    pub fn open(db_path: String, lib_path: String) -> Result<FirebirdRustHandle> {
        let conn: SimpleConnection = if !std::path::Path::new(&db_path).exists() {
            builder_native()
                .with_dyn_load(&lib_path)
                .with_embedded()
                .db_name(&db_path)
                .page_size(16384) // max page size — BLOB-heavy workload
                .create_database()
                .map_err(|e| Error::new(Status::GenericFailure, format!("Firebird create: {e}")))?
                .into()
        } else {
            builder_native()
                .with_dyn_load(&lib_path)
                .with_embedded()
                .db_name(&db_path)
                .connect()
                .map_err(|e| Error::new(Status::GenericFailure, format!("Firebird connect: {e}")))?
                .into()
        };

        Ok(FirebirdRustHandle {
            conn: Mutex::new(Some(conn)),
            lib_path,
            db_path,
        })
    }

    /// Close the connection.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        if let Some(conn) = guard.take() {
            conn.close().map_err(|e| {
                Error::new(Status::GenericFailure, format!("Firebird close: {e}"))
            })?;
        }
        Ok(())
    }

    /// Create the save schema if it doesn't exist.
    /// Uses Firebird 5.0-compatible DDL (no IF NOT EXISTS).
    #[napi]
    pub fn ensure_schema(&self) -> Result<()> {
        let ddl = [
            "CREATE TABLE dd_saves (slot VARCHAR(128) NOT NULL, generation INTEGER NOT NULL, engine_version_packed BIGINT NOT NULL, save_ts DOUBLE PRECISION NOT NULL, entity_count INTEGER NOT NULL, player_count INTEGER NOT NULL, body BLOB SUB_TYPE BINARY NOT NULL, hash BLOB SUB_TYPE BINARY NOT NULL, CONSTRAINT pk_dd_saves PRIMARY KEY (slot, generation))",
            "CREATE TABLE dd_meta (meta_key VARCHAR(64) NOT NULL PRIMARY KEY, meta_value VARCHAR(256) NOT NULL)",
        ];

        for stmt in &ddl {
            // Ignore "table already exists" errors
            if let Err(e) = self.exec_inner(stmt) {
                let msg = format!("{e:?}");
                if !msg.contains("already exists") && !msg.contains("unsuccessful metadata update") {
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// Execute a raw SQL statement (for debugging / DDL).
    #[napi]
    pub fn exec_sql(&self, sql: String) -> Result<()> {
        self.exec_inner(&sql)
    }

    /// Save a slot. Writes generation 0; rotates old gen 0 → gen 1 first.
    /// Uses a single EXECUTE BLOCK to batch DELETE + UPDATE + INSERT into one
    /// statement, reducing FFI overhead (isc_dsql_describe_bind, isc_dsql_sql_info,
    /// XSQLDA allocation) from 3× to 1×. The entire block runs in one transaction
    /// (one commit/disk flush).
    #[napi]
    pub fn save_slot(
        &self,
        slot: String,
        engine_version_packed: i64,
        timestamp: f64,
        entity_count: i32,
        player_count: i32,
        body: Uint8Array,
        hash: Uint8Array,
    ) -> Result<()> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        let conn = guard.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "Connection closed".to_string())
        })?;

        // Single EXECUTE BLOCK: rotate + insert in one statement → one commit.
        // This eliminates 2 of 3 isc_dsql_describe_bind + isc_dsql_sql_info calls
        // and 2 of 3 XSQLDA heap allocations that rsfbclient does per execute().
        let sql = concat!(
            "EXECUTE BLOCK (",
            "  p_slot VARCHAR(128) = ?, ",
            "  p_evp BIGINT = ?, ",
            "  p_ts DOUBLE PRECISION = ?, ",
            "  p_ec INTEGER = ?, ",
            "  p_pc INTEGER = ?, ",
            "  p_body BLOB SUB_TYPE BINARY = ?, ",
            "  p_hash BLOB SUB_TYPE BINARY = ?",
            ") AS ",
            "BEGIN ",
            "  DELETE FROM dd_saves WHERE slot = :p_slot AND generation = 1; ",
            "  UPDATE dd_saves SET generation = 1 WHERE slot = :p_slot AND generation = 0; ",
            "  INSERT INTO dd_saves (slot, generation, engine_version_packed, save_ts, entity_count, player_count, body, hash) ",
            "    VALUES (:p_slot, 0, :p_evp, :p_ts, :p_ec, :p_pc, :p_body, :p_hash); ",
            "END"
        );

        let result = conn.execute(sql, (
            &slot,
            engine_version_packed,
            timestamp,
            entity_count,
            player_count,
            body.as_ref().to_vec(),
            hash.as_ref().to_vec(),
        ));

        match result {
            Ok(_) => {
                // rsfbclient auto-commits on execute() when not in an explicit
                // transaction, so no manual commit needed.
                Ok(())
            }
            Err(e) => {
                Err(Error::new(Status::GenericFailure, format!("Save execute block: {e}")))
            }
        }
    }

    /// Load a slot. Tries generation 0, falls back to generation 1 (backup).
    #[napi]
    pub fn load_slot(&self, slot: String) -> Result<Option<SlotData>> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        let conn = guard.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "Connection closed".to_string())
        })?;

        if let Some(data) = Self::load_generation(conn, &slot, 0)? {
            return Ok(Some(data));
        }
        Self::load_generation(conn, &slot, 1)
    }

    /// List all slots (generation 0 only).
    #[napi]
    pub fn list_slots(&self) -> Result<Vec<SlotInfo>> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        let conn = guard.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "Connection closed".to_string())
        })?;

        let rows: Vec<Row> = conn
            .query(
                "SELECT slot, engine_version_packed, save_ts, entity_count, player_count FROM dd_saves WHERE generation = 0 ORDER BY save_ts DESC",
                (),
            )
            .map_err(|e| Error::new(Status::GenericFailure, format!("List: {e}")))?;

        let mut result = Vec::new();
        for row in rows {
            let s: String = row.get(0).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Row get slot: {e}"))
            })?;
            let evp: i64 = row.get(1).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Row get evp: {e}"))
            })?;
            let ts: f64 = row.get(2).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Row get ts: {e}"))
            })?;
            let ec: i32 = row.get(3).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Row get ec: {e}"))
            })?;
            let pc: i32 = row.get(4).map_err(|e| {
                Error::new(Status::GenericFailure, format!("Row get pc: {e}"))
            })?;
            result.push(SlotInfo {
                slot: s,
                engine_version_packed: evp,
                timestamp: ts,
                entity_count: ec,
                player_count: pc,
            });
        }
        Ok(result)
    }

    /// Delete a slot (both generations).
    #[napi]
    pub fn delete_slot(&self, slot: String) -> Result<bool> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        let conn = guard.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "Connection closed".to_string())
        })?;

        let affected = conn
            .execute("DELETE FROM dd_saves WHERE slot = ?", (&slot,))
            .map_err(|e| Error::new(Status::GenericFailure, format!("Delete: {e}")))?;

        Ok(affected > 0)
    }

    /// Export the entire database file as bytes (for cloud saves).
    #[napi]
    pub fn export_database(&self) -> Result<Uint8Array> {
        let data = std::fs::read(&self.db_path).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Read db file: {e}"))
        })?;
        Ok(Uint8Array::from(data))
    }

    /// Import a database from bytes (for cloud restore).
    #[napi]
    pub fn import_database(&self, bytes: Uint8Array) -> Result<()> {
        {
            let mut guard = self.conn.lock().map_err(|e| {
                Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
            })?;
            if let Some(conn) = guard.take() {
                let _ = conn.close();
            }
        }
        std::fs::write(&self.db_path, bytes.as_ref()).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Write db file: {e}"))
        })?;
        let conn: SimpleConnection = builder_native()
            .with_dyn_load(&self.lib_path)
            .with_embedded()
            .db_name(&self.db_path)
            .connect()
            .map_err(|e| Error::new(Status::GenericFailure, format!("Reconnect: {e}")))?
            .into();
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        *guard = Some(conn);
        Ok(())
    }
}

impl FirebirdRustHandle {
    fn exec_inner(&self, sql: &str) -> Result<()> {
        let mut guard = self.conn.lock().map_err(|e| {
            Error::new(Status::GenericFailure, format!("Mutex poisoned: {e}"))
        })?;
        let conn = guard.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "Connection closed".to_string())
        })?;
        conn.execute(sql, ())
            .map_err(|e| Error::new(Status::GenericFailure, format!("Exec: {e}")))?;
        Ok(())
    }

    fn load_generation(
        conn: &mut SimpleConnection,
        slot: &str,
        generation: i32,
    ) -> Result<Option<SlotData>> {
        let rows: Vec<Row> = conn
            .query(
                "SELECT body, hash, engine_version_packed, save_ts, entity_count, player_count FROM dd_saves WHERE slot = ? AND generation = ?",
                (slot, generation),
            )
            .map_err(|e| {
                Error::new(Status::GenericFailure, format!("Query: {e}"))
            })?;

        if rows.is_empty() {
            return Ok(None);
        }

        let row = &rows[0];
        let body: Vec<u8> = row.get(0).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get body: {e}"))
        })?;
        let hash: Vec<u8> = row.get(1).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get hash: {e}"))
        })?;
        let evp: i64 = row.get(2).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get evp: {e}"))
        })?;
        let ts: f64 = row.get(3).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get ts: {e}"))
        })?;
        let ec: i32 = row.get(4).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get ec: {e}"))
        })?;
        let pc: i32 = row.get(5).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Row get pc: {e}"))
        })?;

        Ok(Some(SlotData {
            body: Uint8Array::from(body),
            hash: Uint8Array::from(hash),
            generation,
            engine_version_packed: evp,
            timestamp: ts,
            entity_count: ec,
            player_count: pc,
        }))
    }
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct SlotData {
    pub body: Uint8Array,
    pub hash: Uint8Array,
    pub generation: i32,
    pub engine_version_packed: i64,
    pub timestamp: f64,
    pub entity_count: i32,
    pub player_count: i32,
}

#[napi(object)]
pub struct SlotInfo {
    pub slot: String,
    pub engine_version_packed: i64,
    pub timestamp: f64,
    pub entity_count: i32,
    pub player_count: i32,
}
