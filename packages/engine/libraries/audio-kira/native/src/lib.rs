mod engine;
mod source;
mod mixer;

use std::os::raw::{c_int, c_float};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use engine::AudioEngine;

static AUDIO_STATE: Mutex<Option<AudioEngine>> = Mutex::new(None);

/// Run an FFI body with panic isolation — a Rust panic must never unwind
/// across the FFI boundary. Returns -2 on panic.
fn ffi<F>(f: F) -> c_int
where
    F: FnOnce() -> c_int,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(-2)
}

#[no_mangle]
pub extern "C" fn dd_audio_init(sample_rate: c_int, _buffer_size: c_int) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        if state.is_some() {
            return 0;
        }
        match AudioEngine::new(sample_rate as u32) {
            Ok(s) => {
                *state = Some(s);
                0
            }
            Err(_) => -1,
        }
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_destroy() -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        *state = None;
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_load_buffer(
    data_ptr: *const u8,
    data_len: usize,
    format: c_int,
) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };

        if data_ptr.is_null() || data_len == 0 {
            return -1;
        }

        let data = unsafe {
            std::slice::from_raw_parts(data_ptr, data_len)
        };

        source::load_buffer(state, data, format)
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_unload_buffer(buffer_id: c_int) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        state.buffers.remove(&(buffer_id as u32));
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_play(
    buffer_id: c_int,
    loop_sound: c_int,
    volume: c_float,
) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        source::play(state, buffer_id, loop_sound, volume)
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_stop(sound_id: c_int) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        source::stop(state, sound_id);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_pause(sound_id: c_int) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        source::pause(state, sound_id);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_resume(sound_id: c_int) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        source::resume(state, sound_id);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_set_volume(sound_id: c_int, volume: c_float) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        source::set_volume(state, sound_id, volume);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_set_master_volume(volume: c_float) -> c_int {
    ffi(|| {
        let mut state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_mut() {
            Some(s) => s,
            None => return -1,
        };
        mixer::set_master_volume(state, volume);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_audio_update() -> c_int {
    ffi(|| 0)
}

#[no_mangle]
pub extern "C" fn dd_audio_is_playing(sound_id: c_int) -> c_int {
    ffi(|| {
        let state = AUDIO_STATE.lock().unwrap();
        let state = match state.as_ref() {
            Some(s) => s,
            None => return -1,
        };
        if source::is_playing(state, sound_id) {
            1
        } else {
            0
        }
    })
}
