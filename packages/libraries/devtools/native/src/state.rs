// state.rs — mirrored devtools data + egui input state.
//
// All data sources (CDP bridge, scene store, GPU info, ProfilingSAB) live in TS.
// TS pushes changes into Rust via the FFI mirror functions; these structs hold
// the Rust-side mirror that the egui panels read each frame.

use std::collections::VecDeque;

// ── Console ──

#[derive(Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum ConsoleSeverity {
    Log = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
    Debug = 4,
    Trace = 5,
    Repl = 6,
    ReplError = 7,
}

impl ConsoleSeverity {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Info,
            2 => Self::Warn,
            3 => Self::Error,
            4 => Self::Debug,
            5 => Self::Trace,
            6 => Self::Repl,
            7 => Self::ReplError,
            _ => Self::Log,
        }
    }
}

#[derive(Clone)]
pub struct ConsoleEntry {
    pub text: String,
    pub severity: ConsoleSeverity,
    pub thread: String,
    pub timestamp: f64,
    pub has_stack: bool,
}

#[derive(Clone)]
pub struct ThreadInfo {
    pub id: String,
    pub name: String,
    pub kind: u8, // 0 = main, 1 = worker
}

pub struct ConsoleState {
    pub entries: Vec<ConsoleEntry>,
    pub filter: u8,            // 0=all, 1=error, 2=warn, 3=info
    pub selected_thread: String,
    pub threads: Vec<ThreadInfo>,
    pub repl_input: String,
    pub repl_history: Vec<String>,
    pub repl_history_idx: i32,
    pub scroll: f32,
}

impl Default for ConsoleState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            filter: 0,
            selected_thread: "main".to_string(),
            threads: vec![ThreadInfo {
                id: "main".to_string(),
                name: "main".to_string(),
                kind: 0,
            }],
            repl_input: String::new(),
            repl_history: Vec::new(),
            repl_history_idx: -1,
            scroll: 0.0,
        }
    }
}

// ── Tree (scene + DOM/ECS) ──

#[derive(Clone)]
pub struct TreeNode {
    pub id: u32,
    pub parent_id: i32, // -1 = root
    pub label: String,
    pub detail: String,
    pub depth: u16,
    pub child_count: u32,
    pub kind: u8, // 0=pixi, 1=ecs, 2=gpu-resource...
}

pub struct TreeSnapshot {
    pub nodes: Vec<TreeNode>,
    pub mode: u8, // 0=pixi, 1=ecs
}

impl Default for TreeSnapshot {
    fn default() -> Self {
        Self { nodes: Vec::new(), mode: 0 }
    }
}

// ── GPU info ──

#[derive(Clone)]
pub struct GpuKvEntry {
    pub key: String,
    pub value: String,
    pub is_header: bool,
}

#[derive(Clone, Default)]
pub struct GpuInfoSnapshot {
    pub entries: Vec<GpuKvEntry>,
    /// Frame-time history samples: (cpu_ms, gpu_ms) pairs, newest last.
    pub frame_times: Vec<[f32; 2]>,
    /// GPU memory history (bytes), newest last.
    pub mem_history: Vec<f64>,
}

// ── CDP profile (perf recorder) ──

#[derive(Clone)]
pub struct ProfileNode {
    pub id: u32,
    pub call_frame: String,
    pub url: String,
    pub line: u32,
    pub hit_count: u32,
    pub children: Vec<u32>,
}

#[derive(Clone, Default)]
pub struct CdpProfile {
    pub nodes: Vec<ProfileNode>,
    pub start_us: f64,
    pub end_us: f64,
    pub samples: Vec<u32>,
    pub time_deltas_us: Vec<f64>,
}

// ── Per-thread metrics (perf metrics) ──

#[derive(Clone, Default)]
pub struct ThreadMetricsSample {
    pub cpu_percent: f32,
    pub heap_used: f64,
    pub heap_total: f64,
    pub gc_pause_max_us: f64,
    pub task_latency_p95_us: f64,
}

#[derive(Clone, Default)]
pub struct ThreadMetricsSlot {
    pub slot_index: u32,
    pub name: String,
    pub runtime: u8, // 0=js, 1=wasm
    /// Ring of samples, newest last (capped 120).
    pub history: Vec<ThreadMetricsSample>,
}

#[derive(Clone, Default)]
pub struct MetricsSnapshot {
    pub slots: Vec<ThreadMetricsSlot>,
}

// ── Eval round-trip (REPL) ──

pub struct EvalRequest {
    pub request_id: u64,
    pub thread_id: String,
    pub expr: String,
}

pub struct EvalResult {
    pub request_id: u64,
    pub text: String,
    pub is_error: bool,
}

// ── egui input state (accumulated per frame) ──

pub struct InputState {
    pub screen_size: (f32, f32),
    pub mouse_pos: (f32, f32),
    pub mouse_in_window: bool,
    pub mouse_delta: (f32, f32),
    /// [left, right, middle] — current pressed state.
    pub mouse_down: [bool; 3],
    /// Transitions this frame: (button_index, pressed).
    pub mouse_events: VecDeque<(usize, bool)>,
    pub wheel: f32,
    pub modifiers_alt: bool,
    pub modifiers_ctrl: bool,
    pub modifiers_shift: bool,
    /// Keys pressed this frame (egui Key enum index).
    pub keys_pressed: Vec<u8>,
    /// Text typed this frame.
    pub text: String,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            screen_size: (1280.0, 720.0),
            mouse_pos: (0.0, 0.0),
            mouse_in_window: false,
            mouse_delta: (0.0, 0.0),
            mouse_down: [false, false, false],
            mouse_events: VecDeque::new(),
            wheel: 0.0,
            modifiers_alt: false,
            modifiers_ctrl: false,
            modifiers_shift: false,
            keys_pressed: Vec::new(),
            text: String::new(),
        }
    }
}

// ── Panel ids ──

#[derive(Clone, Copy, PartialEq)]
pub enum PanelId {
    Console = 0,
    Scene = 1,
    Gpu = 2,
    PerfRecorder = 3,
    PerfMetrics = 4,
    DomTree = 5,
}

impl PanelId {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Scene,
            2 => Self::Gpu,
            3 => Self::PerfRecorder,
            4 => Self::PerfMetrics,
            5 => Self::DomTree,
            _ => Self::Console,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Console => "Console",
            Self::Scene => "Scene",
            Self::Gpu => "GPU",
            Self::PerfRecorder => "Recorder",
            Self::PerfMetrics => "Metrics",
            Self::DomTree => "ECS",
        }
    }
    pub const ALL: [PanelId; 6] = [
        Self::Console,
        Self::Scene,
        Self::Gpu,
        Self::PerfRecorder,
        Self::PerfMetrics,
        Self::DomTree,
    ];
}
