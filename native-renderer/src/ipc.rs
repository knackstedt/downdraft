use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::path::PathBuf;

/// Shared memory layout:
/// [0..4]    seqlock counter (u32, atomically updated)
/// [4..8]    command type (u32, written by Bun)
/// [8..12]   command payload size (u32, written by Bun)
/// [12..524] command payload (512 bytes, written by Bun)
/// [524..528] telemetry seqlock (u32, written by Rust)
/// [528..532] fps (u32, written by Rust)
/// [532..536] frame time us (u32, written by Rust)
/// [536..540] entity count (u32, written by Rust)
/// [540..544] renderer status (u32, written by Rust)
/// [544..548] render data seqlock (u32, written by Bun)
/// [548..552] render entity count (u32, written by Bun)
/// [552..564] camera position (3 × f32, written by Bun)
/// [564..576] camera target (3 × f32, written by Bun)
/// [576..2368] entity array (64 × 28 bytes, written by Bun)
/// Total: 4096 bytes

pub const SHM_SIZE: usize = 4096;
pub const CMD_SEQ_OFFSET: usize = 0;
pub const CMD_TYPE_OFFSET: usize = 4;
pub const CMD_SIZE_OFFSET: usize = 8;
pub const CMD_PAYLOAD_OFFSET: usize = 12;
pub const CMD_PAYLOAD_SIZE: usize = 512;
pub const TLM_SEQ_OFFSET: usize = 524;
pub const TLM_FPS_OFFSET: usize = 528;
pub const TLM_FRAME_TIME_OFFSET: usize = 532;
pub const TLM_ENTITY_COUNT_OFFSET: usize = 536;
pub const TLM_STATUS_OFFSET: usize = 540;

// Render data section (written by Bun, read by Rust)
pub const RENDER_SEQ_OFFSET: usize = 544;
pub const RENDER_ENTITY_COUNT_OFFSET: usize = 548;
pub const RENDER_CAM_POS_OFFSET: usize = 552;
pub const RENDER_CAM_TARGET_OFFSET: usize = 564;
pub const RENDER_ENTITIES_OFFSET: usize = 576;
pub const RENDER_MAX_ENTITIES: usize = 96;
pub const RENDER_ENTITY_STRIDE: usize = 28; // type(4) + pos(12) + color(12)

// Input section (written by Rust renderer, read by Bun)
pub const INPUT_OFFSET: usize = 3264;        // held_keys: u32 bitfield
pub const INPUT_PRESSED_OFFSET: usize = 3268; // pressed_keys: u32 bitfield (one-shot)

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RenderEntityType {
    Player = 0,
    Ship = 1,
    Shark = 2,
    Fish = 3,
    Debris = 4,
    Water = 5,
    Island = 6,
    Buildable = 7,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RenderEntity {
    pub entity_type: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

#[derive(Clone, Debug)]
pub struct RenderData {
    pub camera_pos: [f32; 3],
    pub camera_target: [f32; 3],
    pub entities: Vec<RenderEntity>,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CommandType {
    None = 0,
    LoadScene = 1,
    SetTimeScale = 2,
    Pause = 3,
    Resume = 4,
    Resize = 5,
    Quit = 6,
}

pub struct SharedMemory {
    _file: std::fs::File,
    mmap: MmapMut,
    pub path: PathBuf,
}

impl SharedMemory {
    pub fn create() -> std::io::Result<Self> {
        let path = Self::get_shm_path();

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)?;

        file.set_len(SHM_SIZE as u64)?;

        let mmap = unsafe { MmapMut::map_mut(&file)? };

        let mut shm = Self { _file: file, mmap, path };
        shm.init();
        Ok(shm)
    }

    fn get_shm_path() -> PathBuf {
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        dir.join(format!("downdraft-shm-{}", pid))
    }

    fn init(&mut self) {
        let ptr = self.mmap.as_mut_ptr();
        unsafe {
            std::ptr::write_bytes(ptr, 0, SHM_SIZE);
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.mmap[..]
    }

    fn as_bytes_mut(&mut self) -> &mut [u8] {
        &mut self.mmap[..]
    }

    /// Get a reference to the underlying bytes (for input writing)
    pub fn as_ref(&self) -> &[u8] {
        &self.mmap[..]
    }

    /// Get a mutable reference to the underlying bytes (for input writing)
    pub fn as_mut(&mut self) -> &mut [u8] {
        &mut self.mmap[..]
    }

    /// Read command from Bun (seqlock read) — clears command after reading
    pub fn read_command(&mut self) -> Option<(CommandType, Vec<u8>)> {
        let bytes = self.as_bytes();
        let seq_arr = unsafe {
            &*(bytes.as_ptr().add(CMD_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        for _ in 0..8 {
            let s1 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
            if s1 & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }

            let cmd_type = u32::from_le_bytes(
                bytes[CMD_TYPE_OFFSET..CMD_TYPE_OFFSET + 4].try_into().unwrap()
            );
            let cmd_size = u32::from_le_bytes(
                bytes[CMD_SIZE_OFFSET..CMD_SIZE_OFFSET + 4].try_into().unwrap()
            ) as usize;

            let payload = if cmd_size > 0 && cmd_size <= CMD_PAYLOAD_SIZE {
                bytes[CMD_PAYLOAD_OFFSET..CMD_PAYLOAD_OFFSET + cmd_size].to_vec()
            } else {
                Vec::new()
            };

            let s2 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
            if s1 == s2 && s2 & 1 == 0 {
                let cmd = match cmd_type {
                    1 => CommandType::LoadScene,
                    2 => CommandType::SetTimeScale,
                    3 => CommandType::Pause,
                    4 => CommandType::Resume,
                    5 => CommandType::Resize,
                    6 => CommandType::Quit,
                    _ => CommandType::None,
                };
                if cmd != CommandType::None {
                    // Clear the command type so we don't re-read it next frame
                    let bytes_mut = self.as_bytes_mut();
                    let cmd_type_ptr = &mut bytes_mut[CMD_TYPE_OFFSET..CMD_TYPE_OFFSET + 4];
                    cmd_type_ptr.copy_from_slice(&0u32.to_le_bytes());
                    return Some((cmd, payload));
                }
                return None;
            }
        }
        None
    }

    /// Read render data from Bun (seqlock read)
    pub fn read_render_data(&self) -> Option<RenderData> {
        let bytes = self.as_bytes();
        let seq_arr = unsafe {
            &*(bytes.as_ptr().add(RENDER_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        let s1 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 & 1 != 0 {
            return None;
        }

        let entity_count = u32::from_le_bytes(
            bytes[RENDER_ENTITY_COUNT_OFFSET..RENDER_ENTITY_COUNT_OFFSET + 4].try_into().unwrap()
        ).min(RENDER_MAX_ENTITIES as u32) as usize;

        let cam_pos = [
            f32::from_le_bytes(bytes[RENDER_CAM_POS_OFFSET..RENDER_CAM_POS_OFFSET + 4].try_into().unwrap()),
            f32::from_le_bytes(bytes[RENDER_CAM_POS_OFFSET + 4..RENDER_CAM_POS_OFFSET + 8].try_into().unwrap()),
            f32::from_le_bytes(bytes[RENDER_CAM_POS_OFFSET + 8..RENDER_CAM_POS_OFFSET + 12].try_into().unwrap()),
        ];

        let cam_target = [
            f32::from_le_bytes(bytes[RENDER_CAM_TARGET_OFFSET..RENDER_CAM_TARGET_OFFSET + 4].try_into().unwrap()),
            f32::from_le_bytes(bytes[RENDER_CAM_TARGET_OFFSET + 4..RENDER_CAM_TARGET_OFFSET + 8].try_into().unwrap()),
            f32::from_le_bytes(bytes[RENDER_CAM_TARGET_OFFSET + 8..RENDER_CAM_TARGET_OFFSET + 12].try_into().unwrap()),
        ];

        let mut entities = Vec::with_capacity(entity_count);
        for i in 0..entity_count {
            let off = RENDER_ENTITIES_OFFSET + i * RENDER_ENTITY_STRIDE;
            entities.push(RenderEntity {
                entity_type: u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()),
                x: f32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap()),
                y: f32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap()),
                z: f32::from_le_bytes(bytes[off + 12..off + 16].try_into().unwrap()),
                r: f32::from_le_bytes(bytes[off + 16..off + 20].try_into().unwrap()),
                g: f32::from_le_bytes(bytes[off + 20..off + 24].try_into().unwrap()),
                b: f32::from_le_bytes(bytes[off + 24..off + 28].try_into().unwrap()),
            });
        }

        let s2 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 != s2 || s2 & 1 != 0 {
            return None;
        }

        Some(RenderData {
            camera_pos: cam_pos,
            camera_target: cam_target,
            entities,
        })
    }

    /// Write telemetry (seqlock write)
    pub fn write_telemetry(&mut self, fps: u32, frame_time_us: u32, entity_count: u32, status: u32) {
        let bytes = self.as_bytes_mut();
        let seq_ptr = unsafe {
            &*(bytes.as_ptr().add(TLM_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        let seq = seq_ptr.load(std::sync::atomic::Ordering::Relaxed);
        seq_ptr.store(seq + 1, std::sync::atomic::Ordering::Release);

        bytes[TLM_FPS_OFFSET..TLM_FPS_OFFSET + 4]
            .copy_from_slice(&fps.to_le_bytes());
        bytes[TLM_FRAME_TIME_OFFSET..TLM_FRAME_TIME_OFFSET + 4]
            .copy_from_slice(&frame_time_us.to_le_bytes());
        bytes[TLM_ENTITY_COUNT_OFFSET..TLM_ENTITY_COUNT_OFFSET + 4]
            .copy_from_slice(&entity_count.to_le_bytes());
        bytes[TLM_STATUS_OFFSET..TLM_STATUS_OFFSET + 4]
            .copy_from_slice(&status.to_le_bytes());

        seq_ptr.store(seq + 2, std::sync::atomic::Ordering::Release);
    }

    pub fn print_path(&self) {
        use std::io::Write;
        print!("SHM_PATH:{}\n", self.path.display());
        std::io::stdout().flush().ok();
    }
}

impl Drop for SharedMemory {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
