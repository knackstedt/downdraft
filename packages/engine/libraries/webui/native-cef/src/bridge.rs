//! bridge.rs — the browser↔render process-message protocol and the
//! page-side `globalThis.downdraft` shim. Shared by the cdylib (browser side)
//! and the helper subprocess (renderer side) via `#[path]` include —
//! keeping it one file means the two sides can't drift on message names.

// Process message names — CefProcessMessage::Create(name), args in ListValue.
/// browser → renderer: eval request. args: [req_id as string, code].
pub const MSG_EVAL: &str = "dd:eval";
/// renderer → browser: eval result. args: [req_id, "1"|"0", json-or-error].
pub const MSG_EVAL_RES: &str = "dd:eval:res";
/// browser → renderer: host → page postMessage. args: [payload_json].
pub const MSG_POST: &str = "dd:post";
/// renderer → browser: page → host message. args: [payload_json].
pub const MSG_MSG: &str = "dd:msg";

/// Injected into each V8 context by the helper's on_context_created.
/// Defines `globalThis.downdraft.postMessage` (→ __ddSend, the V8-native
/// function installed alongside it) and `window.__ddDispatch(json)` (the
/// render-side entry point for host→page postMessage). Listeners subscribe
/// via `downdraft.onMessage(cb)` or a `downdraft:message` DOM event.
pub const SHIM_JS: &str = r#"
(function(){
  if (window.__ddDispatch) return;
  var listeners = [];
  globalThis.downdraft = globalThis.downdraft || {};
  globalThis.downdraft.postMessage = function(payload){
    if (window.__ddSend) window.__ddSend(JSON.stringify(payload === undefined ? null : payload));
  };
  globalThis.downdraft.onMessage = function(cb){
    if (typeof cb === 'function') listeners.push(cb);
    return function(){ var i = listeners.indexOf(cb); if (i>=0) listeners.splice(i,1); };
  };
  window.__ddDispatch = function(json){
    var p = null;
    try { p = JSON.parse(json); } catch(e){}
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](p); } catch(e){} }
    try { window.dispatchEvent(new CustomEvent('downdraft:message', { detail: p })); } catch(e){}
  };
})();
"#;
