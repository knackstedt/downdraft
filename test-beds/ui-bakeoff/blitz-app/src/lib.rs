//! bakeoff-blitz-ui — Dioxus component gallery for the ui-bakeoff test bed.
//!
//! Thin wasm_bindgen shim over downdraft-blitz-shell: this crate owns only
//! the RSX component tree + the snapshot applier. Input, rasterization
//! (vello_cpu), and the JS bridge live in the shell.

use dioxus::prelude::*;
use dioxus_core::ScopeId;
use dioxus_signals::{GlobalSignal, Signal};
use downdraft_blitz_shell::{
    dispatch_action, dump_dom, frame, hit_test, init, push_input, push_snapshot, resize,
    set_action_cb, shutdown, tick, PendingInput, ShellConfig,
};
use js_sys::Function;
use serde::Deserialize;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

// ── Snapshot channel (TS → wasm) ──
// ui_set_state pushes raw JSON; apply_snapshot deserializes it here and
// writes the global signal the UI reads — demonstrating the state bridge.

#[derive(Deserialize, Default, Clone)]
struct UiSnap {
    #[serde(default)]
    note: String,
    #[serde(default)]
    clicks: i32,
}

static SNAP: GlobalSignal<UiSnap> = Signal::global(UiSnap::default);

// ── Gallery ──

const TABS: [&str; 5] = ["imui", "PixiJS", "Dioxus", "HTML/CSS", "Canvas2D"];
const LIST_ITEMS: [&str; 14] = [
    "Iron Ore", "Copper Ore", "Coal", "Stone", "Wood Plank", "Rope", "Torch",
    "Fuse", "C4 Charge", "Gold Ore", "Silver Ore", "Mushroom", "Star Shard",
    "Void Essence",
];

fn tab_style(active: bool) -> String {
    format!(
        "padding:6px 14px;border-radius:4px;font-size:14px;cursor:pointer;{}",
        if active {
            "background:#2e4361;color:#7fd0ff;font-weight:bold;"
        } else {
            "background:#1c222c;color:#8a94a3;"
        }
    )
}

fn app() -> Element {
    let mut checks = use_signal(|| [true, false, true]);
    let mut seg = use_signal(|| 1usize);
    let mut slider = use_signal(|| 65i32);
    let mut sel = use_signal(|| 2usize);
    let mut clicks = use_signal(|| 0i32);
    let mut hp = use_signal(|| 78i32);
    let mut mana = use_signal(|| 55i32);

    let check_row = |i: usize, label: &'static str| {
        let box_bg = if checks()[i] { "#4fc2f7" } else { "#161b23" };
        rsx! {
            div {
                "data-ui": "",
                style: "display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;",
                onclick: move |_| checks.write()[i] = !checks()[i],
                div { style: "width:16px;height:16px;border:1px solid #4a5568;border-radius:3px;background:{box_bg};display:flex;align-items:center;justify-content:center;color:#10141a;font-size:11px;font-weight:bold;",
                    if checks()[i] { "X" }
                }
                div { style: "font-size:13px;color:#e8ecf1;", "{label}" }
            }
        }
    };

    let action_btn = |label: &'static str, style: &'static str, act: &'static str, enabled: bool| {
        rsx! {
            button {
                "data-ui": "",
                style: "padding:8px 14px;border-radius:4px;border:1px solid #3a4553;font-size:13px;{style}",
                onclick: move |_| {
                    if enabled {
                        *clicks.write() += 1;
                        dispatch_action(act, "{}");
                    }
                },
                "{label}"
            }
        }
    };

    rsx! {
        div { style: "width:100%;height:100%;background:#10141a;color:#e8ecf1;font-family:sans-serif;display:flex;flex-direction:column;box-sizing:border-box;",
            // ── Tab bar (this stack renders the active state; clicks dispatch to TS) ──
            div { style: "display:flex;align-items:center;gap:8px;padding:12px 16px;background:#161b23;border-bottom:1px solid #2a313c;",
                div { style: "font-size:15px;font-weight:bold;color:#e8ecf1;margin-right:12px;", "UI Bake-off" }
                for (i, name) in TABS.iter().enumerate() {
                    div {
                        "data-ui": "",
                        style: "{tab_style(i == 2)}",
                        onclick: move |_| dispatch_action("tab", &format!("{{\"index\":{i}}}")),
                        "{name}"
                    }
                }
                div { style: "margin-left:auto;font-size:11px;color:#5d6775;", "keys 1-5 / arrows to switch" }
            }

            div { style: "display:flex;flex:1;padding:16px;gap:16px;box-sizing:border-box;",
                // ── Left: widget column ──
                div { style: "width:380px;background:#161b23;border:1px solid #2a313c;border-radius:6px;padding:14px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;",
                    div { style: "font-size:13px;color:#8a94a3;letter-spacing:1px;", "WIDGETS — DIOXUS (BLITZ WASM)" }

                    // Buttons
                    div { style: "display:flex;gap:8px;",
                        {action_btn("Normal", "background:#212933;color:#e8ecf1;", "click_normal", true)}
                        {action_btn("Accent", "background:#1d3547;color:#7fd0ff;border-color:#4fc2f7;", "click_accent", true)}
                        {action_btn("Danger", "background:#3a1d1d;color:#f28b82;border-color:#e5534b;", "click_danger", true)}
                        {action_btn("Disabled", "background:#1a1f27;color:#4a5568;", "click_disabled", false)}
                    }

                    // Checkboxes
                    div { style: "display:flex;flex-direction:column;",
                        {check_row(0, "VSync")}
                        {check_row(1, "Fullscreen")}
                        {check_row(2, "Bloom")}
                    }

                    // Slider
                    div { style: "display:flex;flex-direction:column;gap:4px;",
                        div { style: "display:flex;justify-content:space-between;font-size:12px;color:#8a94a3;",
                            span { "Volume" }
                            span { "{slider}" }
                        }
                        div {
                            "data-ui": "",
                            style: "height:14px;background:#212933;border-radius:7px;position:relative;cursor:pointer;",
                            onpointerdown: move |evt| {
                                let x = evt.client_coordinates().x;
                                // track starts at x=46 (16+14 padding + border) with width 348
                                let v = ((x - 46.0) / 348.0 * 100.0).round() as i32;
                                *slider.write() = v.clamp(0, 100);
                            },
                            div { style: "height:14px;width:{slider}%;background:#4fc2f7;border-radius:7px;" }
                        }
                    }

                    // Progress bar
                    div { style: "display:flex;flex-direction:column;gap:4px;",
                        div { style: "display:flex;justify-content:space-between;font-size:12px;color:#8a94a3;",
                            span { "Loading" }
                            span { "42%" }
                        }
                        div { style: "height:10px;background:#212933;border-radius:5px;",
                            div { style: "height:10px;width:42%;background:#6fbf73;border-radius:5px;" }
                        }
                    }

                    // Segmented
                    div { style: "display:flex;gap:4px;background:#0f1319;border-radius:5px;padding:3px;width:fit-content;",
                        for (i, name) in ["Items", "Stats", "Log"].iter().enumerate() {
                            div {
                                "data-ui": "",
                                style: if seg() == i {
                                    "padding:5px 16px;border-radius:4px;font-size:12px;cursor:pointer;background:#2e4361;color:#7fd0ff;"
                                } else {
                                    "padding:5px 16px;border-radius:4px;font-size:12px;cursor:pointer;color:#8a94a3;"
                                },
                                onclick: move |_| *seg.write() = i,
                                "{name}"
                            }
                        }
                    }

                    // Scroll list
                    div { style: "display:flex;flex-direction:column;gap:4px;",
                        div { style: "font-size:12px;color:#8a94a3;", "Inventory (scroll)" }
                        div {
                            "data-ui": "",
                            style: "height:120px;overflow-y:auto;background:#0f1319;border:1px solid #2a313c;border-radius:4px;",
                            for (i, item) in LIST_ITEMS.iter().enumerate() {
                                div {
                                    "data-ui": "",
                                    style: if sel() == i {
                                        "padding:6px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid #1c222c;background:#2e4361;color:#7fd0ff;"
                                    } else {
                                        "padding:6px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid #1c222c;color:#c8d0db;"
                                    },
                                    onclick: move |_| *sel.write() = i,
                                    "{item}"
                                }
                            }
                        }
                    }

                    // Text field (visual — Blitz input elements are limited)
                    div { style: "display:flex;flex-direction:column;gap:4px;",
                        div { style: "font-size:12px;color:#8a94a3;", "Callsign" }
                        div { style: "padding:7px 10px;background:#0f1319;border:1px solid #4a5568;border-radius:4px;font-size:13px;color:#e8ecf1;",
                            "Scout-7"
                            span { style: "color:#4fc2f7;", "|" }
                        }
                    }
                }

                // ── Right: HUD mock ──
                div { style: "flex:1;display:flex;flex-direction:column;gap:14px;",
                    div { style: "background:#161b23;border:1px solid #2a313c;border-radius:6px;padding:14px;display:flex;flex-direction:column;gap:10px;",
                        div { style: "font-size:13px;color:#8a94a3;letter-spacing:1px;", "HUD MOCK" }
                        // HP bar
                        div { style: "display:flex;flex-direction:column;gap:4px;",
                            div { style: "display:flex;justify-content:space-between;font-size:12px;color:#8a94a3;",
                                span { "HP" }
                                span { "{hp} / 100" }
                            }
                            div {
                                "data-ui": "",
                                style: "height:16px;background:#212933;border-radius:4px;cursor:pointer;",
                                onpointerdown: move |evt| {
                                    let x = evt.client_coordinates().x;
                                    let v = ((x - 414.0) / 780.0 * 100.0).round() as i32;
                                    *hp.write() = v.clamp(0, 100);
                                },
                                div { style: "height:16px;width:{hp}%;background:linear-gradient(90deg,#e5534b,#f0a04b);border-radius:4px;" }
                            }
                        }
                        // Mana bar
                        div { style: "display:flex;flex-direction:column;gap:4px;",
                            div { style: "display:flex;justify-content:space-between;font-size:12px;color:#8a94a3;",
                                span { "Mana" }
                                span { "{mana} / 100" }
                            }
                            div {
                                "data-ui": "",
                                style: "height:16px;background:#212933;border-radius:4px;cursor:pointer;",
                                onpointerdown: move |evt| {
                                    let x = evt.client_coordinates().x;
                                    let v = ((x - 414.0) / 780.0 * 100.0).round() as i32;
                                    *mana.write() = v.clamp(0, 100);
                                },
                                div { style: "height:16px;width:{mana}%;background:#4fc2f7;border-radius:4px;" }
                            }
                        }
                        // Clicks + snapshot note
                        div { style: "display:flex;gap:16px;font-size:12px;color:#8a94a3;",
                            span { "Clicks: {clicks}" }
                            span { "note: {SNAP().note}" }
                        }
                    }

                    // Toast sample
                    div { style: "background:#1d2a1d;border:1px solid #4a7a4a;border-radius:6px;padding:10px 14px;font-size:12px;color:#9fd89f;width:fit-content;",
                        "Item added to inventory"
                    }
                }
            }
        }
    }
}

// ── wasm_bindgen shims (surface expected by BlitzWasmModule) ──

#[wasm_bindgen]
pub fn ui_init_headless(width: f64, height: f64, scale: f64, on_action: Function) {
    console_error_panic_hook::set_once();
    set_action_cb(on_action);
    init(
        ShellConfig {
            root: app,
            apply_snapshot: Rc::new(|vdom, json| {
                let snap: UiSnap =
                    serde_json::from_str(json).map_err(|e| format!("bad snapshot: {e}"))?;
                vdom.in_scope(ScopeId::ROOT, || {
                    *SNAP.write() = snap;
                });
                Ok(())
            }),
            font: None,
        },
        width,
        height,
        scale,
    );
}

#[wasm_bindgen]
pub fn ui_resize(width: f64, height: f64, scale: f64) {
    resize(width, height, scale);
}

#[wasm_bindgen]
pub fn ui_shutdown() {
    shutdown();
}

#[wasm_bindgen]
pub fn ui_tick() -> bool {
    tick()
}

#[wasm_bindgen]
pub fn ui_frame() -> Vec<u8> {
    frame()
}

#[wasm_bindgen]
pub fn ui_set_state(json: &str) {
    push_snapshot(json.to_string());
}

#[wasm_bindgen]
pub fn ui_dump() -> String {
    dump_dom()
}

#[wasm_bindgen]
pub fn ui_pointer(kind: u8, x: f64, y: f64, button: u8, mods: u8) {
    push_input(PendingInput::Pointer { kind, x, y, button, mods });
}

#[wasm_bindgen]
pub fn ui_pointer_leave() {
    push_input(PendingInput::PointerLeave);
}

#[wasm_bindgen]
pub fn ui_wheel(dx: f64, dy: f64, x: f64, y: f64, mods: u8) {
    push_input(PendingInput::Wheel { dx, dy, x, y, mods });
}

#[wasm_bindgen]
pub fn ui_key(pressed: bool, key: &str, code: &str, mods: u8, text: Option<String>) {
    push_input(PendingInput::Key {
        pressed,
        key: key.to_string(),
        code: code.to_string(),
        mods,
        text,
    });
}

#[wasm_bindgen]
pub fn ui_hit_test(x: f64, y: f64) -> bool {
    hit_test(x, y)
}
