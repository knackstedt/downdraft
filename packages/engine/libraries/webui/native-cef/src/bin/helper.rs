//! downdraft_cef_helper — CEF subprocess binary (renderer / GPU / utility
//! process re-exec target, settings.browser_subprocess_path).
//!
//! execute_process() sees the `--type=renderer` (etc.) switch CEF appends
//! and runs the subprocess loop; this binary never returns to its caller
//! except with the subprocess exit code. On the renderer side it carries
//! the V8 bridge:
//!
//!   on_context_created → install `window.__ddSend` (a CefV8Handler) and
//!     eval the globalThis.downdraft shim (bridge::SHIM_JS).
//!   on_process_message_received:
//!     "dd:eval" [req, code] → V8Context::eval → JSON.stringify the result
//!       → "dd:eval:res" [req, ok, json] back to the browser process.
//!     "dd:post" [json]    → window.__ddDispatch(json).
//!   __ddSend(json)        → "dd:msg" [json] to the browser process.

#![allow(non_snake_case)]

#[path = "../bridge.rs"]
mod bridge;

use cef::args::Args;
use cef::rc::Rc as _;
use cef::{
    api_hash, execute_process, process_message_create, sys, v8_context_get_current_context,
    v8_value_create_function, v8_value_create_string, wrap_app, wrap_render_process_handler,
    wrap_v8_handler, App, Browser, CefString, CefStringUserfree, CommandLine, Frame,
    ImplApp, ImplCommandLine, ImplFrame, ImplListValue, ImplProcessMessage,
    ImplRenderProcessHandler, ImplV8Context, ImplV8Exception, ImplV8Handler,
    ImplV8Value, ProcessId,
    ProcessMessage, RenderProcessHandler, V8Context, V8Handler, V8Value,
    V8Propertyattribute, WrapApp, WrapRenderProcessHandler, WrapV8Handler,
};
use std::ptr;

fn cef_str(s: &str) -> CefString {
    CefString::from(s)
}

fn uf(s: CefStringUserfree) -> String {
    CefString::from(&s).to_string()
}

// ---------------------------------------------------------------------------
// __ddSend — the V8 function page code calls (shim: downdraft.postMessage).
// Sends "dd:msg" [json] to the browser process.
// ---------------------------------------------------------------------------

wrap_v8_handler! {
    struct DdSend {}

    impl V8Handler {
        fn execute(
            &self,
            _name: Option<&CefString>,
            _object: Option<&mut V8Value>,
            arguments: Option<&[Option<V8Value>]>,
            _retval: Option<&mut Option<V8Value>>,
            _exception: Option<&mut CefString>,
        ) -> ::std::os::raw::c_int {
            let payload = arguments
                .and_then(|a| a.first().and_then(|v| v.as_ref()))
                .map(|v| uf(v.string_value()))
                .unwrap_or_else(|| "null".to_string());
            // Route through the frame that owns the current context.
            let frame = v8_context_get_current_context().and_then(|c| c.frame());
            let Some(frame) = frame else { return 1 };
            let mut msg = match process_message_create(Some(&cef_str(bridge::MSG_MSG))) {
                Some(m) => m,
                None => return 1,
            };
            if let Some(args) = msg.argument_list() {
                args.set_size(1);
                args.set_string(0, Some(&cef_str(&payload)));
            }
            frame.send_process_message(ProcessId::BROWSER, Some(&mut msg));
            1
        }
    }
}

// ---------------------------------------------------------------------------
// Eval: run `code`, JSON.stringify the result in-page, and ship the string.
// ---------------------------------------------------------------------------

fn run_eval(frame: &mut Frame, req: &str, code: &str) {
    let ctx = v8_context_get_current_context().or_else(|| frame.v8_context());
    let (ok, payload) = match ctx {
        Some(ctx) => {
            ctx.enter();
            let mut retval: Option<V8Value> = None;
            let mut exception: Option<cef::V8Exception> = None;
            let ok = ctx.eval(
                Some(&cef_str(code)),
                Some(&cef_str("dd:eval")),
                0,
                Some(&mut retval),
                Some(&mut exception),
            ) != 0;
            let out = if ok {
                // JSON.stringify(retval) via the page's own JSON object —
                // full fidelity for objects, arrays, numbers, strings.
                let json = ctx
                    .global()
                    .and_then(|g| g.value_bykey(Some(&cef_str("JSON"))))
                    .and_then(|j| j.value_bykey(Some(&cef_str("stringify"))));
                match (json, retval) {
                    (Some(stringify), Some(v)) => stringify
                        .execute_function_with_context(
                            Some(&mut ctx.clone()),
                            ctx.global().as_mut(),
                            Some(&[Some(v)]),
                        )
                        .filter(|r| r.is_string() != 0)
                        .map(|r| uf(r.string_value()))
                        .unwrap_or_else(|| "null".to_string()),
                    _ => "null".to_string(),
                }
            } else {
                let e = exception.map(|e| uf(e.message())).unwrap_or_default();
                return send_res(frame, req, false, &e);
            };
            ctx.exit();
            (true, out)
        }
        None => (false, "no v8 context".to_string()),
    };
    send_res(frame, req, ok, &payload);
}

fn send_res(frame: &mut Frame, req: &str, ok: bool, payload: &str) {
    let mut msg = match process_message_create(Some(&cef_str(bridge::MSG_EVAL_RES))) {
        Some(m) => m,
        None => return,
    };
    if let Some(args) = msg.argument_list() {
        args.set_size(3);
        args.set_string(0, Some(&cef_str(req)));
        args.set_string(1, Some(&cef_str(if ok { "1" } else { "0" })));
        args.set_string(2, Some(&cef_str(payload)));
    }
    frame.send_process_message(ProcessId::BROWSER, Some(&mut msg));
}

// ---------------------------------------------------------------------------
// RenderProcessHandler — context setup + browser→render message dispatch
// ---------------------------------------------------------------------------

wrap_render_process_handler! {
    struct DdRenderProcess {}

    impl RenderProcessHandler {
        // Per-context: install __ddSend + the globalThis.downdraft shim.
        fn on_context_created(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            context: Option<&mut V8Context>,
        ) {
            let Some(ctx) = context else { return };
            ctx.enter();
            if let Some(global) = ctx.global() {
                if let Some(mut f) = v8_value_create_function(
                    Some(&cef_str("__ddSend")),
                    Some(&mut DdSend::new()),
                ) {
                    global.set_value_bykey(
                        Some(&cef_str("__ddSend")),
                        Some(&mut f),
                        V8Propertyattribute::default(),
                    );
                }
                let mut retval: Option<V8Value> = None;
                let mut exception: Option<cef::V8Exception> = None;
                let ok = ctx.eval(
                    Some(&cef_str(bridge::SHIM_JS)),
                    Some(&cef_str("dd:shim")),
                    0,
                    Some(&mut retval),
                    Some(&mut exception),
                );
                if ok == 0 {
                    eprintln!(
                        "[dd-helper] shim eval failed: {}",
                        exception
                            .map(|e| uf(e.message()))
                            .unwrap_or_else(|| "?".into())
                    );
                }
            }
            ctx.exit();
        }

        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> ::std::os::raw::c_int {
            let (Some(msg), Some(frame)) = (message, frame) else {
                return 0;
            };
            let name = uf(msg.name());
            let Some(args) = msg.argument_list() else { return 0 };
            let arg = |i: usize| uf(args.string(i));
            match name.as_str() {
                bridge::MSG_EVAL => run_eval(frame, &arg(0), &arg(1)),
                bridge::MSG_POST => {
                    let ctx =
                        v8_context_get_current_context().or_else(|| frame.v8_context());
                    if let Some(ctx) = ctx {
                        ctx.enter();
                        if let Some(mut global) = ctx.global() {
                            if let Some(dispatch) =
                                global.value_bykey(Some(&cef_str("__ddDispatch")))
                            {
                                let arg = v8_value_create_string(Some(&cef_str(&arg(0))));
                                dispatch.execute_function_with_context(
                                    Some(&mut ctx.clone()),
                                    Some(&mut global),
                                    Some(&[arg]),
                                );
                            }
                        }
                        ctx.exit();
                    }
                }
                _ => {}
            }
            1
        }
    }
}

// ---------------------------------------------------------------------------
// App — render-process role
// ---------------------------------------------------------------------------

wrap_app! {
    struct HelperApp {}

    impl App {
        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(DdRenderProcess::new())
        }

        fn on_before_command_line_processing(
            &self,
            _process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let Some(cmd) = command_line else { return };
            for sw in ["disable-gpu", "disable-gpu-compositing", "mute-audio"] {
                cmd.append_switch(Some(&cef_str(sw)));
            }
        }
    }
}

fn main() -> std::process::ExitCode {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let args = Args::new();
    let mut app = HelperApp::new();
    let ret = execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        ptr::null_mut(),
    );
    // execute_process returns the subprocess exit code (≥0), or −1 when
    // invoked without a --type switch (i.e. run standalone — misuse).
    std::process::ExitCode::from(if ret >= 0 { ret as u8 } else { 1 })
}
