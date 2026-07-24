use std::collections::HashMap;
use kira::manager::AudioManager;
use kira::manager::backend::cpal::CpalBackend;
use kira::sound::static_sound::StaticSoundHandle;

pub struct AudioEngine {
    pub manager: AudioManager,
    pub sounds: HashMap<u32, StaticSoundHandle>,
    pub buffers: HashMap<u32, kira::sound::static_sound::StaticSoundData>,
    pub next_buffer_id: u32,
    pub next_sound_id: u32,
    pub master_volume: f64,
}

impl AudioEngine {
    pub fn new(sample_rate: u32) -> Result<Self, Box<dyn std::error::Error>> {
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
