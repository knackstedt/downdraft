//! Input events injected from JS. The host pushes `PendingInput`s onto the
//! bridge queue; the shell drains them inside `ui_tick` where it can reach
//! the document.
//!
//! Coordinates arrive in canvas *backing* pixels (the engine's InputManager
//! already converts DOM client coords to canvas space). We convert to the
//! document's logical/CSS pixel space using the viewport scale when
//! dispatching.

use std::str::FromStr;

use keyboard_types::{Code, Key, Location, Modifiers};
use smol_str::SmolStr;

/// Keyboard modifiers as a bitmask matching JS `MouseEvent` flags:
/// shift=1, ctrl=2, alt=4, meta=8 (same packing the TS router produces).
pub fn mods_from_bits(bits: u8) -> Modifiers {
    let mut m = Modifiers::empty();
    if bits & 1 != 0 {
        m |= Modifiers::SHIFT;
    }
    if bits & 2 != 0 {
        m |= Modifiers::CONTROL;
    }
    if bits & 4 != 0 {
        m |= Modifiers::ALT;
    }
    if bits & 8 != 0 {
        m |= Modifiers::META;
    }
    m
}

#[derive(Debug)]
pub enum PendingInput {
    /// kind: 0=move 1=down 2=up 3=cancel
    Pointer { kind: u8, x: f64, y: f64, button: u8, mods: u8 },
    Wheel { dx: f64, dy: f64, x: f64, y: f64, mods: u8 },
    /// pressed: true=keydown false=keyup
    Key { pressed: bool, key: String, code: String, mods: u8, text: Option<String> },
    PointerLeave,
}

impl PendingInput {
    pub fn key_event(
        pressed: bool,
        key: &str,
        code: &str,
        mods: u8,
        text: Option<String>,
    ) -> blitz_traits::events::BlitzKeyEvent {
        use blitz_traits::events::{BlitzKeyEvent, KeyState};
        let key = match key {
            "Escape" => Key::Escape,
            "Enter" => Key::Enter,
            "Tab" => Key::Tab,
            "Backspace" => Key::Backspace,
            "Delete" => Key::Delete,
            "ArrowUp" => Key::ArrowUp,
            "ArrowDown" => Key::ArrowDown,
            "ArrowLeft" => Key::ArrowLeft,
            "ArrowRight" => Key::ArrowRight,
            "Alt" => Key::Alt,
            "Shift" => Key::Shift,
            "Control" => Key::Control,
            "Meta" => Key::Meta,
            other => Key::Character(other.to_string()),
        };
        BlitzKeyEvent {
            key,
            code: Code::from_str(code).unwrap_or(Code::Unidentified),
            modifiers: mods_from_bits(mods),
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state: if pressed { KeyState::Pressed } else { KeyState::Released },
            text: text.map(SmolStr::new),
        }
    }
}
