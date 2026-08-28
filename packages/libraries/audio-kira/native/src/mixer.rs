use kira::tween::Tween;
use kira::Volume;
use crate::engine::AudioEngine;

pub fn set_master_volume(engine: &mut AudioEngine, volume: f32) {
    engine.master_volume = volume as f64;
    let _ = engine.manager.set_master_volume(Volume::Amplitude(volume as f64), Tween::default());
}

pub fn set_channel_volume(engine: &mut AudioEngine, sound_id: i32, volume: f32) {
    if let Some(handle) = engine.sounds.get_mut(&(sound_id as u32)) {
        let _ = handle.set_volume(Volume::Amplitude(volume as f64), Tween::default());
    }
}

pub fn get_master_volume(engine: &AudioEngine) -> f64 {
    engine.master_volume
}
