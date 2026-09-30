use std::collections::HashMap;
use kira::manager::{AudioManager, AudioManagerSettings};
use kira::manager::backend::DefaultBackend;
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle};

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
