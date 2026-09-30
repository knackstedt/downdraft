use std::io::Cursor;
use kira::sound::static_sound::{StaticSoundData, StaticSoundSettings};
use kira::sound::PlaybackState;
use kira::tween::Tween;
use kira::Volume;
use crate::engine::AudioEngine;

// `format` is retained for FFI stability — kira's symphonia probe
// auto-detects the container (wav/ogg/mp3/flac) from the bytes.
pub fn load_buffer(engine: &mut AudioEngine, data: &[u8], _format: i32) -> i32 {
    let sound_data = match StaticSoundData::from_cursor(Cursor::new(data.to_vec())) {
        Ok(d) => d,
        Err(_) => return -1,
    };

    let id = engine.next_buffer_id;
    engine.next_buffer_id += 1;
    engine.buffers.insert(id, sound_data);
    id as i32
}

pub fn play(engine: &mut AudioEngine, buffer_id: i32, loop_sound: i32, volume: f32) -> i32 {
    let buffer = match engine.buffers.get(&(buffer_id as u32)) {
        Some(b) => b.clone(),
        None => return -1,
    };

    let mut settings = StaticSoundSettings::new()
        .volume(Volume::Amplitude(volume as f64));
    if loop_sound != 0 {
        // `..` = the whole sound, looped indefinitely.
        settings = settings.loop_region(..);
    }

    let sound_data = buffer.with_settings(settings);

    match engine.manager.play(sound_data) {
        Ok(handle) => {
            let id = engine.next_sound_id;
            engine.next_sound_id += 1;
            engine.sounds.insert(id, handle);
            id as i32
        }
        Err(_) => -1,
    }
}

pub fn stop(engine: &mut AudioEngine, sound_id: i32) {
    if let Some(mut handle) = engine.sounds.remove(&(sound_id as u32)) {
        let _ = handle.stop(Tween::default());
    }
}

pub fn pause(engine: &mut AudioEngine, sound_id: i32) {
    if let Some(handle) = engine.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.pause(Tween::default());
    }
}

pub fn resume(engine: &mut AudioEngine, sound_id: i32) {
    if let Some(handle) = engine.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.resume(Tween::default());
    }
}

pub fn set_volume(engine: &mut AudioEngine, sound_id: i32, volume: f32) {
    if let Some(handle) = engine.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.set_volume(Volume::Amplitude(volume as f64), Tween::default());
    }
}

pub fn is_playing(engine: &AudioEngine, sound_id: i32) -> bool {
    if let Some(handle) = engine.sounds.get(&(sound_id as u32)) {
        return matches!(
            handle.state(),
            PlaybackState::Playing | PlaybackState::Pausing | PlaybackState::Stopping,
        );
    }
    false
}
