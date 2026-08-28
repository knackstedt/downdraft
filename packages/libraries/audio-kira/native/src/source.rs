use kira::sound::static_sound::{StaticSoundData, StaticSoundSettings};
use kira::tween::Tween;
use kira::Volume;
use crate::engine::AudioEngine;

pub fn load_buffer(engine: &mut AudioEngine, data: &[u8], format: i32) -> i32 {
    let sound_data = match format {
        0 => match StaticSoundData::from_wav_bytes(data) {
            Ok(d) => d,
            Err(_) => return -1,
        },
        1 => match decode_with_symphonia(data, "ogg") {
            Some(d) => d,
            None => return -1,
        },
        2 => match decode_with_symphonia(data, "mp3") {
            Some(d) => d,
            None => return -1,
        },
        3 => match decode_with_symphonia(data, "flac") {
            Some(d) => d,
            None => return -1,
        },
        _ => return -1,
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

    let settings = StaticSoundSettings::new()
        .loops(if loop_sound != 0 { u64::MAX } else { 0 })
        .volume(Volume::Amplitude(volume as f64));

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
        return handle.state() == kira::sound::static_sound::StaticSoundState::playing;
    }
    false
}

fn decode_with_symphonia(data: &[u8], format_hint: &str) -> Option<StaticSoundData> {
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::audio::SignalSpec;

    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(data.to_vec())), Default::default());

    let prober = symphonia::default::get_probe();
    let format_reader = match prober.format(
        &symphonia::core::probe::Hint::new().with_extension(format_hint),
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(r) => r,
        Err(_) => return None,
    };

    let track = format_reader.tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .cloned()?;

    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels
        .map(|ch| ch.count())
        .unwrap_or(2);
    let channels = if channels >= 2 { 2 } else { 1 };

    let mut samples: Vec<f32> = Vec::new();
    let mut format_reader = format_reader;
    let mut decoder = decoder;

    let track_id = track.id;

    loop {
        let packet = match format_reader.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let mut decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let num_frames = decoded.frames();
        let num_channels = decoded.spec().channels.count();

        let mut buf = vec![0f32; num_channels * num_frames];
        if decoded.read_interleaved_f32(&mut buf).is_ok() {
            samples.extend_from_slice(&buf);
        } else {
            for frame in 0..num_frames {
                for ch in 0..num_channels {
                    samples.push(decoded.read_sample_f32(frame, ch).unwrap_or(0.0));
                }
            }
        }
    }

    let static_data = StaticSoundData::from_samples(
        &samples,
        kira::sound::static_sound::SampleRateSetting::Resample(sample_rate),
        kira::sound::static_sound::ChannelMapping::new(channels),
    );

    Some(static_data)
}
