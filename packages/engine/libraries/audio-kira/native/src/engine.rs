use std::collections::HashMap;
use kira::{AudioManager, AudioManagerSettings, DefaultBackend, Decibels};
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle};

/// The FFI volume contract is a linear amplitude multiplier (1.0 = unity).
/// kira 0.10+ measures volume in decibels — convert here so callers keep
/// the amplitude semantics.
pub fn amp_to_db(amp: f32) -> Decibels {
    if amp <= 0.0 {
        return Decibels::SILENCE;
    }
    Decibels(20.0 * amp.log10())
}

pub struct AudioEngine {
    pub manager: AudioManager<DefaultBackend>,
    pub sounds: HashMap<u32, StaticSoundHandle>,
    pub buffers: HashMap<u32, StaticSoundData>,
    pub next_buffer_id: u32,
    pub next_sound_id: u32,
    pub master_volume: f64,
}

impl AudioEngine {
    pub fn new(_sample_rate: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let manager = AudioManager::<DefaultBackend>::new(AudioManagerSettings::default())?;
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
