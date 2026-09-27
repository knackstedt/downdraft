//! winit key → SDL3 keycode translation.
//!
//! The TS side (native-window.ts SDL_SPECIAL_KEYS) expects SDL3 keycodes:
//! printables are their ASCII value (lowercase for letters), named keys are
//! scancode | 0x40000000. We prefer `logical_key` — it is layout-aware, which
//! matches SDL's keysym.sym semantics (AZERTY 'a' reports 'a', not the US
//! physical position). Non-character keys fall back to the physical-key map.

use winit::event::KeyEvent;
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};

/// SDL_SCANCODE_TO_KEYCODE base.
const fn sc(n: u32) -> i32 {
    0x4000_0000 | n as i32
}

pub fn sdl_keycode(event: &KeyEvent) -> i32 {
    // Layout-aware character first — this is what SDL's keysym.sym carries.
    if let Key::Character(s) = &event.logical_key {
        if let Some(ch) = s.chars().next() {
            let ch = ch.to_ascii_lowercase();
            // SDL keycodes for printables are the ASCII codepoint.
            return ch as i32;
        }
    }
    if let Key::Named(named) = &event.logical_key {
        let kc = named_keycode(*named);
        if kc != 0 {
            return kc;
        }
    }
    match event.physical_key {
        PhysicalKey::Code(code) => code_keycode(code),
        PhysicalKey::Unidentified(_) => 0,
    }
}

/// PhysicalKey::Code → SDL keycode (US-layout positional — the fallback for
/// non-character keys and for keys whose logical value is unidentified).
fn code_keycode(code: KeyCode) -> i32 {
    use KeyCode::*;
    match code {
        // Letters → lowercase ASCII (SDLK_a..'z').
        KeyA => 'a' as i32,
        KeyB => 'b' as i32,
        KeyC => 'c' as i32,
        KeyD => 'd' as i32,
        KeyE => 'e' as i32,
        KeyF => 'f' as i32,
        KeyG => 'g' as i32,
        KeyH => 'h' as i32,
        KeyI => 'i' as i32,
        KeyJ => 'j' as i32,
        KeyK => 'k' as i32,
        KeyL => 'l' as i32,
        KeyM => 'm' as i32,
        KeyN => 'n' as i32,
        KeyO => 'o' as i32,
        KeyP => 'p' as i32,
        KeyQ => 'q' as i32,
        KeyR => 'r' as i32,
        KeyS => 's' as i32,
        KeyT => 't' as i32,
        KeyU => 'u' as i32,
        KeyV => 'v' as i32,
        KeyW => 'w' as i32,
        KeyX => 'x' as i32,
        KeyY => 'y' as i32,
        KeyZ => 'z' as i32,
        // Digit row → ASCII digits (physical — SDL's unshifted sym).
        Digit0 => '0' as i32,
        Digit1 => '1' as i32,
        Digit2 => '2' as i32,
        Digit3 => '3' as i32,
        Digit4 => '4' as i32,
        Digit5 => '5' as i32,
        Digit6 => '6' as i32,
        Digit7 => '7' as i32,
        Digit8 => '8' as i32,
        Digit9 => '9' as i32,
        // Punctuation → ASCII.
        Minus => '-' as i32,
        Equal => '=' as i32,
        BracketLeft => '[' as i32,
        BracketRight => ']' as i32,
        Backslash => '\\' as i32,
        Semicolon => ';' as i32,
        Quote => '\'' as i32,
        Backquote => '`' as i32,
        Comma => ',' as i32,
        Period => '.' as i32,
        Slash => '/' as i32,
        Space => ' ' as i32,
        // ASCII-range control keys.
        Enter => 13,
        Escape => 27,
        Backspace => 8,
        Tab => 9,
        Delete => 127,
        NumpadEnter => sc(88), // SDLK_KP_ENTER — not ASCII CR
        // Scancode-based keys (SDL_keymod region values).
        CapsLock => sc(57),
        F1 => sc(58),
        F2 => sc(59),
        F3 => sc(60),
        F4 => sc(61),
        F5 => sc(62),
        F6 => sc(63),
        F7 => sc(64),
        F8 => sc(65),
        F9 => sc(66),
        F10 => sc(67),
        F11 => sc(68),
        F12 => sc(69),
        F13 => sc(104),
        F14 => sc(105),
        F15 => sc(106),
        F16 => sc(107),
        F17 => sc(108),
        F18 => sc(109),
        F19 => sc(110),
        F20 => sc(111),
        F21 => sc(112),
        F22 => sc(113),
        F23 => sc(114),
        F24 => sc(115),
        PrintScreen => sc(70),
        ScrollLock => sc(71),
        Pause => sc(72),
        Insert => sc(73),
        Home => sc(74),
        PageUp => sc(75),
        End => sc(77),
        PageDown => sc(78),
        ArrowRight => sc(79),
        ArrowLeft => sc(80),
        ArrowDown => sc(81),
        ArrowUp => sc(82),
        // Numpad operators.
        NumLock => sc(83),
        NumpadDivide => sc(84),
        NumpadMultiply => sc(85),
        NumpadSubtract => sc(86),
        NumpadAdd => sc(87),
        Numpad1 => sc(89),
        Numpad2 => sc(90),
        Numpad3 => sc(91),
        Numpad4 => sc(92),
        Numpad5 => sc(93),
        Numpad6 => sc(94),
        Numpad7 => sc(95),
        Numpad8 => sc(96),
        Numpad9 => sc(97),
        Numpad0 => sc(98),
        NumpadDecimal => sc(99),
        IntlBackslash => sc(100),
        NumpadEqual => sc(103),
        NumpadComma => sc(133),
        NumpadBackspace => sc(187),
        NumpadClear => sc(219),
        NumpadClearEntry => sc(220),
        NumpadParenLeft => sc(182),
        NumpadParenRight => sc(183),
        NumpadHash => sc(207),
        NumpadStar => sc(85),
        NumpadMemoryStore => sc(211),
        NumpadMemoryRecall => sc(212),
        NumpadMemoryClear => sc(213),
        NumpadMemoryAdd => sc(214),
        NumpadMemorySubtract => sc(215),
        // IME-related positions.
        IntlRo => sc(135),
        IntlYen => sc(137),
        Convert => sc(139),
        NonConvert => sc(138),
        KanaMode => sc(144),
        Lang1 => sc(144),
        Lang2 => sc(145),
        Lang3 => sc(146),
        Lang4 => sc(147),
        Lang5 => sc(148),
        // Modifiers — left/right distinguished.
        ControlLeft => sc(224),
        ShiftLeft => sc(225),
        AltLeft => sc(226),
        SuperLeft => sc(227),
        ControlRight => sc(228),
        ShiftRight => sc(229),
        AltRight => sc(230),
        SuperRight => sc(231),
        // Application / system keys.
        ContextMenu => sc(101),
        Power => sc(102),
        Help => sc(117),
        Props => sc(118),
        Select => sc(119),
        Again => sc(121),
        Undo => sc(122),
        Cut => sc(123),
        Copy => sc(124),
        Paste => sc(125),
        Find => sc(126),
        AudioVolumeMute => sc(127),
        AudioVolumeUp => sc(128),
        AudioVolumeDown => sc(129),
        // Media / browser keys.
        MediaTrackNext => sc(258),
        MediaTrackPrevious => sc(259),
        MediaStop => sc(260),
        MediaPlayPause => sc(261),
        MediaSelect => sc(263),
        BrowserSearch => sc(268),
        BrowserHome => sc(269),
        BrowserBack => sc(270),
        BrowserForward => sc(271),
        BrowserStop => sc(272),
        BrowserRefresh => sc(273),
        BrowserFavorites => sc(274),
        Eject => sc(281),
        Sleep => sc(282),
        LaunchApp1 => sc(283),
        LaunchApp2 => sc(284),
        LaunchMail => sc(265),
        // SDL has no keycodes for these.
        Fn | FnLock | Hyper | Turbo | Abort | Resume | Suspend | WakeUp | F25 | F26 | F27 | F28
        | F29 | F30 | F31 | F32 | F33 | F34 | F35 => 0,
        _ => 0, // KeyCode is non_exhaustive
    }
}

/// Key::Named → SDL keycode for named (non-character) logical keys.
fn named_keycode(named: NamedKey) -> i32 {
    use NamedKey::*;
    match named {
        Enter => 13,
        Tab => 9,
        Space => ' ' as i32,
        ArrowDown => sc(81),
        ArrowLeft => sc(80),
        ArrowRight => sc(79),
        ArrowUp => sc(82),
        Backspace => 8,
        CapsLock => sc(57),
        Delete => 127,
        End => sc(77),
        Escape => 27,
        Home => sc(74),
        Insert => sc(73),
        PageDown => sc(78),
        PageUp => sc(75),
        Pause => sc(72),
        PrintScreen => sc(70),
        ScrollLock => sc(71),
        NumLock => sc(83),
        ContextMenu => sc(101),
        // Modifiers report as left-side (per-side info lives on
        // physical_key — the caller already prefers that path for named).
        Control => sc(224),
        Shift => sc(225),
        Alt => sc(226),
        AltGraph => sc(230),
        Meta | Super => sc(227),
        F1 => sc(58),
        F2 => sc(59),
        F3 => sc(60),
        F4 => sc(61),
        F5 => sc(62),
        F6 => sc(63),
        F7 => sc(64),
        F8 => sc(65),
        F9 => sc(66),
        F10 => sc(67),
        F11 => sc(68),
        F12 => sc(69),
        F13 => sc(104),
        F14 => sc(105),
        F15 => sc(106),
        F16 => sc(107),
        F17 => sc(108),
        F18 => sc(109),
        F19 => sc(110),
        F20 => sc(111),
        F21 => sc(112),
        F22 => sc(113),
        F23 => sc(114),
        F24 => sc(115),
        F25 | F26 | F27 | F28 | F29 | F30 | F31 | F32 | F33 | F34 | F35 => 0,
        Help => sc(117),
        Find => sc(126),
        Undo => sc(122),
        Redo => sc(121),
        Cut => sc(123),
        Copy => sc(124),
        Paste => sc(125),
        Select => sc(119),
        Again => sc(121),
        Execute => sc(116),
        AudioVolumeDown => sc(129),
        AudioVolumeMute => sc(127),
        AudioVolumeUp => sc(128),
        Eject => sc(281),
        Power => sc(102),
        BrightnessDown => sc(275),
        BrightnessUp => sc(276),
        MediaPlay => sc(261),
        MediaPause => sc(19),
        MediaPlayPause => sc(261),
        MediaStop => sc(260),
        MediaTrackNext => sc(258),
        MediaTrackPrevious => sc(259),
        MediaRewind => sc(285),
        MediaFastForward => sc(286),
        MediaRecord => 0,
        LaunchMail => sc(265),
        BrowserBack => sc(270),
        BrowserForward => sc(271),
        BrowserHome => sc(269),
        BrowserRefresh => sc(273),
        BrowserSearch => sc(268),
        BrowserStop => sc(272),
        BrowserFavorites => sc(274),
        LaunchApplication1 => sc(283),
        LaunchApplication2 => sc(284),
        Standby => sc(282),
        WakeUp => 0,
        _ => 0, // NamedKey is non_exhaustive
    }
}
