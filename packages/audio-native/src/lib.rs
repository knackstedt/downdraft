use std::ffi::c_void;
use std::os::raw::{c_char, c_int, c_float};
use std::sync::Mutex;
use std::collections::HashMap;

use kira::manager::AudioManager;
use kira::manager::backend::cpal::CpalBackend;
use kira::sound::static_sound::{StaticSoundData, StaticSoundSettings};
use kira::track::TrackId;
use kira::tween::Tween;
use kira::Volume;

struct AudioState {
    manager: AudioManager,
    sounds: HashMap<u32, kira::sound::static_sound::StaticSoundHandle>,
    buffers: HashMap<u32, StaticSoundData>,
    next_buffer_id: u32,
    next_sound_id: u32,
    master_volume: f64,
}

impl AudioState {
    fn new(sample_rate: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let manager = AudioManager::new(CpalBackend::new()?)?;
        Ok(Self {
            manager,
            sounds: HashMap::new(),
            buffers: HashMap::new(),
            next_buffer_id: 1,
            next_sound_id: 1,
            master_volume: 1.0,
        })
    }
}

static AUDIO_STATE: Mutex<Option<AudioState>> = Mutex::new(None);

#[no_mangle]
pub extern "C" fn dd_audio_init(sample_rate: c_int, buffer_size: c_int) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    if state.is_some() {
        return 0;
    }
    match AudioState::new(sample_rate as u32) {
        Ok(s) => {
            *state = Some(s);
            0
        }
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_audio_destroy() -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    *state = None;
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_load_buffer(
    data_ptr: *const u8,
    data_len: usize,
    format: c_int,
) -> c_int {
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

    let sound_data = match format {
        0 => {
            // WAV
            match StaticSoundData::from_wav_bytes(data) {
                Ok(d) => d,
                Err(_) => return -1,
            }
        }
        _ => return -1,
    };

    let id = state.next_buffer_id;
    state.next_buffer_id += 1;
    state.buffers.insert(id, sound_data);
    id as c_int
}

#[no_mangle]
pub extern "C" fn dd_audio_unload_buffer(buffer_id: c_int) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    state.buffers.remove(&(buffer_id as u32));
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_play(
    buffer_id: c_int,
    loop_sound: c_int,
    volume: c_float,
) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };

    let buffer = match state.buffers.get(&(buffer_id as u32)) {
        Some(b) => b.clone(),
        None => return -1,
    };

    let settings = StaticSoundSettings::new()
        .loops(if loop_sound != 0 { u64::MAX } else { 0 })
        .volume(Volume::Amplitude(volume as f64));

    let sound_data = buffer.with_settings(settings);

    match state.manager.play(sound_data) {
        Ok(handle) => {
            let id = state.next_sound_id;
            state.next_sound_id += 1;
            state.sounds.insert(id, handle);
            id as c_int
        }
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_audio_stop(sound_id: c_int) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    if let Some(mut handle) = state.sounds.remove(&(sound_id as u32)) {
        let _ = handle.stop(Tween::default());
    }
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_pause(sound_id: c_int) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    if let Some(handle) = state.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.pause(Tween::default());
    }
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_resume(sound_id: c_int) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    if let Some(handle) = state.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.resume(Tween::default());
    }
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_set_volume(sound_id: c_int, volume: c_float) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    if let Some(handle) = state.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.set_volume(Volume::Amplitude(volume as f64), Tween::default());
    }
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_set_master_volume(volume: c_float) -> c_int {
    let mut state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_mut() {
        Some(s) => s,
        None => return -1,
    };
    state.master_volume = volume as f64;
    let _ = state.manager.set_master_volume(Volume::Amplitude(volume as f64), Tween::default());
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_update() -> c_int {
    0
}

#[no_mangle]
pub extern "C" fn dd_audio_is_playing(sound_id: c_int) -> c_int {
    let state = AUDIO_STATE.lock().unwrap();
    let state = match state.as_ref() {
        Some(s) => s,
        None => return -1,
    };
    if let Some(handle) = state.sounds.get(&(sound_id as u32)) {
        if handle.state() == kira::sound::static_sound::StaticSoundState::playing {
            return 1;
        }
    }
    0
}
