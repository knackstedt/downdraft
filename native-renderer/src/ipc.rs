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
/// Total: 544 bytes

pub const SHM_SIZE: usize = 544;
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

    /// Read command from Bun (seqlock read)
    pub fn read_command(&self) -> Option<(CommandType, Vec<u8>)> {
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
                    return Some((cmd, payload));
                }
                return None;
            }
        }
        None
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
