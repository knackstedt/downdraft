use kira::tween::Tween;
use kira::Volume;
use crate::engine::AudioEngine;

pub fn set_master_volume(engine: &mut AudioEngine, volume: f32) {
    engine.master_volume = volume as f64;
    let _ = engine.manager.main_track().set_volume(
        Volume::Amplitude(volume as f64),
        Tween::default(),
    );
}
