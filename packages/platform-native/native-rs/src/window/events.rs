//! Event translation: winit events → flat SDL_SHIM_EVENT_* wire format.
//!
//! Queue model mirrors SDL_PollEvent: winit's pump delivers a burst of
//! events which we enqueue translated; each sdl_shim_poll_event call pops
//! one and writes its int/float/char slots.

use super::{Ctx, KMOD_ALT, KMOD_CTRL, KMOD_GUI, KMOD_SHIFT};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr;
use winit::event::{DeviceEvent, ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};

pub const NONE: i32 = 0;
const QUIT: i32 = 1;
const KEY_DOWN: i32 = 2;
const KEY_UP: i32 = 3;
const MOUSE_MOVE: i32 = 4;
const MOUSE_DOWN: i32 = 5;
const MOUSE_UP: i32 = 6;
const WHEEL: i32 = 7;
const RESIZE: i32 = 8;
const TEXT_INPUT: i32 = 9;
const FOCUS_LOST: i32 = 10;
const MOVED: i32 = 11;
const DROP_FILE: i32 = 12;
const FOCUS_GAINED: i32 = 13;

/// Line-detent approximation for pixel-precise scroll deltas (PixelDelta
/// arrives from touchpads; SDL always reports line units).
const PIXELS_PER_LINE: f32 = 16.0;

pub enum Ev {
    Quit,
    Key {
        down: bool,
        keycode: i32,
        mods: i32,
        repeat: i32,
    },
    MouseMove {
        x: i32,
        y: i32,
        xrel: i32,
        yrel: i32,
        buttons: i32,
        mods: i32,
    },
    MouseBtn {
        down: bool,
        x: i32,
        y: i32,
        button: i32,
        buttons: i32,
        mods: i32,
    },
    Wheel {
        dx: f32,
        dy: f32,
        mods: i32,
        mx: i32,
        my: i32,
    },
    Resize {
        w: i32,
        h: i32,
    },
    Focused {
        gained: bool,
    },
    Moved {
        x: i32,
        y: i32,
    },
    Drop(String),
    Text(String),
}

thread_local! {
    static QUEUE: RefCell<VecDeque<Ev>> = RefCell::new(VecDeque::new());
}

pub fn push(ev: Ev) {
    QUEUE.with(|q| q.borrow_mut().push_back(ev));
}

pub fn take() -> Option<Ev> {
    QUEUE.with(|q| q.borrow_mut().pop_front())
}

pub fn clear() {
    QUEUE.with(|q| q.borrow_mut().clear());
}

/// Write one queued event into the caller's out_data buffer. Returns the
/// SDL_SHIM_EVENT_* type code (NONE for no event).
pub fn write(ev: Ev, out_data: *mut c_void) -> i32 {
    if out_data.is_null() {
        return NONE;
    }
    let iout = out_data as *mut i32;
    let fout = out_data as *mut f32;
    unsafe {
        match ev {
            Ev::Quit => QUIT,
            Ev::Key {
                down,
                keycode,
                mods,
                repeat,
            } => {
                *iout.add(0) = keycode;
                *iout.add(1) = mods;
                *iout.add(2) = if down { repeat } else { 0 };
                if down {
                    KEY_DOWN
                } else {
                    KEY_UP
                }
            }
            Ev::MouseMove {
                x,
                y,
                xrel,
                yrel,
                buttons,
                mods,
            } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                *iout.add(2) = xrel;
                *iout.add(3) = yrel;
                *iout.add(4) = buttons;
                *iout.add(5) = mods;
                MOUSE_MOVE
            }
            Ev::MouseBtn {
                down,
                x,
                y,
                button,
                buttons,
                mods,
            } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                *iout.add(2) = button;
                *iout.add(3) = buttons;
                *iout.add(4) = mods;
                if down {
                    MOUSE_DOWN
                } else {
                    MOUSE_UP
                }
            }
            Ev::Wheel {
                dx,
                dy,
                mods,
                mx,
                my,
            } => {
                *fout.add(0) = dx;
                *fout.add(1) = dy;
                *iout.add(2) = mods;
                *iout.add(3) = mx;
                *iout.add(4) = my;
                WHEEL
            }
            Ev::Resize { w, h } => {
                *iout.add(0) = w;
                *iout.add(1) = h;
                RESIZE
            }
            Ev::Focused { gained } => {
                if gained {
                    FOCUS_GAINED
                } else {
                    FOCUS_LOST
                }
            }
            Ev::Moved { x, y } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                MOVED
            }
            Ev::Drop(path) => {
                write_cstr(out_data as *mut u8, &path, 255);
                DROP_FILE
            }
            Ev::Text(s) => {
                write_cstr(out_data as *mut u8, &s, 31);
                TEXT_INPUT
            }
        }
    }
}

unsafe fn write_cstr(out: *mut u8, s: &str, max: usize) {
    let bytes = s.as_bytes();
    let n = bytes.len().min(max);
    ptr::copy_nonoverlapping(bytes.as_ptr(), out, n);
    *out.add(n) = 0;
}

pub fn translate_window_event(
    ctx: &mut Ctx,
    ev: WindowEvent,
    _el: &winit::event_loop::ActiveEventLoop,
) {
    match ev {
        WindowEvent::CloseRequested => push(Ev::Quit),

        WindowEvent::Resized(size) => {
            push(Ev::Resize {
                w: size.width as i32,
                h: size.height as i32,
            });
        }

        WindowEvent::Moved(pos) => {
            push(Ev::Moved { x: pos.x, y: pos.y });
        }

        WindowEvent::Focused(gained) => push(Ev::Focused { gained }),

        WindowEvent::ModifiersChanged(m) => {
            let s = m.state();
            ctx.mods = (if s.shift_key() { KMOD_SHIFT } else { 0 })
                | (if s.control_key() { KMOD_CTRL } else { 0 })
                | (if s.alt_key() { KMOD_ALT } else { 0 })
                | (if s.super_key() { KMOD_GUI } else { 0 });
        }

        WindowEvent::KeyboardInput { event, .. } => {
            let down = event.state == ElementState::Pressed;
            let keycode = super::keys::sdl_keycode(&event);
            push(Ev::Key {
                down,
                keycode,
                mods: ctx.mods,
                repeat: if event.repeat { 1 } else { 0 },
            });
            // SDL delivers TEXTINPUT after KEYDOWN for printable keys when
            // text input is active. When IME is allowed winit routes text
            // through Ime::Commit instead and event.text is None — no dupes.
            if down && ctx.text_input {
                if let Some(text) = event.text.as_ref() {
                    if !text.is_empty() {
                        push(Ev::Text(text.to_string()));
                    }
                }
            }
        }

        WindowEvent::Ime(Ime::Commit(s)) => {
            if ctx.text_input {
                push(Ev::Text(s));
            }
        }

        WindowEvent::CursorMoved { position, .. } => {
            if ctx.grabbed {
                return; // grabbed motion arrives via DeviceEvent::MouseMotion
            }
            let (lx, ly) = ctx.cursor;
            let x = position.x.round() as i32;
            let y = position.y.round() as i32;
            let xrel = (position.x - lx).round() as i32;
            let yrel = (position.y - ly).round() as i32;
            ctx.cursor = (position.x, position.y);
            push(Ev::MouseMove {
                x,
                y,
                xrel,
                yrel,
                buttons: ctx.buttons as i32,
                mods: ctx.mods,
            });
        }

        WindowEvent::MouseInput { state, button, .. } => {
            let idx = sdl_button(button);
            if idx > 0 && idx <= 31 {
                let bit = 1u32 << (idx - 1);
                match state {
                    ElementState::Pressed => ctx.buttons |= bit,
                    ElementState::Released => ctx.buttons &= !bit,
                }
            }
            let (cx, cy) = ctx.cursor;
            push(Ev::MouseBtn {
                down: state == ElementState::Pressed,
                x: cx.round() as i32,
                y: cy.round() as i32,
                button: idx,
                buttons: ctx.buttons as i32,
                mods: ctx.mods,
            });
        }

        WindowEvent::MouseWheel { delta, .. } => {
            let (dx, dy) = match delta {
                MouseScrollDelta::LineDelta(x, y) => (x, y),
                MouseScrollDelta::PixelDelta(p) => {
                    (p.x as f32 / PIXELS_PER_LINE, p.y as f32 / PIXELS_PER_LINE)
                }
            };
            let (cx, cy) = ctx.cursor;
            push(Ev::Wheel {
                dx,
                dy,
                mods: ctx.mods,
                mx: cx.round() as i32,
                my: cy.round() as i32,
            });
        }

        WindowEvent::DroppedFile(path) => {
            push(Ev::Drop(path.to_string_lossy().into_owned()));
        }

        _ => {}
    }
}

/// Raw device motion — only surfaced while the cursor is grabbed, matching
/// SDL's relative-mouse-mode semantics (xrel/yrel only; x/y stay put).
pub fn translate_device_event(ctx: &mut Ctx, ev: DeviceEvent) {
    if let DeviceEvent::MouseMotion { delta } = ev {
        if !ctx.grabbed {
            return;
        }
        let (cx, cy) = ctx.cursor;
        push(Ev::MouseMove {
            x: cx.round() as i32,
            y: cy.round() as i32,
            xrel: delta.0.round() as i32,
            yrel: delta.1.round() as i32,
            buttons: ctx.buttons as i32,
            mods: ctx.mods,
        });
    }
}

/// winit MouseButton → SDL button number (1=left, 2=middle, 3=right,
/// 4=X1/back, 5=X2/forward).
fn sdl_button(b: MouseButton) -> i32 {
    match b {
        MouseButton::Left => 1,
        MouseButton::Middle => 2,
        MouseButton::Right => 3,
        MouseButton::Back => 4,
        MouseButton::Forward => 5,
        MouseButton::Other(v) => 5 + v as i32 + 1, // keep distinct from 1..5
    }
}
