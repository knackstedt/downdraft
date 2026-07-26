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
/// Total: 4MB (expanded for mesh data)

pub const SHM_SIZE: usize = 256 * 1024 * 1024; // 256MB — mesh data needs ~120MB for 6 islands at 10x resolution
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
pub const INPUT_MOUSE_DX_OFFSET: usize = 3272;  // mouse delta X (f32)
pub const INPUT_MOUSE_DY_OFFSET: usize = 3276;  // mouse delta Y (f32)
pub const INPUT_WHEEL_OFFSET: usize = 3280;     // mouse wheel delta (f32)
pub const INPUT_EXT_OFFSET: usize = 3284;        // held_keys_ext: u32 bitfield (numpad etc.)
pub const INPUT_PRESSED_EXT_OFFSET: usize = 3288; // pressed_keys_ext: u32 bitfield (one-shot)

// Weather visual data (written by Bun each tick, read by Rust renderer)
pub const WEATHER_SEQ_OFFSET: usize = 3292;          // seqlock (u32)
pub const WEATHER_SKY_COLOR_OFFSET: usize = 3296;    // 3 × f32 (rgb)
pub const WEATHER_WATER_COLOR_OFFSET: usize = 3308;  // 3 × f32 (rgb)
pub const WEATHER_FOG_COLOR_OFFSET: usize = 3320;    // 3 × f32 (rgb)
pub const WEATHER_FOG_DENSITY_OFFSET: usize = 3332;  // f32
pub const WEATHER_LIGHT_INTENSITY_OFFSET: usize = 3336; // f32
pub const WEATHER_TYPE_OFFSET: usize = 3340;            // u32 (WeatherType enum value)
pub const WEATHER_IS_NIGHT_OFFSET: usize = 3344;        // u32 (0 or 1)

// Mesh data section (written by Bun once at init, read by Rust once)
pub const MESH_SEQ_OFFSET: usize = 3348;       // seqlock (u32)
pub const MESH_COUNT_OFFSET: usize = 3352;     // number of meshes (u32)
pub const MESH_DATA_OFFSET: usize = 3356;      // mesh data starts here
// Mesh data format per mesh:
//   vertex_count: u32
//   index_count: u32
//   pos_x: f32, pos_z: f32 (island world position for model matrix)
//   lod_level: u32, lod_distance: f32 (LOD level and switch distance)
//   vertices: vertex_count * 9 f32 (pos.xyz, normal.xyz, color.rgb)
//   indices: index_count * u32

// Water data section (written by Bun each tick, read by Rust renderer)
// Chunk-based: up to 25 chunks, each 644x644 f32 heights + header (10x resolution)
pub const WATER_MAX_CHUNKS: usize = 25;
pub const WATER_CHUNK_GRID: usize = 68; // CHUNK_SIZE + 2*CHUNK_OVERLAP
pub const WATER_SEQ_OFFSET: usize = 134217728;           // seqlock (u32) — 128MB
pub const WATER_CHUNK_COUNT_OFFSET: usize = 134217732;   // chunk count (u32)
pub const WATER_PATCH_SIZE_OFFSET: usize = 134217736;    // patch size (f32)
pub const WATER_CHUNK_DATA_OFFSET: usize = 134217740;    // first chunk starts here
pub const WATER_CHUNK_HEADER_SIZE: usize = 12;          // originX(i32) + originZ(i32) + grid_size(u32)
pub const WATER_CHUNK_HEIGHTS_SIZE: usize = WATER_CHUNK_GRID * WATER_CHUNK_GRID * 4; // 18496
pub const WATER_CHUNK_STRIDE: usize = WATER_CHUNK_HEADER_SIZE + WATER_CHUNK_HEIGHTS_SIZE; // 18508
pub const WATER_DATA_END: usize = WATER_CHUNK_DATA_OFFSET + WATER_MAX_CHUNKS * WATER_CHUNK_STRIDE; // 134681940

// Game state section (written by Bun each tick, read by Rust renderer)
pub const GAME_STATE_OFFSET: usize = WATER_DATA_END;             // is_dead: u32 (0 or 1)
pub const GAME_STATE_CAUSE_OFFSET: usize = WATER_DATA_END + 4;   // cause: [u8; 64]
pub const GAME_STATE_CAUSE_SIZE: usize = 64;

// Respawn request (written by Rust renderer, read by Bun)
pub const RESPAWN_REQUEST_OFFSET: usize = WATER_DATA_END + 68;   // respawn_requested: u32 (0 or 1)

// Inventory data section (written by Bun each tick, read by Rust renderer)
pub const INVENTORY_SEQ_OFFSET: usize = WATER_DATA_END + 72;       // seqlock (u32)
pub const INVENTORY_DATA_OFFSET: usize = WATER_DATA_END + 76;      // JSON string
pub const INVENTORY_DATA_SIZE: usize = 8192;                        // max bytes for inventory JSON

// Craft request (written by Rust renderer, read by Bun)
// 64-byte buffer for recipe ID (null-terminated string)
pub const CRAFT_REQUEST_OFFSET: usize = INVENTORY_DATA_OFFSET + INVENTORY_DATA_SIZE; // [u8; 64]
pub const CRAFT_REQUEST_SIZE: usize = 64;

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
    Pirate = 8,
    Port = 9,
    Animal = 10,
    Plant = 11,
    Pet = 12,
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
pub struct IslandMesh {
    pub vertex_count: u32,
    pub index_count: u32,
    pub pos_x: f32,
    pub pos_z: f32,
    pub lod_level: u32,
    pub lod_distance: f32,
    pub vertices: Vec<f32>,    // 9 floats per vertex: pos.xyz, normal.xyz, color.rgb
    pub indices: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct RenderData {
    pub camera_pos: [f32; 3],
    pub camera_target: [f32; 3],
    pub entities: Vec<RenderEntity>,
}

#[derive(Clone, Debug)]
pub struct WaterChunkData {
    pub origin_x: i32,
    pub origin_z: i32,
    pub grid_size: usize,
    pub heights: Vec<f32>, // grid_size * grid_size
}

#[derive(Clone, Debug)]
pub struct WaterData {
    pub patch_size: f32,
    pub chunks: Vec<WaterChunkData>,
}

#[derive(Clone, Copy, Debug)]
pub struct WeatherVisual {
    pub sky_color: [f32; 3],
    pub water_color: [f32; 3],
    pub fog_color: [f32; 3],
    pub fog_density: f32,
    pub light_intensity: f32,
    pub weather_type: u32,
    pub is_night: bool,
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

    /// Read render data from Bun (seqlock read) — returns data and seq value
    pub fn read_render_data_with_seq(&self) -> Option<(RenderData, u32)> {
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

        Some((RenderData {
            camera_pos: cam_pos,
            camera_target: cam_target,
            entities,
        }, s1))
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

    /// Read mesh data from Bun (seqlock read, called once at startup)
    pub fn read_mesh_data(&self) -> Vec<IslandMesh> {
        let bytes = self.as_bytes();
        let seq_arr = unsafe {
            &*(bytes.as_ptr().add(MESH_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        let s1 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 & 1 != 0 {
            return Vec::new();
        }

        let mesh_count = u32::from_le_bytes(
            bytes[MESH_COUNT_OFFSET..MESH_COUNT_OFFSET + 4].try_into().unwrap()
        );

        let mut meshes = Vec::with_capacity(mesh_count as usize);
        let mut offset = MESH_DATA_OFFSET;

        for _ in 0..mesh_count {
            if offset + 24 > WATER_SEQ_OFFSET {
                break;
            }

            let vertex_count = u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().unwrap()
            );
            let index_count = u32::from_le_bytes(
                bytes[offset + 4..offset + 8].try_into().unwrap()
            );
            let pos_x = f32::from_le_bytes(
                bytes[offset + 8..offset + 12].try_into().unwrap()
            );
            let pos_z = f32::from_le_bytes(
                bytes[offset + 12..offset + 16].try_into().unwrap()
            );
            let lod_level = u32::from_le_bytes(
                bytes[offset + 16..offset + 20].try_into().unwrap()
            );
            let lod_distance = f32::from_le_bytes(
                bytes[offset + 20..offset + 24].try_into().unwrap()
            );
            offset += 24;

            // Read vertices: vertex_count * 9 f32 = vertex_count * 36 bytes
            let vert_bytes = (vertex_count as usize) * 36;
            if offset + vert_bytes > WATER_SEQ_OFFSET {
                break;
            }
            let vert_count_f32 = vertex_count as usize * 9;
            let mut vertices = vec![0.0f32; vert_count_f32];
            unsafe {
                let src = std::slice::from_raw_parts(
                    bytes.as_ptr().add(offset) as *const f32,
                    vert_count_f32,
                );
                vertices.copy_from_slice(src);
            }
            offset += vert_bytes;

            // Read indices: index_count * u32 = index_count * 4 bytes
            let idx_bytes = (index_count as usize) * 4;
            if offset + idx_bytes > WATER_SEQ_OFFSET {
                break;
            }
            let mut indices = vec![0u32; index_count as usize];
            unsafe {
                let src = std::slice::from_raw_parts(
                    bytes.as_ptr().add(offset) as *const u32,
                    index_count as usize,
                );
                indices.copy_from_slice(src);
            }
            offset += idx_bytes;

            meshes.push(IslandMesh {
                vertex_count,
                index_count,
                pos_x,
                pos_z,
                lod_level,
                lod_distance,
                vertices,
                indices,
            });
        }

        let s2 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 != s2 || s2 & 1 != 0 {
            return Vec::new();
        }

        meshes
    }

    /// Read water chunk data from Bun (seqlock read, called each frame)
    pub fn read_water_data(&self) -> Option<WaterData> {
        let bytes = self.as_bytes();
        let seq_arr = unsafe {
            &*(bytes.as_ptr().add(WATER_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        let s1 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 & 1 != 0 {
            return None;
        }

        let chunk_count = u32::from_le_bytes(
            bytes[WATER_CHUNK_COUNT_OFFSET..WATER_CHUNK_COUNT_OFFSET + 4].try_into().unwrap()
        ) as usize;
        let patch_size = f32::from_le_bytes(
            bytes[WATER_PATCH_SIZE_OFFSET..WATER_PATCH_SIZE_OFFSET + 4].try_into().unwrap()
        );

        let chunk_count = chunk_count.min(WATER_MAX_CHUNKS);
        let mut chunks = Vec::with_capacity(chunk_count);

        for i in 0..chunk_count {
            let base = WATER_CHUNK_DATA_OFFSET + i * WATER_CHUNK_STRIDE;
            let origin_x = i32::from_le_bytes(
                bytes[base..base + 4].try_into().unwrap()
            );
            let origin_z = i32::from_le_bytes(
                bytes[base + 4..base + 8].try_into().unwrap()
            );
            let grid_size = u32::from_le_bytes(
                bytes[base + 8..base + 12].try_into().unwrap()
            ) as usize;

            let count = grid_size * grid_size;
            let mut heights = vec![0.0f32; count];
            unsafe {
                let src = std::slice::from_raw_parts(
                    bytes.as_ptr().add(base + WATER_CHUNK_HEADER_SIZE) as *const f32,
                    count,
                );
                heights.copy_from_slice(src);
            }

            chunks.push(WaterChunkData {
                origin_x,
                origin_z,
                grid_size,
                heights,
            });
        }

        let s2 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 != s2 || s2 & 1 != 0 {
            return None;
        }

        Some(WaterData {
            patch_size,
            chunks,
        })
    }

    /// Read weather visual data from Bun (seqlock read, called each frame)
    pub fn read_weather_visual(&self) -> Option<WeatherVisual> {
        let bytes = self.as_bytes();
        let seq_arr = unsafe {
            &*(bytes.as_ptr().add(WEATHER_SEQ_OFFSET) as *const std::sync::atomic::AtomicU32)
        };

        let s1 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 & 1 != 0 {
            return None;
        }

        let read3 = |off: usize| [
            f32::from_le_bytes(bytes[off..off+4].try_into().unwrap()),
            f32::from_le_bytes(bytes[off+4..off+8].try_into().unwrap()),
            f32::from_le_bytes(bytes[off+8..off+12].try_into().unwrap()),
        ];

        let sky_color = read3(WEATHER_SKY_COLOR_OFFSET);
        let water_color = read3(WEATHER_WATER_COLOR_OFFSET);
        let fog_color = read3(WEATHER_FOG_COLOR_OFFSET);
        let fog_density = f32::from_le_bytes(
            bytes[WEATHER_FOG_DENSITY_OFFSET..WEATHER_FOG_DENSITY_OFFSET+4].try_into().unwrap()
        );
        let light_intensity = f32::from_le_bytes(
            bytes[WEATHER_LIGHT_INTENSITY_OFFSET..WEATHER_LIGHT_INTENSITY_OFFSET+4].try_into().unwrap()
        );
        let weather_type = u32::from_le_bytes(
            bytes[WEATHER_TYPE_OFFSET..WEATHER_TYPE_OFFSET+4].try_into().unwrap()
        );
        let is_night = u32::from_le_bytes(
            bytes[WEATHER_IS_NIGHT_OFFSET..WEATHER_IS_NIGHT_OFFSET+4].try_into().unwrap()
        ) != 0;

        let s2 = seq_arr.load(std::sync::atomic::Ordering::Acquire);
        if s1 != s2 || s2 & 1 != 0 {
            return None;
        }

        Some(WeatherVisual {
            sky_color,
            water_color,
            fog_color,
            fog_density,
            light_intensity,
            weather_type,
            is_night,
        })
    }

    /// Read game state from Bun (is_dead flag + cause of death)
    pub fn read_game_state(&self) -> (bool, String) {
        let bytes = self.as_bytes();
        let is_dead = u32::from_le_bytes(
            bytes[GAME_STATE_OFFSET..GAME_STATE_OFFSET + 4].try_into().unwrap()
        ) != 0;

        let cause_bytes = &bytes[GAME_STATE_CAUSE_OFFSET..GAME_STATE_CAUSE_OFFSET + GAME_STATE_CAUSE_SIZE];
        let cause = String::from_utf8_lossy(
            &cause_bytes[..cause_bytes.iter().position(|&b| b == 0).unwrap_or(GAME_STATE_CAUSE_SIZE)]
        ).to_string();

        (is_dead, cause)
    }

    /// Write respawn request (called when UI respawn button is clicked)
    pub fn write_respawn_request(&mut self) {
        let bytes = self.as_bytes_mut();
        bytes[RESPAWN_REQUEST_OFFSET..RESPAWN_REQUEST_OFFSET + 4]
            .copy_from_slice(&1u32.to_le_bytes());
    }

    /// Check if a respawn request is pending (called by Bun each tick)
    pub fn read_respawn_request(&mut self) -> bool {
        let bytes = self.as_bytes();
        let requested = u32::from_le_bytes(
            bytes[RESPAWN_REQUEST_OFFSET..RESPAWN_REQUEST_OFFSET + 4].try_into().unwrap()
        ) != 0;
        if requested {
            let bytes_mut = self.as_bytes_mut();
            bytes_mut[RESPAWN_REQUEST_OFFSET..RESPAWN_REQUEST_OFFSET + 4]
                .copy_from_slice(&0u32.to_le_bytes());
        }
        requested
    }

    pub fn print_path(&self) {
        use std::io::Write;
        print!("SHM_PATH:{}\n", self.path.display());
        std::io::stdout().flush().ok();
    }

    /// Write a craft request (recipe ID) to shared memory for Bun to read
    pub fn write_craft_request(&mut self, recipe_id: &str) {
        let bytes_mut = self.as_bytes_mut();
        // Clear the buffer first
        for i in 0..CRAFT_REQUEST_SIZE {
            bytes_mut[CRAFT_REQUEST_OFFSET + i] = 0;
        }
        // Write the recipe ID as ASCII bytes
        let id_bytes = recipe_id.as_bytes();
        let len = id_bytes.len().min(CRAFT_REQUEST_SIZE - 1);
        bytes_mut[CRAFT_REQUEST_OFFSET..CRAFT_REQUEST_OFFSET + len]
            .copy_from_slice(&id_bytes[..len]);
    }

    /// Read inventory JSON from Bun (called each render frame by Rust)
    pub fn read_inventory(&self) -> Option<String> {
        let bytes = self.as_bytes();
        let seq1 = u32::from_le_bytes(
            bytes[INVENTORY_SEQ_OFFSET..INVENTORY_SEQ_OFFSET + 4].try_into().unwrap()
        );
        if seq1 & 1 != 0 {
            return None; // write in progress
        }

        let data_bytes = &bytes[INVENTORY_DATA_OFFSET..INVENTORY_DATA_OFFSET + INVENTORY_DATA_SIZE];
        let len = data_bytes.iter().position(|&b| b == 0).unwrap_or(INVENTORY_DATA_SIZE);
        let json = String::from_utf8_lossy(&data_bytes[..len]).to_string();

        // Verify seqlock didn't change during read
        let seq2 = u32::from_le_bytes(
            bytes[INVENTORY_SEQ_OFFSET..INVENTORY_SEQ_OFFSET + 4].try_into().unwrap()
        );
        if seq1 != seq2 {
            return None; // changed during read, skip this frame
        }

        if json.is_empty() { None } else { Some(json) }
    }
}

impl Drop for SharedMemory {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
