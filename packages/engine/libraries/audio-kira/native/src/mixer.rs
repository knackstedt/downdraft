use kira::Tween;
use crate::engine::{amp_to_db, AudioEngine};

pub fn set_master_volume(engine: &mut AudioEngine, volume: f32) {
    engine.master_volume = volume as f64;
    engine.manager.main_track().set_volume(
        amp_to_db(volume),
        Tween::default(),
    );
}
