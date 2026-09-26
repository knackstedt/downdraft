//! Host-provided resources — a process-wide `ui://` blob registry served to
//! every document through Blitz's NetProvider hook. Covers @font-face sources,
//! <img src>, and linked stylesheets without embedding anything in the crate.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request, Url};

static RESOURCES: OnceLock<Mutex<HashMap<String, Arc<[u8]>>>> = OnceLock::new();

fn resources() -> &'static Mutex<HashMap<String, Arc<[u8]>>> {
    RESOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Normalize `ui://` keys through the URL parser so registration and request
/// lookup agree (url::Url lowercases the host, appends '/', etc).
fn normalize_key(url: &str) -> String {
    Url::parse(url)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| url.to_string())
}

pub fn register_resource(url: &str, bytes: &[u8]) {
    let key = normalize_key(url);
    resources()
        .lock()
        .unwrap()
        .insert(key, Arc::from(bytes.to_vec().into_boxed_slice()));
}

pub struct UiNetProvider;

impl NetProvider for UiNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let key = request.url.to_string();
        let found = resources().lock().unwrap().get(&key).cloned();
        match found {
            Some(b) => handler.bytes(key, Bytes::copy_from_slice(&b)),
            // Complete with empty bytes — leaving the fetch unanswered marks the
            // resource as a pending critical resource and blocks paint forever.
            None => handler.bytes(key, Bytes::new()),
        }
    }
}
