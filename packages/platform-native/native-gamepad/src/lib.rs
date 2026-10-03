//! downdraft-gamepad — gamepad backend cdylib (gilrs).
//!
//! Optional companion to downdraft_platform: the host loads it via
//! `resolveNativeLibrary("downdraft_gamepad", { optional: true })`. Absence or
//! dlopen failure simply means "no gamepad support" — gilrs hard-links
//! libudev on Linux, so this must never be folded into the platform library
//! proper (a missing libudev would take the whole engine down).
//!
//! Wire contract — 'gamepad-devices' SAB channel (little-endian), mirrored by
//! packages/engine/core/src/sab/gamepad-devices.ts. All fields are 4-byte
//! aligned so the generic `defineChannel` layout reproduces them exactly.
//!
//!   Header (64 B):
//!     [0x00] u32 magic     = 0x50474444 ("DDGP")
//!     [0x04] u32 version   = 1
//!     [0x08] u32 sequence  (bumped once per snapshot pass)
//!     [0x0C] u32 connectedMask  (bit n = slot n connected)
//!     [0x10..0x40] reserved
//!
//!   Per-slot (128 B, starts at 0x40). Single-writer constraint: Rust owns
//!   every field except `hostMeta`, which is written by JS enrichment.
//!
//!     [0x00] u32 meta0      = connected | padType<<8 | connType<<16 | battery<<24
//!                           (battery: 0..100; 255 unknown; 254 wired/no battery)
//!     [0x04] u32 meta1      = flags (bit0 ffSupported, bit1 charging, bit2 aux)
//!     [0x08] u32 hostMeta   = rssi | jsFlags<<8 | reserved   ← JS WRITES THIS
//!     [0x0C] u32 buttonsLo  (standard-layout bitmask, see below)
//!     [0x10] u32 buttonsHi  (bit32+ — touchpad/paddles/misc, reserved)
//!     [0x14] f32 axes[8]    (lx ly rx ry lt rt dpadX dpadY)
//!     [0x34] u32 lastEventMs (ms since init, wrapping)
//!     [0x38] u32 slotSeq    (per-slot write counter)
//!     [0x3C] u32 vendorId
//!     [0x40] u32 productId
//!     [0x44] u8  name[56]   (NUL-padded UTF-8)
//!     [0x7C] u32 aux        = eventNode | reserved<<16 — Linux /dev/input/eventN
//!                           index for sysfs correlation; 0xFFFF when unknown.
//!
//! Standard button bitmask (buttonsLo):
//!   0 south 1 east 2 west 3 north 4 leftShoulder 5 rightShoulder
//!   6 leftTriggerBtn 7 rightTriggerBtn 8 select 9 start 10 home
//!   11 leftStick 12 rightStick 13..16 dpadUp/Down/Left/Right
//!   17 c 18 z 19 capture
//!
//! Threading: a dedicated worker thread owns `gilrs::Gilrs` (Send but not
//! Sync). JS↔Rust communication is one-way attach + a command channel
//! (rumble / deadzone / rescan / shutdown). gilrs reads evdev directly on
//! Linux, so gamepad input keeps flowing while the window is unfocused —
//! required for HTPC-style "controller wakes the UI" behavior.
//!
//! Device classification is ported from Ember's src/main/input/evdev.ts
//! (vendor/product tables + name heuristics) — that code encodes real
//! hardware quirks; keep the tables in sync when either side grows a case.

use gilrs::ff::{BaseEffect, BaseEffectType, EffectBuilder, Replay, Ticks};
use gilrs::{Axis, Button, EventType, Gilrs};
use std::collections::HashMap;
use std::ffi::c_int;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

// ── ABI constants (keep in sync with core/src/sab/gamepad-devices.ts) ────────

const MAGIC: u32 = 0x5047_4444; // "DDGP"
const VERSION: u32 = 1;
const HEADER_SIZE: usize = 64;
const SLOT_SIZE: usize = 128;
const MAX_SLOTS: usize = 16;

const OFF_CONNECTED_MASK: usize = 0x0c;
const OFF_SEQUENCE: usize = 0x08;

const SLOT_META0: usize = 0x00;
const SLOT_META1: usize = 0x04;
// 0x08 hostMeta — JS enrichment (sysfs rssi etc.) writes here; Rust never does.
const SLOT_BUTTONS_LO: usize = 0x0c;
const SLOT_BUTTONS_HI: usize = 0x10;
const SLOT_AXES: usize = 0x14;
const SLOT_LAST_EVENT_MS: usize = 0x34;
const SLOT_SLOT_SEQ: usize = 0x38;
const SLOT_VENDOR: usize = 0x3c;
const SLOT_PRODUCT: usize = 0x40;
const SLOT_NAME: usize = 0x44;
const SLOT_NAME_LEN: usize = 56;
const SLOT_AUX: usize = 0x7c;

const FLAG_FF: u8 = 1 << 0;
const FLAG_CHARGING: u8 = 1 << 1;

/// Engine pad-type enum (u8). Classified here in Rust so slots are
/// self-describing; the JS layer may refine via sysfs enrichment.
#[allow(dead_code)] // enum constants document the ABI; not all are emitted
mod pad_type {
    pub const UNKNOWN: u8 = 0;
    pub const XBOX: u8 = 1;
    pub const PS3: u8 = 2;
    pub const PS4: u8 = 3;
    pub const PS5: u8 = 4;
    pub const SWITCH: u8 = 5;
    pub const GAMECUBE: u8 = 6;
    pub const N64: u8 = 7;
    pub const WIIMOTE: u8 = 8;
    pub const STEAM: u8 = 9;
    pub const GENERIC: u8 = 10;
}

#[allow(dead_code)] // enum constants document the ABI; not all are emitted
mod conn_type {
    pub const UNKNOWN: u8 = 0;
    pub const WIRED: u8 = 1;
    pub const BLUETOOTH: u8 = 2;
    pub const DONGLE: u8 = 3;
}

/// Ember-style classification: vendor/product first, then name heuristics.
/// `uuid[0..2]` is the bus type on Linux (BUS_USB=0x03, BUS_BLUETOOTH=0x05).
fn classify(name: &str, vendor: Option<u16>, product: Option<u16>) -> u8 {
    let n = name.to_ascii_lowercase();
    let v = vendor.unwrap_or(0);
    let p = product.unwrap_or(0);

    if n.contains("xbox") || v == 0x045e || n.contains("xinput") {
        return pad_type::XBOX;
    }
    if v == 0x054c {
        return match p {
            0x0268 => pad_type::PS3,
            0x05c4 | 0x09cc => pad_type::PS4,
            0x0ce6 => pad_type::PS5,
            _ if n.contains("dualsense") => pad_type::PS5,
            _ => pad_type::PS4,
        };
    }
    if v == 0x057e || n.contains("joy-con") || (n.contains("nintendo") && n.contains("switch")) {
        return pad_type::SWITCH;
    }
    if n.contains("wiimote") || n.contains("wii remote") {
        return pad_type::WIIMOTE;
    }
    // DragonRise N64 adapter (0x0079:0x181c "Android Gamepad"), then generic
    // DragonRise (GameCube/N64 clones) → gamecube.
    if v == 0x0079 && p == 0x181c {
        return pad_type::N64;
    }
    if n.contains("n64") {
        return pad_type::N64;
    }
    if n.contains("gamecube") || n.contains("microntek") || v == 0x0079 {
        return pad_type::GAMECUBE;
    }
    if v == 0x28de || n.contains("steam") {
        return pad_type::STEAM;
    }
    if n.contains("dualshock") || n.contains("dual shock") {
        return pad_type::PS4;
    }
    if n.contains("dualsense") {
        return pad_type::PS5;
    }
    pad_type::GENERIC
}

fn classify_conn(uuid: &[u8; 16], vendor: Option<u16>, product: Option<u16>) -> u8 {
    let v = vendor.unwrap_or(0);
    let p = product.unwrap_or(0);

    // Wireless dongles that enumerate over USB (ported from ember evdev.ts).
    if v == 0x045e {
        // Xbox One/Series + 360 wireless receivers.
        if matches!(p, 0x02fe | 0x02fd | 0x0916 | 0x0b4f | 0x0816 | 0x0719 | 0x0291) {
            return conn_type::DONGLE;
        }
    }
    if v == 0x054c && p == 0x0ba0 {
        return conn_type::DONGLE; // Sony wireless adapter
    }
    if v == 0x2dc8 {
        return conn_type::DONGLE; // 8BitDo
    }

    // gilrs uuid: [bus(2), vendor(2), product(2), version(2), ...] LE.
    let bus = u16::from_le_bytes([uuid[0], uuid[1]]);
    match bus {
        0x05 => conn_type::BLUETOOTH, // BUS_BLUETOOTH
        0x03 => conn_type::WIRED,     // BUS_USB
        _ => conn_type::UNKNOWN,
    }
}

fn map_button(b: Button) -> Option<u8> {
    Some(match b {
        Button::South => 0,
        Button::East => 1,
        Button::West => 2,
        Button::North => 3,
        Button::LeftTrigger => 4,
        Button::RightTrigger => 5,
        Button::LeftTrigger2 => 6,
        Button::RightTrigger2 => 7,
        Button::Select => 8,
        Button::Start => 9,
        Button::Mode => 10,
        Button::LeftThumb => 11,
        Button::RightThumb => 12,
        Button::DPadUp => 13,
        Button::DPadDown => 14,
        Button::DPadLeft => 15,
        Button::DPadRight => 16,
        Button::C => 17,
        Button::Z => 18,
        _ => return None,
    })
}

const AXIS_IX: [Axis; 8] = [
    Axis::LeftStickX,
    Axis::LeftStickY,
    Axis::RightStickX,
    Axis::RightStickY,
    Axis::LeftZ,
    Axis::RightZ,
    Axis::DPadX,
    Axis::DPadY,
];

/// Circular deadzone: rescale (lx,ly) so magnitude < r reads 0 and the ring
/// r..1 maps to 0..1 without a direction change.
fn deadzone_pair(x: f32, y: f32, r: f32) -> (f32, f32) {
    let len = (x * x + y * y).sqrt();
    if len <= r || len == 0.0 {
        return (0.0, 0.0);
    }
    let scale = ((len - r) / (1.0 - r)).min(1.0) / len;
    (x * scale, y * scale)
}

/// gilrs normalizes nec axes to [-1,1] via AxisInfo min/max — including
/// analog triggers that rest at min. Remap triggers to 0..1.
fn trigger(v: f32) -> f32 {
    ((v + 1.0) * 0.5).clamp(0.0, 1.0)
}

// ── Worker thread ───────────────────────────────────────────────────────────

enum Cmd {
    Rumble { slot: u32, weak: u16, strong: u16, ms: u32 },
    SetDeadzone { radius: f32 },
    Rescan,
    Shutdown,
}

struct Backend {
    cmd_tx: Sender<Cmd>,
    stop: Arc_<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

use std::sync::Arc as Arc_;

static BACKEND: Mutex<Option<Backend>> = Mutex::new(None);
/// Attached SAB: (ptr, len). Written once by attach, cleared by destroy.
static SAB_PTR: AtomicUsize = AtomicUsize::new(0);
static SAB_LEN: AtomicUsize = AtomicUsize::new(0);


struct Sab {
    base: *mut u8,
    #[allow(dead_code)] // kept for future bounds-checked variants
    len: usize,
}
unsafe impl Send for Sab {}

impl Sab {
    fn get() -> Option<Sab> {
        let p = SAB_PTR.load(Ordering::Acquire);
        if p == 0 {
            return None;
        }
        Some(Sab { base: p as *mut u8, len: SAB_LEN.load(Ordering::Acquire) })
    }

    fn slot(&self, i: usize) -> *mut u8 {
        unsafe { self.base.add(HEADER_SIZE + i * SLOT_SIZE) }
    }
    fn write_u32(&self, off: usize, v: u32) {
        unsafe { ptr::write_volatile(self.base.add(off) as *mut u32, v.to_le()) }
    }
    fn slot_u32(&self, s: *mut u8, off: usize, v: u32) {
        unsafe { ptr::write_volatile(s.add(off) as *mut u32, v.to_le()) }
    }
    fn slot_f32(&self, s: *mut u8, off: usize, v: f32) {
        unsafe { ptr::write_volatile(s.add(off) as *mut f32, v) }
    }
    fn bump_seq(&self) {
        unsafe {
            let p = self.base.add(OFF_SEQUENCE) as *mut u32;
            let v = ptr::read_volatile(p).wrapping_add(1);
            ptr::write_volatile(p, v);
        }
    }
    fn set_connected_mask(&self, v: u32) {
        self.write_u32(OFF_CONNECTED_MASK, v);
    }
}

fn worker_main(cmd_rx: std::sync::mpsc::Receiver<Cmd>, slots_mirror: &'static Mutex<HashMap<u32, gilrs::GamepadId>>, stop: Arc_<AtomicBool>) {
    let mut supported = true;
    let mut gilrs = match Gilrs::new() {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[downdraft_gamepad] Gilrs::new failed: {e}");
            // Error::NotImplemented carries a partially-working Gilrs whose
            // event notifier never fires — next_event_blocking returns
            // immediately and would hot-loop. Park on a slow sleep instead;
            // no events can ever arrive on such platforms.
            match e {
                gilrs::Error::NotImplemented(g) => {
                    supported = false;
                    g
                }
                _ => return,
            }
        }
    };

    let started = Instant::now();
    let mut slot_of: HashMap<gilrs::GamepadId, u32> = HashMap::new();
    let mut free_slots: Vec<u32> = (0..MAX_SLOTS as u32).rev().collect();
    let mut deadzone_radius = 0.10f32;
    let mut last_power_poll = Instant::now() - Duration::from_secs(60);
    let mut seqs = [0u32; MAX_SLOTS];
    let mut battery_cache = [255u8; MAX_SLOTS]; // power_info is sysfs IO — polled at 1Hz
    let mut charging_cache = [false; MAX_SLOTS];

    // Assign slots to already-connected pads.
    for (id, _gp) in gilrs.gamepads() {
        if let Some(s) = free_slots.pop() {
            slot_of.insert(id, s);
            slots_mirror.lock().unwrap().insert(s, id);
        }
    }

    while !stop.load(Ordering::Relaxed) {
        // Drain commands first so rumble/remap respond immediately.
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Cmd::Rumble { slot, weak, strong, ms } => {
                    if let Some(&id) = slots_mirror.lock().unwrap().get(&slot) {
                        let _ = EffectBuilder::new()
                            .add_effect(BaseEffect {
                                kind: BaseEffectType::Strong { magnitude: strong },
                                scheduling: Replay {
                                    after: Ticks::from_ms(0),
                                    play_for: Ticks::from_ms(ms),
                                    with_delay: Ticks::from_ms(0),
                                },
                                envelope: Default::default(),
                            })
                            .add_effect(BaseEffect {
                                kind: BaseEffectType::Weak { magnitude: weak },
                                scheduling: Replay {
                                    after: Ticks::from_ms(0),
                                    play_for: Ticks::from_ms(ms),
                                    with_delay: Ticks::from_ms(0),
                                },
                                envelope: Default::default(),
                            })
                            .add_gamepad(&gilrs.gamepad(id))
                            .finish(&mut gilrs)
                            .map(|e| e.play());
                    }
                }
                Cmd::SetDeadzone { radius } => deadzone_radius = radius.clamp(0.0, 0.9),
                Cmd::Rescan => {
                    // gilrs tracks hotplug internally; a rescan re-snapshots
                    // slot assignment for devices missed during init.
                    for (id, _gp) in gilrs.gamepads() {
                        if !slot_of.contains_key(&id) {
                            if let Some(s) = free_slots.pop() {
                                slot_of.insert(id, s);
                                slots_mirror.lock().unwrap().insert(s, id);
                            }
                        }
                    }
                }
                Cmd::Shutdown => stop.store(true, Ordering::Relaxed),
            }
        }

        // Block up to ~4ms for the next event, then snapshot everything.
        // Blocking on gilrs' notifier (inotify on Linux) means hotplug wakes
        // us immediately rather than on the next poll tick. Unsupported
        // backends have no notifier at all — a slow sleep keeps the command
        // channel and SAB snapshot live without pegging a core.
        if !supported {
            std::thread::sleep(Duration::from_millis(200));
        } else {
        match gilrs.next_event_blocking(Some(Duration::from_millis(4))) {
            Some(ev) => {
                gilrs.update(&ev); // keep cached state current
                match ev.event {
                    EventType::Connected => {
                        if !slot_of.contains_key(&ev.id) {
                            if let Some(s) = free_slots.pop() {
                                slot_of.insert(ev.id, s);
                                slots_mirror.lock().unwrap().insert(s, ev.id);
                            }
                        }
                    }
                    EventType::Disconnected => {
                        if let Some(s) = slot_of.remove(&ev.id) {
                            slots_mirror.lock().unwrap().remove(&s);
                            free_slots.push(s);
                            battery_cache[s as usize] = 255;
                            charging_cache[s as usize] = false;
                            if let Some(sab) = Sab::get() {
                                let sp = sab.slot(s as usize);
                                sab.slot_u32(sp, SLOT_META0, 0);
                                // Zero mutable fields so stale state doesn't linger.
                                for i in 0..8 {
                                    sab.slot_f32(sp, SLOT_AXES + i * 4, 0.0);
                                }
                                sab.slot_u32(sp, SLOT_BUTTONS_LO, 0);
                                sab.slot_u32(sp, SLOT_BUTTONS_HI, 0);
                                seqs[s as usize] = seqs[s as usize].wrapping_add(1);
                                sab.slot_u32(sp, SLOT_SLOT_SEQ, seqs[s as usize]);
                            }
                        }
                    }
                    _ => {}
                }
                // Drain any coalesced events in the same wake.
                while let Some(ev) = gilrs.next_event() {
                    gilrs.update(&ev);
                }
            }
            None => {}
        }
        }

        let Some(sab) = Sab::get() else { continue };
        let now_ms = started.elapsed().as_millis() as u32;
        let poll_power = last_power_poll.elapsed() >= Duration::from_secs(1);
        if poll_power {
            last_power_poll = Instant::now();
        }

        let mut connected_mask = 0u32;
        for (id, gp) in gilrs.gamepads() {
            let Some(&slot) = slot_of.get(&id) else { continue };
            let s = sab.slot(slot as usize);
            connected_mask |= 1 << slot;

            let uuid = gp.uuid();
            let vendor = gp.vendor_id().unwrap_or(0) as u32;
            let product = gp.product_id().unwrap_or(0) as u32;
            let name = gp.name();

            // Buttons → standard bitmask.
            let mut lo = 0u32;
            for b in [
                Button::South, Button::East, Button::West, Button::North,
                Button::LeftTrigger, Button::RightTrigger,
                Button::LeftTrigger2, Button::RightTrigger2,
                Button::Select, Button::Start, Button::Mode,
                Button::LeftThumb, Button::RightThumb,
                Button::DPadUp, Button::DPadDown, Button::DPadLeft, Button::DPadRight,
                Button::C, Button::Z,
            ] {
                if gp.is_pressed(b) {
                    if let Some(bit) = map_button(b) {
                        lo |= 1 << bit;
                    }
                }
            }

            // Axes — sticks -1..1, triggers remapped to 0..1, dpad derived
            // from buttons when the driver doesn't expose hat axes.
            let mut axes = [0f32; 8];
            for (i, a) in AXIS_IX.iter().enumerate() {
                axes[i] = gp.value(*a);
            }
            axes[4] = trigger(axes[4]);
            axes[5] = trigger(axes[5]);
            let (lx, ly) = deadzone_pair(axes[0], axes[1], deadzone_radius);
            let (rx, ry) = deadzone_pair(axes[2], axes[3], deadzone_radius);
            axes[0] = lx; axes[1] = ly; axes[2] = rx; axes[3] = ry;
            if axes[6] == 0.0 && axes[7] == 0.0 {
                axes[6] = ((lo >> 16 & 1) as i32 - (lo >> 15 & 1) as i32) as f32;
                axes[7] = ((lo >> 14 & 1) as i32 - (lo >> 13 & 1) as i32) as f32;
            }

            let mut flags = if gp.is_ff_supported() { FLAG_FF } else { 0 };
            if poll_power {
                match gp.power_info() {
                    gilrs::PowerInfo::Wired => battery_cache[slot as usize] = 254,
                    gilrs::PowerInfo::Charged => battery_cache[slot as usize] = 100,
                    gilrs::PowerInfo::Charging(l) => {
                        battery_cache[slot as usize] = l.min(100);
                        charging_cache[slot as usize] = true;
                    }
                    gilrs::PowerInfo::Discharging(l) => {
                        battery_cache[slot as usize] = l.min(100);
                        charging_cache[slot as usize] = false;
                    }
                    gilrs::PowerInfo::Unknown => battery_cache[slot as usize] = 255,
                }
            }
            if charging_cache[slot as usize] {
                flags |= FLAG_CHARGING;
            }
            let battery = battery_cache[slot as usize];

            // meta0 = connected | padType<<8 | connType<<16 | battery<<24.
            let meta0 = 1u32
                | ((classify(name, gp.vendor_id(), gp.product_id()) as u32) << 8)
                | ((classify_conn(&uuid, gp.vendor_id(), gp.product_id()) as u32) << 16)
                | ((battery as u32) << 24);
            sab.slot_u32(s, SLOT_META0, meta0);
            sab.slot_u32(s, SLOT_META1, flags as u32);
            sab.slot_u32(s, SLOT_BUTTONS_LO, lo);
            sab.slot_u32(s, SLOT_BUTTONS_HI, 0);
            for (i, v) in axes.iter().enumerate() {
                sab.slot_f32(s, SLOT_AXES + i * 4, *v);
            }
            sab.slot_u32(s, SLOT_LAST_EVENT_MS, now_ms);
            seqs[slot as usize] = seqs[slot as usize].wrapping_add(1);
            sab.slot_u32(s, SLOT_SLOT_SEQ, seqs[slot as usize]);
            sab.slot_u32(s, SLOT_VENDOR, vendor);
            sab.slot_u32(s, SLOT_PRODUCT, product);
            let name_bytes = name.as_bytes();
            let n = name_bytes.len().min(SLOT_NAME_LEN - 1);
            unsafe {
                ptr::write_bytes(s.add(SLOT_NAME), 0, SLOT_NAME_LEN);
                ptr::copy_nonoverlapping(name_bytes.as_ptr(), s.add(SLOT_NAME), n);
            }
            // Linux: expose the /dev/input/eventN index so JS sysfs
            // enrichment can correlate without fuzzy name matching.
            #[cfg(target_os = "linux")]
            {
                let event_node = {
                    use gilrs::LinuxGamepadExt;
                    gp.devpath()
                        .file_name()
                        .and_then(|f| f.to_str())
                        .and_then(|f| f.strip_prefix("event"))
                        .and_then(|f| f.parse::<u32>().ok())
                        .unwrap_or(0xffff)
                };
                sab.slot_u32(s, SLOT_AUX, event_node);
            }
            #[cfg(not(target_os = "linux"))]
            sab.slot_u32(s, SLOT_AUX, 0xffff);
        }
        sab.set_connected_mask(connected_mask);
        sab.bump_seq();
    }
}

// ── FFI exports ─────────────────────────────────────────────────────────────

/// Start the gamepad worker. Idempotent — a live backend returns 0.
/// Returns 1 on spawn failure, 0 on success.
#[no_mangle]
pub extern "C" fn dd_pad_init() -> c_int {
    let mut guard = match BACKEND.lock() {
        Ok(g) => g,
        Err(_) => return 1,
    };
    if guard.is_some() {
        return 0;
    }
    let (tx, rx) = channel::<Cmd>();
    let stop = Arc_::new(AtomicBool::new(false));
    let stop2 = stop.clone();

    // Slots mirror lives for the whole backend lifetime; leak it so the
    // worker can hold a 'static reference without lifetime plumbing.
    let mirror: &'static Mutex<HashMap<u32, gilrs::GamepadId>> =
        Box::leak(Box::new(Mutex::new(HashMap::new())));

    let join = std::thread::Builder::new()
        .name("dd-gamepad".into())
        .spawn(move || worker_main(rx, mirror, stop2));
    match join {
        Ok(j) => {
            *guard = Some(Backend {
                cmd_tx: tx,
                stop,
                join: Some(j),
            });
            0
        }
        Err(_) => 1,
    }
}

/// Attach a JS-allocated SharedArrayBuffer for the worker to write into.
/// The caller must write the channel header (magic/version/maxSlots/slotSize)
/// BEFORE calling attach — the worker validates it and refuses mismatches.
/// ptr is a bun:ffi/koffi-style pointer (integer address).
#[no_mangle]
pub extern "C" fn dd_pad_attach_sab(ptr: usize, len: usize) -> c_int {
    if ptr == 0 || len < HEADER_SIZE + MAX_SLOTS * SLOT_SIZE {
        return 1;
    }
    let magic = unsafe { ptr::read_volatile(ptr as *const u32) };
    let version = unsafe { ptr::read_volatile((ptr + 4) as *const u32) };
    if magic != MAGIC.to_le() as u32 || version != VERSION.to_le() as u32 {
        return 2;
    }
    SAB_LEN.store(len, Ordering::Release);
    SAB_PTR.store(ptr, Ordering::Release);
    0
}

/// Detach the current SAB (e.g. before freeing it). The worker keeps running
/// and accepts a later re-attach.
#[no_mangle]
pub extern "C" fn dd_pad_detach_sab() {
    SAB_PTR.store(0, Ordering::Release);
    SAB_LEN.store(0, Ordering::Release);
}

/// Rumble a pad by slot. `weak`/`strong` are motor magnitudes 0..=u16::MAX,
/// `ms` is duration. Returns 0 when the command was queued.
#[no_mangle]
pub extern "C" fn dd_pad_rumble(slot: u32, weak: u16, strong: u16, ms: u32) -> c_int {
    let guard = match BACKEND.lock() {
        Ok(g) => g,
        Err(_) => return 1,
    };
    match guard.as_ref() {
        Some(b) => match b.cmd_tx.send(Cmd::Rumble { slot, weak, strong, ms }) {
            Ok(()) => 0,
            Err(_) => 2,
        },
        None => 3,
    }
}

/// Set the circular deadzone radius applied to both sticks (0..0.9).
#[no_mangle]
pub extern "C" fn dd_pad_set_deadzone(radius: f32) -> c_int {
    let guard = match BACKEND.lock() {
        Ok(g) => g,
        Err(_) => return 1,
    };
    match guard.as_ref() {
        Some(b) => match b.cmd_tx.send(Cmd::SetDeadzone { radius }) {
            Ok(()) => 0,
            Err(_) => 2,
        },
        None => 3,
    }
}

/// Force a re-scan of connected devices (sleep/wake, missed hotplug).
#[no_mangle]
pub extern "C" fn dd_pad_rescan() -> c_int {
    let guard = match BACKEND.lock() {
        Ok(g) => g,
        Err(_) => return 1,
    };
    match guard.as_ref() {
        Some(b) => match b.cmd_tx.send(Cmd::Rescan) {
            Ok(()) => 0,
            Err(_) => 2,
        },
        None => 3,
    }
}

/// Stop the worker thread and release the backend. Idempotent.
#[no_mangle]
pub extern "C" fn dd_pad_destroy() -> c_int {
    let mut guard = match BACKEND.lock() {
        Ok(g) => g,
        Err(_) => return 1,
    };
    let Some(mut b) = guard.take() else {
        SAB_PTR.store(0, Ordering::Release);
        return 0;
    };
    b.stop.store(true, Ordering::Relaxed);
    let _ = b.cmd_tx.send(Cmd::Shutdown);
    SAB_PTR.store(0, Ordering::Release);
    if let Some(j) = b.join.take() {
        let _ = j.join();
    }
    0
}
