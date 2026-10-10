//! wgpu_shim.c → wgpu crate port.
//!
//! Every `wgpu_shim_*` export from the C shim is reproduced with an identical
//! signature. Handles are opaque `*mut c_void` over `Box<T>` of the wgpu API
//! object (all wgpu objects are Arc-backed Clones, so holding extra clones for
//! polling is safe). Where the wgpu crate consumes/moves objects the C API
//! did not (`CommandEncoder::finish(self)`, pass `end` = drop), the boxed
//! handle wraps `Option<T>` so `release_*` stays safe after the move.
//!
//! Async APIs (requestAdapter/requestDevice/mapAsync/popErrorScope/
//! onSubmittedWorkDone) preserve the C shim's synchronous behavior: register
//! the callback, then pump `Instance::poll_all` / `Device::poll` until it
//! fires — the JS caller never sees a future.
//!
//! Flat-array wire layouts (bind group entries, color attachments, vertex
//! buffers, …) match wgpu_shim.c byte-for-byte; see the comments above each
//! parser.

mod enums;
mod validate;

use wgpu::wgc;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void, CStr};
use std::future::Future;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex};
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use wgpu::*;

type Handle = *mut c_void;

fn boxed<T>(v: T) -> Handle {
    Box::into_raw(Box::new(v)) as Handle
}

unsafe fn obj<'a, T>(p: Handle) -> &'a T {
    &*(p as *const T)
}

unsafe fn obj_mut<'a, T>(p: Handle) -> &'a mut T {
    &mut *(p as *mut T)
}

unsafe fn release<T>(p: Handle) {
    if !p.is_null() {
        drop(Box::from_raw(p as *mut T));
    }
}

unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// Null-tolerant slice view — `from_raw_parts` is UB on a null pointer even
/// at len 0, and JS callers legitimately pass null for empty flat arrays.
unsafe fn flat<'a, T>(p: *const T, n: usize) -> &'a [T] {
    if p.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(p, n)
    }
}

unsafe fn read_ptr(lo_hi: &[u32]) -> Handle {
    ((lo_hi[1] as u64) << 32 | lo_hi[0] as u64) as Handle
}

const WHOLE_SIZE: u64 = u64::MAX;

// ── Global state ──
// Replaces the C shim's bare statics (g_instance, g_lost_device, the single-
// slot g_map_complete / g_pending_adapter races) with Mutex-guarded slots.

/// All live instances, keyed by their boxed handle address. pump() drives
/// every one — a second instance (specs, bespoke harnesses, anything that
/// calls installGPU off the main thread) must not steal the pump from the
/// instance whose devices still have pending callbacks, which a single
/// Option<Instance> slot would silently do.
static G_INSTANCES: LazyLock<Mutex<Vec<(usize, Instance)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
static G_DEVICE: Mutex<Option<Device>> = Mutex::new(None);
/// SurfaceTexture stashed between getCurrentTexture → present, keyed by the
/// surface handle value. Mirrors the C model where wgpuSurfacePresent works
/// on "whatever the last get_current_texture acquired".
static G_SURFACE_TEXTURES: LazyLock<Mutex<HashMap<usize, SurfaceTexture>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Surfaces whose configure() completed without panicking. wgpu panics
/// inside get_current_texture when the surface was never configured (or a
/// configure attempt itself panicked) — ffi! catches the unwind but the
/// panic hook still prints a scary record per frame. Gating the call here
/// turns that case into a plain SURFACE_TEX_ERROR status the JS side
/// already handles as a skipped frame.
static G_CONFIGURED_SURFACES: LazyLock<Mutex<HashSet<usize>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

thread_local! {
    /// ErrorScopeGuard is !Send (per-thread by design in wgpu) — scopes are
    /// stored per device handle, on the calling thread. All FFI callers are
    /// the JS main thread.
    static ERROR_SCOPES: RefCell<HashMap<usize, Vec<ErrorScopeGuard>>> =
        RefCell::new(HashMap::new());
}

/// Per-device lost-state, filled by the device-lost callback.
struct ShimDevice {
    device: Device,
    queue: Queue,
    lost: std::sync::Arc<Mutex<Option<(u32, String)>>>,
}

/// CommandEncoder boxed as Option so `finish(self)` can take it; a finished
/// (None) encoder release is then a no-op — same as the C refcount model.
struct ShimEncoder(Option<CommandEncoder>);
/// CommandBuffer is !Clone and `Queue::submit` consumes it — the Option is
/// taken on submit so `release_command_buffer` stays safe afterwards.
struct ShimCommandBuffer(Option<CommandBuffer>);
struct ShimQuerySet(Option<QuerySet>);
struct ShimRenderPass(Option<RenderPass<'static>>);
struct ShimComputePass(Option<ComputePass<'static>>);

// ── Synchronous pump ──

fn noop_waker() -> Waker {
    unsafe fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(ptr::null(), &VTABLE)
    }
    unsafe fn noop(_: *const ()) {}
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
    unsafe { Waker::from_raw(RawWaker::new(ptr::null(), &VTABLE)) }
}

/// Drive all device work in the instance once. `force_wait` blocks until a
/// callback fires — used inside poll loops where a callback is known pending.
fn pump(wait: bool) {
    let insts = G_INSTANCES.lock().unwrap().clone();
    if !insts.is_empty() {
        // wait=true is only meaningful with a single live instance — a
        // blocking poll on the wrong instance could wedge on a callback that
        // lives on another. All callers currently pass false; degrade wait
        // to a non-blocking sweep when several instances are registered.
        let blocking = wait && insts.len() == 1;
        for (_, i) in &insts {
            i.poll_all(blocking);
        }
        report_tick(&insts);
        return;
    }
    let dev = G_DEVICE.lock().unwrap().clone();
    if let Some(d) = dev {
        let _ = d.poll(if wait {
            PollType::wait_indefinitely()
        } else {
            PollType::Poll
        });
    }
}

/// DD_WGPU_REPORT=<n>: every n pump() calls, dump wgpu registry occupancy —
/// num_allocated (id high-water), kept (live), vacant — so runaway index
/// spaces are visible without a debugger.
static PUMP_TICKS: AtomicU64 = AtomicU64::new(0);
fn report_tick(insts: &[(usize, Instance)]) {
    let every: u64 = match std::env::var("DD_WGPU_REPORT") {
        Ok(v) => v.parse().unwrap_or(0),
        Err(_) => return,
    };
    if every == 0 || PUMP_TICKS.fetch_add(1, Ordering::Relaxed) % every != 0 {
        return;
    }
    for (_, i) in insts {
        let Some(rep) = i.generate_report() else { continue };
        let h = rep.hub_report();
        let f = |r: &wgc::registry::RegistryReport| {
            format!("{}/{}/{}", r.num_allocated, r.num_kept_from_user, r.num_released_from_user)
        };
        eprintln!(
            "[wgpu-report] surfaces={} textures={} views={} bindgroups={} cmdbuf={} buffers={} devices={} queues={}",
            f(&rep.surfaces), f(&h.textures), f(&h.texture_views), f(&h.bind_groups),
            f(&h.command_buffers), f(&h.buffers), f(&h.devices), f(&h.queues),
        );
    }
}

/// block_on equivalent that pumps the GPU stack while the future is pending.
/// wgpu-native resolves request_adapter/request_device internally on poll —
/// the spin never hangs because the callback is already queued. Bounded like
/// [`pump_until`]: a future that never resolves (device lost, hung queue)
/// returns None after the timeout so the caller fails instead of wedging
/// the JS thread at 100% CPU.
fn block_on_gpu<F: Future>(fut: F) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    let start = std::time::Instant::now();
    let mut warned = false;
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return Some(v);
        }
        pump(false);
        let elapsed = start.elapsed();
        if !warned && elapsed > std::time::Duration::from_secs(2) {
            warned = true;
            eprintln!(
                "[wgpu_shim] GPU future not resolving after 2s — device hung or callback dropped"
            );
        }
        if elapsed > std::time::Duration::from_secs(15) {
            eprintln!("[wgpu_shim] block_on_gpu timed out after 15s — returning failure to caller");
            return None;
        }
        // Same pacing as pump_until — spin fast for µs-scale resolves, then
        // 1ms sleeps so a genuinely-hung wait doesn't pin a core.
        if elapsed < std::time::Duration::from_millis(50) {
            std::thread::yield_now();
        } else {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

/// Pump until `rx` delivers — used after registering map_async / pop_error /
/// on_submitted_work_done callbacks. Mirrors the C shim's
/// `while (!done) wgpuInstanceProcessEvents()` spin — but bounded: a callback
/// that never arrives (device lost, hung queue) would otherwise wedge the JS
/// thread at 100% CPU with the event loop, HTTP servers, and signal handlers
/// all starved. After the timeout we return None so the caller fails instead.
fn pump_until<T>(rx: &std::sync::mpsc::Receiver<T>) -> Option<T> {
    let start = std::time::Instant::now();
    let mut warned = false;
    loop {
        if let Ok(v) = rx.try_recv() {
            return Some(v);
        }
        pump(false);
        let elapsed = start.elapsed();
        if !warned && elapsed > std::time::Duration::from_secs(2) {
            warned = true;
            eprintln!("[wgpu_shim] GPU callback not delivered after 2s — device may be lost or the queue hung");
        }
        if elapsed > std::time::Duration::from_secs(15) {
            eprintln!("[wgpu_shim] pump_until timed out after 15s — returning failure to caller");
            return None;
        }
        // Spin fast at first (maps normally complete in µs), then fall back to
        // a 1ms sleep so a genuinely-hung wait doesn't pin a core forever.
        if elapsed < std::time::Duration::from_millis(50) {
            std::thread::yield_now();
        } else {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

// ── Uncaptured-error dedup (matches C ring of 64) ──

static ERROR_DEDUP: LazyLock<Mutex<HashSet<u64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn log_uncaptured(err: Error) {
    let msg = err.to_string();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&msg, &mut hasher);
    let h = std::hash::Hasher::finish(&hasher);
    let mut seen = ERROR_DEDUP.lock().unwrap();
    if seen.len() >= 64 {
        seen.clear();
    }
    if seen.insert(h) {
        eprintln!("[wgpu] uncaptured error: {msg}");
    }
}

// ── Instance / adapter / device ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_instance() -> Handle {
    ffi!(ptr::null_mut(), {
        let instance = Instance::new(InstanceDescriptor::new_without_display_handle_from_env());
        let handle = boxed(instance.clone());
        G_INSTANCES
            .lock()
            .unwrap()
            .push((handle as usize, instance));
        if G_INSTANCES.lock().unwrap().len() > 1 {
            eprintln!("[wgpu_shim] WARNING: second wgpu instance created — instances share the process-global pump; release the first before creating another");
        }
        handle
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_request_adapter(instance: Handle, power_preference: i32) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let instance = obj::<Instance>(instance);
        let options = RequestAdapterOptions {
            power_preference: enums::power_preference(power_preference as u32),
            force_fallback_adapter: false,
            compatible_surface: None,
        };
        match block_on_gpu(instance.request_adapter(&options)) {
            Some(Ok(adapter)) => boxed(adapter),
            Some(Err(e)) => {
                eprintln!("[wgpu_shim] adapter request failed: {e}");
                ptr::null_mut()
            }
            None => {
                eprintln!("[wgpu_shim] adapter request timed out");
                ptr::null_mut()
            }
        }
    })
}

/// limits: flat (fieldIndex, lo32, hi32) triples using the wgpu-wrapper.ts
/// LIMIT_FIELD_INDEX numbering (0..30; the two u64 fields are single indices
/// 13/14 and 18). features: u32 WGPUFeatureName values. Shared by the sync
/// and async request_device entry points.
unsafe fn parse_device_desc(
    adapter: &Adapter,
    limits_ptr: *const u32,
    limit_count: u32,
    features_ptr: *const u32,
    feature_count: u32,
) -> DeviceDescriptor<'static> {
    let mut limits = adapter.limits();
    if !limits_ptr.is_null() {
        let flat = std::slice::from_raw_parts(limits_ptr, limit_count as usize * 3);
        for i in 0..limit_count as usize {
            let field = flat[i * 3];
            let value = flat[i * 3 + 1] as u64 | (flat[i * 3 + 2] as u64) << 32;
            let v32 = value as u32;
            match field {
                0 => limits.max_texture_dimension_1d = v32,
                1 => limits.max_texture_dimension_2d = v32,
                2 => limits.max_texture_dimension_3d = v32,
                3 => limits.max_texture_array_layers = v32,
                4 => limits.max_bind_groups = v32,
                // 5 = maxBindGroupsPlusVertexBuffers — removed from wgpu
                // Limits in v25; the field is accepted on the wire but has
                // no wgpu counterpart to set.
                6 => limits.max_bindings_per_bind_group = v32,
                7 => limits.max_dynamic_uniform_buffers_per_pipeline_layout = v32,
                8 => limits.max_dynamic_storage_buffers_per_pipeline_layout = v32,
                9 => limits.max_sampled_textures_per_shader_stage = v32,
                10 => limits.max_samplers_per_shader_stage = v32,
                11 => limits.max_storage_buffers_per_shader_stage = v32,
                12 => limits.max_storage_textures_per_shader_stage = v32,
                13 => limits.max_uniform_buffers_per_shader_stage = v32,
                14 => limits.max_uniform_buffer_binding_size = value,
                15 => limits.max_storage_buffer_binding_size = value,
                16 => limits.min_uniform_buffer_offset_alignment = v32,
                17 => limits.min_storage_buffer_offset_alignment = v32,
                18 => limits.max_vertex_buffers = v32,
                19 => limits.max_buffer_size = value,
                20 => limits.max_vertex_attributes = v32,
                21 => limits.max_vertex_buffer_array_stride = v32,
                22 => limits.max_inter_stage_shader_variables = v32,
                23 => limits.max_color_attachments = v32,
                24 => limits.max_color_attachment_bytes_per_sample = v32,
                25 => limits.max_compute_workgroup_storage_size = v32,
                26 => limits.max_compute_invocations_per_workgroup = v32,
                27 => limits.max_compute_workgroup_size_x = v32,
                28 => limits.max_compute_workgroup_size_y = v32,
                29 => limits.max_compute_workgroup_size_z = v32,
                30 => limits.max_compute_workgroups_per_dimension = v32,
                31 => limits.max_immediate_size = v32,
                _ => {}
            }
        }
    }

    let mut features = Features::empty();
    if !features_ptr.is_null() {
        let flat = std::slice::from_raw_parts(features_ptr, feature_count as usize);
        for i in 0..feature_count as usize {
            features |= enums::feature(flat[i]);
        }
    }

    DeviceDescriptor {
        label: None,
        required_features: features,
        required_limits: limits,
        experimental_features: ExperimentalFeatures::disabled(),
        memory_hints: MemoryHints::default(),
        trace: Trace::Off,
    }
}

/// Wrap a completed request_device result into the ShimDevice box (lost
/// callback, uncaptured-error hook, G_DEVICE registration). Shared by the
/// sync and async request paths — runs on whichever thread completed the
/// request; all touched state is Mutex-guarded.
fn finish_device_request(res: Option<Result<(Device, Queue), RequestDeviceError>>) -> Handle {
    match res {
        Some(Ok((device, queue))) => {
            let lost = std::sync::Arc::new(Mutex::new(None));
            let lost_cb = lost.clone();
            device.set_device_lost_callback(move |reason, msg| {
                eprintln!("[wgpu_shim] device lost (reason={reason:?}): {msg}");
                *lost_cb.lock().unwrap() = Some((enums::device_lost_reason(reason), msg));
            });
            device.on_uncaptured_error(std::sync::Arc::new(log_uncaptured));
            *G_DEVICE.lock().unwrap() = Some(device.clone());
            boxed(ShimDevice {
                device,
                queue,
                lost,
            })
        }
        Some(Err(e)) => {
            eprintln!("[wgpu_shim] device request failed: {e}");
            ptr::null_mut()
        }
        None => {
            eprintln!("[wgpu_shim] device request timed out");
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn wgpu_shim_request_device(
    adapter: Handle,
    limits_ptr: *const u32,
    limit_count: u32,
    features_ptr: *const u32,
    feature_count: u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let adapter = obj::<Adapter>(adapter);
        let desc = parse_device_desc(
            adapter,
            limits_ptr,
            limit_count,
            features_ptr,
            feature_count,
        );
        finish_device_request(block_on_gpu(adapter.request_device(&desc)))
    })
}

// ── Async request ops (JS-visible polling) ──
// request_adapter/request_device spend up to hundreds of ms inside
// block_on_gpu's spin — the synchronous exports above pin the calling JS
// thread for that entire stretch, which stalls module load, the event pump,
// and the boot splash. The _async variants run the same bounded wait on a
// detached thread and hand back a token; the JS side polls
// wgpu_shim_async_poll between event-loop yields and collects the result
// with wgpu_shim_async_take. Failed/cancelled ops complete with a null
// handle (poll=1, take=null) — identical outcome to the sync path.

static NEXT_OP_TOKEN: AtomicU64 = AtomicU64::new(1);
/// In-flight async requests: token → receiver the worker thread sends its
/// boxed handle result (usize-cast; 0 on failure) through. Raw pointers are
/// !Send — the channel carries the address, not the pointer.
static PENDING_OPS: LazyLock<Mutex<HashMap<u64, mpsc::Receiver<usize>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Completed results awaiting wgpu_shim_async_take (usize-cast handles).
static COMPLETED_OPS: LazyLock<Mutex<HashMap<u64, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn spawn_op<F>(work: F) -> u64
where
    F: FnOnce() -> Handle + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<usize>();
    std::thread::spawn(move || {
        let _ = tx.send(work() as usize);
    });
    let token = NEXT_OP_TOKEN.fetch_add(1, Ordering::Relaxed);
    PENDING_OPS.lock().unwrap().insert(token, rx);
    token
}

#[no_mangle]
pub extern "C" fn wgpu_shim_request_adapter_async(
    instance: Handle,
    power_preference: i32,
) -> u64 {
    ffi!(0, unsafe {
        // Clone the Arc-backed instance — the JS side may release its box
        // while the request is still in flight.
        let instance = obj::<Instance>(instance).clone();
        let pp = enums::power_preference(power_preference as u32);
        spawn_op(move || {
            let options = RequestAdapterOptions {
                power_preference: pp,
                force_fallback_adapter: false,
                compatible_surface: None,
            };
            match block_on_gpu(instance.request_adapter(&options)) {
                Some(Ok(adapter)) => boxed(adapter),
                Some(Err(e)) => {
                    eprintln!("[wgpu_shim] adapter request failed: {e}");
                    ptr::null_mut()
                }
                None => {
                    eprintln!("[wgpu_shim] adapter request timed out");
                    ptr::null_mut()
                }
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_request_device_async(
    adapter: Handle,
    limits_ptr: *const u32,
    limit_count: u32,
    features_ptr: *const u32,
    feature_count: u32,
) -> u64 {
    ffi!(0, unsafe {
        let adapter = obj::<Adapter>(adapter);
        // Parse on the calling thread — the flat arrays point into JS memory
        // that is only valid for the duration of this FFI call.
        let desc = parse_device_desc(
            adapter,
            limits_ptr,
            limit_count,
            features_ptr,
            feature_count,
        );
        let adapter = adapter.clone();
        spawn_op(move || {
            finish_device_request(block_on_gpu(adapter.request_device(&desc)))
        })
    })
}

/// 0 = still pending, 1 = complete (collect via wgpu_shim_async_take),
/// -1 = unknown token (already taken / never existed).
#[no_mangle]
pub extern "C" fn wgpu_shim_async_poll(token: u64) -> i32 {
    ffi!(-1, {
        let mut pending = PENDING_OPS.lock().unwrap();
        match pending.get(&token) {
            None => {
                if COMPLETED_OPS.lock().unwrap().contains_key(&token) {
                    1
                } else {
                    -1
                }
            }
            Some(rx) => match rx.try_recv() {
                Ok(handle) => {
                    pending.remove(&token);
                    COMPLETED_OPS.lock().unwrap().insert(token, handle);
                    1
                }
                Err(mpsc::TryRecvError::Empty) => 0,
                Err(mpsc::TryRecvError::Disconnected) => {
                    pending.remove(&token);
                    COMPLETED_OPS.lock().unwrap().insert(token, 0);
                    1
                }
            },
        }
    })
}

/// Collect a completed op's handle (null on failure). Consumes the token.
#[no_mangle]
pub extern "C" fn wgpu_shim_async_take(token: u64) -> Handle {
    ffi!(ptr::null_mut(), {
        PENDING_OPS.lock().unwrap().remove(&token);
        COMPLETED_OPS
            .lock()
            .unwrap()
            .remove(&token)
            .map(|h| h as Handle)
            .unwrap_or(ptr::null_mut())
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_device_get_queue(device: Handle) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        boxed(obj::<ShimDevice>(device).queue.clone())
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_process_events(instance: Handle) {
    ffi!((), unsafe {
        if instance.is_null() {
            pump(false);
        } else {
            obj::<Instance>(instance).poll_all(false);
            report_tick(&[(instance as usize, obj::<Instance>(instance).clone())]);
        }
    });
}

/// 0 = alive, else WGPUDeviceLostReason. Message copied into out_msg.
#[no_mangle]
pub extern "C" fn wgpu_shim_device_poll_lost(
    device: Handle,
    out_msg: *mut c_char,
    out_msg_size: i32,
) -> u32 {
    ffi!(0, unsafe {
        let lost = obj::<ShimDevice>(device).lost.lock().unwrap();
        match lost.as_ref() {
            None => 0,
            Some((reason, msg)) => {
                if !out_msg.is_null() && out_msg_size > 0 {
                    let bytes = msg.as_bytes();
                    let n = bytes.len().min(out_msg_size as usize - 1);
                    ptr::copy_nonoverlapping(bytes.as_ptr(), out_msg as *mut u8, n);
                    *out_msg.add(n) = 0;
                }
                *reason
            }
        }
    })
}

// ── Buffers ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_buffer(
    device: Handle,
    size: u64,
    usage: u32,
    mapped_at_creation: i32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_buffer(&BufferDescriptor {
                    label: None,
                    size,
                    usage: BufferUsages::from_bits_retain(usage),
                    mapped_at_creation: mapped_at_creation != 0,
                }),
        )
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_queue_write_buffer(
    queue: Handle,
    buffer: Handle,
    offset: u64,
    data: *const u8,
    size: usize,
) {
    ffi!((), unsafe {
        let bytes = flat(data, size);
        obj::<Queue>(queue).write_buffer(obj::<Buffer>(buffer), offset, bytes);
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_buffer_map_async(
    buffer: Handle,
    mode: u32,
    offset: u64,
    size: u64,
) -> u32 {
    ffi!(1, unsafe {
        let buffer = obj::<Buffer>(buffer);
        let (tx, rx) = std::sync::mpsc::channel();
        let mode = enums::map_mode(mode);
        let cb = move |res: Result<(), BufferAsyncError>| {
            let _ = tx.send(res.is_ok());
        };
        if size == WHOLE_SIZE {
            buffer.map_async(mode, offset.., cb);
        } else {
            buffer.map_async(mode, offset..offset + size, cb);
        }
        match pump_until(&rx) {
            Some(true) => 3, // WGPUBufferMapState_Mapped
            _ => 1,          // Unmapped
        }
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_buffer_write_mapped(
    buffer: Handle,
    offset: u64,
    data: *const u8,
    size: u64,
) -> i32 {
    ffi!(1, unsafe {
        let src = flat(data, size as usize);
        let mut view = obj::<Buffer>(buffer).get_mapped_range_mut(offset..offset + size);
        view.copy_from_slice(src);
        0
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_buffer_read_mapped(
    buffer: Handle,
    offset: u64,
    size: u64,
    out_data: *mut u8,
    out_size: i32,
) -> i32 {
    ffi!(1, unsafe {
        if out_size < size as i32 {
            return 2;
        }
        let view = obj::<Buffer>(buffer).get_mapped_range(offset..offset + size);
        ptr::copy_nonoverlapping(view.as_ptr(), out_data, size as usize);
        0
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_buffer_unmap(buffer: Handle) {
    ffi!((), unsafe { obj::<Buffer>(buffer).unmap() });
}

// ── Shader ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_shader_module(device: Handle, wgsl: *const c_char) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let code = cstr(wgsl);
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_shader_module(ShaderModuleDescriptor {
                    label: None,
                    source: ShaderSource::Wgsl(code.into()),
                }),
        )
    })
}

/// Static "[]" — matches the C shim (wgpu-native's getCompilationInfo panicked;
/// real validation moves to naga in Phase 6). Do NOT free.
#[no_mangle]
pub extern "C" fn wgpu_shim_shader_get_compilation_info(_shader: Handle) -> *mut c_char {
    ffi!(ptr::null_mut(), { c"[]".as_ptr() as *mut c_char })
}

// ── Textures ──

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_create_texture(
    device: Handle,
    width: u32,
    height: u32,
    depth_or_array_layers: u32,
    mip_level_count: u32,
    sample_count: u32,
    dimension: u32,
    format: u32,
    usage: u32,
    view_format_count: u32,
    view_formats: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let Some(format) = enums::texture_format(format) else {
            eprintln!("[wgpu_shim] create_texture: invalid texture format 0x{format:x}");
            return ptr::null_mut();
        };
        let mut vf = Vec::new();
        if !view_formats.is_null() && view_format_count > 0 {
            let raw = std::slice::from_raw_parts(view_formats, view_format_count as usize);
            for (i, &f) in raw.iter().enumerate() {
                match enums::texture_format(f) {
                    Some(f) => vf.push(f),
                    None => {
                        eprintln!(
                            "[wgpu_shim] create_texture: invalid view format 0x{f:x} at index {i}"
                        );
                        return ptr::null_mut();
                    }
                }
            }
        }
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_texture(&TextureDescriptor {
                    label: None,
                    size: Extent3d {
                        width,
                        height,
                        depth_or_array_layers,
                    },
                    mip_level_count,
                    sample_count,
                    dimension: enums::texture_dimension(dimension),
                    format,
                    usage: TextureUsages::from_bits_retain(usage),
                    view_formats: &vf,
                }),
        )
    })
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_texture_create_view(
    texture: Handle,
    format: u32,
    dimension: u32,
    aspect: u32,
    base_mip_level: u32,
    mip_level_count: u32,
    base_array_layer: u32,
    array_layer_count: u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let fmt = if format == 0 {
            None
        } else {
            match enums::texture_format(format) {
                Some(f) => Some(f),
                None => {
                    eprintln!("[wgpu_shim] texture_create_view: invalid format 0x{format:x}");
                    return ptr::null_mut();
                }
            }
        };
        boxed(obj::<Texture>(texture).create_view(&TextureViewDescriptor {
            label: None,
            format: fmt,
            dimension: if dimension == 0 {
                None
            } else {
                Some(enums::texture_view_dimension(dimension))
            },
            usage: None,
            aspect: enums::texture_aspect(aspect),
            base_mip_level,
            mip_level_count: if mip_level_count == u32::MAX {
                None
            } else {
                Some(mip_level_count)
            },
            base_array_layer,
            array_layer_count: if array_layer_count == u32::MAX {
                None
            } else {
                Some(array_layer_count)
            },
        }))
    })
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_queue_write_texture(
    queue: Handle,
    texture: Handle,
    data: *const u8,
    data_size: usize,
    mip_level: u32,
    origin_x: u32,
    origin_y: u32,
    origin_z: u32,
    aspect: u32,
    layout_offset: u64,
    bytes_per_row: u32,
    rows_per_image: u32,
    width: u32,
    height: u32,
    depth: u32,
) {
    ffi!((), unsafe {
        let bytes = flat(data, data_size);
        let dest = TexelCopyTextureInfo {
            texture: obj::<Texture>(texture),
            mip_level,
            origin: Origin3d {
                x: origin_x,
                y: origin_y,
                z: origin_z,
            },
            aspect: if aspect == 0 {
                TextureAspect::All
            } else {
                enums::texture_aspect(aspect)
            },
        };
        let layout = TexelCopyBufferLayout {
            offset: layout_offset,
            bytes_per_row: if bytes_per_row == 0 {
                None
            } else {
                Some(bytes_per_row)
            },
            rows_per_image: Some(if rows_per_image == 0 {
                height
            } else {
                rows_per_image
            }),
        };
        obj::<Queue>(queue).write_texture(
            dest,
            bytes,
            layout,
            Extent3d {
                width,
                height,
                depth_or_array_layers: depth,
            },
        );
    });
}

/// RGBA8 source → upload-layout conversion for copyExternalImageToTexture:
/// copies `copy_row_bytes` per row into the 256-aligned `dst_row_bytes`
/// stride, optionally swapping R<->B (BGRA destinations) and/or
/// premultiplying RGB by alpha. Doing this in JS was an O(w*h) scalar loop
/// on the render thread; here the swizzle compiles to word-level ops.
///
/// `flags`: bit0 = BGRA swap, bit1 = premultiply alpha. Bytes of each
/// destination row past `copy_row_bytes` are left untouched (the JS side
/// allocates the buffer zeroed).
///
/// Returns 0 on success, -1 on a layout/size mismatch (JS falls back).
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_swizzle_image(
    src: *const u8,
    src_len: usize,
    src_row_bytes: u32,
    dst: *mut u8,
    dst_len: usize,
    dst_row_bytes: u32,
    copy_row_bytes: u32,
    height: u32,
    flags: u32,
) -> i32 {
    ffi!(-1, unsafe {
        if src.is_null() || dst.is_null() {
            return -1;
        }
        let src_row = src_row_bytes as usize;
        let dst_row = dst_row_bytes as usize;
        let copy_row = copy_row_bytes as usize;
        let h = height as usize;
        if copy_row % 4 != 0 || copy_row > src_row || copy_row > dst_row {
            return -1;
        }
        if (src_len as usize) < src_row * h || dst_len < dst_row * h {
            return -1;
        }
        let src = std::slice::from_raw_parts(src, src_row * h);
        let dst = std::slice::from_raw_parts_mut(dst, dst_row * h);
        let swap_rb = flags & 1 != 0;
        let premultiply = flags & 2 != 0;
        for y in 0..h {
            let s = &src[y * src_row..y * src_row + copy_row];
            let d = &mut dst[y * dst_row..y * dst_row + copy_row];
            if !swap_rb && !premultiply {
                d.copy_from_slice(s);
            } else if swap_rb && !premultiply {
                // Word-level R<->B swap: for LE u32 R|G<<8|B<<16|A<<24 the
                // BGRA pixel is (v & 0xFF00FF00) | (v << 16 & 0xFF0000) | (v >> 16 & 0xFF).
                for (sp, dp) in s.chunks_exact(4).zip(d.chunks_exact_mut(4)) {
                    let v = u32::from_ne_bytes([sp[0], sp[1], sp[2], sp[3]]);
                    let w = (v & 0xFF00FF00) | ((v & 0xFF) << 16) | ((v >> 16) & 0xFF);
                    dp.copy_from_slice(&w.to_ne_bytes());
                }
            } else {
                for (sp, dp) in s.chunks_exact(4).zip(d.chunks_exact_mut(4)) {
                    let a = sp[3] as u32;
                    // (c*a + 127)/255 == round(c*a/255) for all c,a in 0..=255.
                    let (r, g, b) = if premultiply && a != 255 {
                        (
                            ((sp[0] as u32 * a + 127) / 255) as u8,
                            ((sp[1] as u32 * a + 127) / 255) as u8,
                            ((sp[2] as u32 * a + 127) / 255) as u8,
                        )
                    } else {
                        (sp[0], sp[1], sp[2])
                    };
                    if swap_rb {
                        dp.copy_from_slice(&[b, g, r, sp[3]]);
                    } else {
                        dp.copy_from_slice(&[r, g, b, sp[3]]);
                    }
                }
            }
        }
        0
    })
}

// ── Sampler ──

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_create_sampler(
    device: Handle,
    mag_filter: u32,
    min_filter: u32,
    mipmap_filter: u32,
    address_mode_u: u32,
    address_mode_v: u32,
    address_mode_w: u32,
    lod_min_clamp: f32,
    lod_max_clamp: f32,
    compare: u32,
    max_anisotropy: u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_sampler(&SamplerDescriptor {
                    label: None,
                    address_mode_u: enums::address_mode(address_mode_u),
                    address_mode_v: enums::address_mode(address_mode_v),
                    address_mode_w: enums::address_mode(address_mode_w),
                    mag_filter: enums::filter_mode(mag_filter),
                    min_filter: enums::filter_mode(min_filter),
                    mipmap_filter: enums::mipmap_filter_mode(mipmap_filter),
                    lod_min_clamp,
                    lod_max_clamp,
                    compare: enums::sampler_compare(compare),
                    anisotropy_clamp: (if max_anisotropy == 0 {
                        1
                    } else {
                        max_anisotropy
                    }) as u16,
                    border_color: None,
                }),
        )
    })
}

// ── Bind groups ──
// Layout entries: 11 u32 each [binding, visibility, bufferType, samplerType,
// textureSampleType, textureViewDim, storageAccess, storageFormat,
// hasDynamicOffset, minBindingSizeLo, minBindingSizeHi].
// Exactly one of the type fields is non-zero per entry (0 = BindingNotUsed in
// webgpu.h); a fully-zero entry degrades to an unused uniform-buffer slot,
// mirroring the C zeroed-struct behavior.

#[no_mangle]
pub extern "C" fn wgpu_shim_create_bind_group_layout(
    device: Handle,
    entry_count: u32,
    entries_flat: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let flat = flat(entries_flat, entry_count as usize * 11);
        let mut entries = Vec::with_capacity(entry_count as usize);
        for i in 0..entry_count as usize {
            let e = &flat[i * 11..];
            let ty = if e[6] != 0 {
                let Some(format) = enums::texture_format(e[7]) else {
                    eprintln!(
                        "[wgpu_shim] create_bind_group_layout: invalid storage texture format 0x{:x} (binding {})",
                        e[7], e[0]
                    );
                    return ptr::null_mut();
                };
                BindingType::StorageTexture {
                    access: enums::storage_texture_access(e[6]),
                    format,
                    view_dimension: enums::texture_view_dimension(e[5]),
                }
            } else if e[4] != 0 {
                BindingType::Texture {
                    sample_type: enums::texture_sample_type(e[4]),
                    view_dimension: enums::texture_view_dimension(e[5]),
                    multisampled: false,
                }
            } else if e[3] != 0 {
                BindingType::Sampler(enums::sampler_binding_type(e[3]))
            } else {
                let size = e[9] as u64 | (e[10] as u64) << 32;
                BindingType::Buffer {
                    ty: enums::buffer_binding_type(e[2]),
                    has_dynamic_offset: e[8] != 0,
                    min_binding_size: BufferSize::new(size),
                }
            };
            entries.push(BindGroupLayoutEntry {
                binding: e[0],
                visibility: ShaderStages::from_bits_retain(e[1]),
                ty,
                count: None,
            });
        }
        boxed(obj::<ShimDevice>(device).device.create_bind_group_layout(
            &BindGroupLayoutDescriptor {
                label: None,
                entries: &entries,
            },
        ))
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_create_pipeline_layout(
    device: Handle,
    layout_count: u32,
    layouts: *const Handle,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let ptrs = flat(layouts, layout_count as usize);
        let bgls: Vec<Option<&BindGroupLayout>> = ptrs
            .iter()
            .map(|&p| {
                if p.is_null() {
                    None
                } else {
                    Some(obj::<BindGroupLayout>(p))
                }
            })
            .collect();
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_pipeline_layout(&PipelineLayoutDescriptor {
                    label: None,
                    bind_group_layouts: &bgls,
                    immediate_size: 0,
                }),
        )
    })
}

// Bind group entries: 8 u32 each [binding, resourceType, ptrLo, ptrHi,
// offsetLo, offsetHi, sizeLo, sizeHi]. resourceType: 0=buffer, 1=sampler,
// 2=texture view. size 0 or WHOLE_SIZE → whole buffer (None).
#[no_mangle]
pub extern "C" fn wgpu_shim_create_bind_group(
    device: Handle,
    layout: Handle,
    entry_count: u32,
    entries_flat: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let flat = flat(entries_flat, entry_count as usize * 8);
        let mut entries = Vec::with_capacity(entry_count as usize);
        for i in 0..entry_count as usize {
            let e = &flat[i * 8..];
            let resource = read_ptr(&e[2..4]);
            let offset = e[4] as u64 | (e[5] as u64) << 32;
            let size = e[6] as u64 | (e[7] as u64) << 32;
            let res = match e[1] {
                1 => BindingResource::Sampler(obj::<Sampler>(resource)),
                2 => BindingResource::TextureView(obj::<TextureView>(resource)),
                _ => BindingResource::Buffer(BufferBinding {
                    buffer: obj::<Buffer>(resource),
                    offset,
                    size: if size == 0 || size == WHOLE_SIZE {
                        None
                    } else {
                        std::num::NonZeroU64::new(size)
                    },
                }),
            };
            entries.push(BindGroupEntry {
                binding: e[0],
                resource: res,
            });
        }
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_bind_group(&BindGroupDescriptor {
                    label: None,
                    layout: obj::<BindGroupLayout>(layout),
                    entries: &entries,
                }),
        )
    })
}

// ── Command encoder / submit ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_command_encoder(device: Handle) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        boxed(ShimEncoder(Some(
            obj::<ShimDevice>(device)
                .device
                .create_command_encoder(&CommandEncoderDescriptor::default()),
        )))
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_finish(encoder: Handle) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        match obj_mut::<ShimEncoder>(encoder).0.take() {
            Some(enc) => boxed(ShimCommandBuffer(Some(enc.finish()))),
            None => ptr::null_mut(),
        }
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_queue_submit(
    queue: Handle,
    command_buffers: *const Handle,
    count: u32,
) {
    ffi!((), unsafe {
        let ptrs = flat(command_buffers, count as usize);
        let mut cmds = Vec::with_capacity(ptrs.len());
        for &p in ptrs {
            if let Some(cb) = obj_mut::<ShimCommandBuffer>(p).0.take() {
                cmds.push(cb);
            }
        }
        obj::<Queue>(queue).submit(cmds);
    });
}

// ── Render pass ──
// color attachments: 11 u32 each [viewLo, viewHi, depthSlice(0xFFFFFFFF=undef),
// resolveLo, resolveHi, loadOp, storeOp, r, g, b, a (f32 bit patterns)].
// depth attachment: 10 u32 [viewLo, viewHi, depthLoadOp, depthStoreOp,
// depthClearF32, depthReadOnly, stencilLoadOp, stencilStoreOp,
// stencilClearValue, stencilReadOnly].
// timestamp_writes: 4 u32 [qsLo, qsHi, beginIdx, endIdx] or NULL.

#[no_mangle]
pub extern "C" fn wgpu_shim_begin_render_pass(
    encoder: Handle,
    color_count: u32,
    color_attachments: *const u32,
    depth_attachment: *const u32,
    occlusion_query_set: Handle,
    timestamp_writes: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let n = color_count.min(8) as usize;
        let flat = flat(color_attachments, n * 11);
        let mut atts: Vec<Option<RenderPassColorAttachment>> = Vec::with_capacity(n);
        for i in 0..n {
            let a = &flat[i * 11..];
            let view = read_ptr(a);
            let resolve = read_ptr(&a[3..5]);
            let clear = Color {
                r: f32::from_bits(a[7]) as f64,
                g: f32::from_bits(a[8]) as f64,
                b: f32::from_bits(a[9]) as f64,
                a: f32::from_bits(a[10]) as f64,
            };
            atts.push(Some(RenderPassColorAttachment {
                view: obj::<TextureView>(view),
                depth_slice: if a[2] == 0xFFFF_FFFF {
                    None
                } else {
                    Some(a[2])
                },
                resolve_target: if resolve.is_null() {
                    None
                } else {
                    Some(obj::<TextureView>(resolve))
                },
                ops: Operations {
                    load: enums::load_op(a[5], clear),
                    store: enums::store_op(a[6]),
                },
            }));
        }

        let depth_att = if !depth_attachment.is_null() {
            let d = std::slice::from_raw_parts(depth_attachment, 10);
            let view = read_ptr(d);
            if view.is_null() {
                None
            } else {
                Some(RenderPassDepthStencilAttachment {
                    view: obj::<TextureView>(view),
                    depth_ops: Some(Operations {
                        load: enums::depth_load_op(d[2], f32::from_bits(d[4])),
                        store: enums::store_op(d[3]),
                    }),
                    stencil_ops: Some(Operations {
                        load: enums::stencil_load_op(d[6], d[8]),
                        store: enums::store_op(d[7]),
                    }),
                })
            }
        } else {
            None
        };
        // depth_read_only/stencil_read_only: wgpu crate has no per-pass
        // read-only attachment flag (it's a wgpu-native extension over the
        // spec object) — the C fields are accepted but dropped.

        let ts = if !timestamp_writes.is_null() {
            let t = std::slice::from_raw_parts(timestamp_writes, 4);
            let qs = read_ptr(t);
            obj::<ShimQuerySet>(qs)
                .0
                .as_ref()
                .map(|qs| RenderPassTimestampWrites {
                    query_set: qs,
                    beginning_of_pass_write_index: if t[2] == u32::MAX { None } else { Some(t[2]) },
                    end_of_pass_write_index: if t[3] == u32::MAX { None } else { Some(t[3]) },
                })
        } else {
            None
        };

        let occ = if occlusion_query_set.is_null() {
            None
        } else {
            obj::<ShimQuerySet>(occlusion_query_set).0.as_ref()
        };

        let enc = obj_mut::<ShimEncoder>(encoder).0.as_mut().unwrap();
        let pass = enc
            .begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &atts,
                depth_stencil_attachment: depth_att,
                timestamp_writes: ts,
                occlusion_query_set: occ,
                multiview_mask: None,
            })
            .forget_lifetime();
        boxed(ShimRenderPass(Some(pass)))
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_pipeline(pass: Handle, pipeline: Handle) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.set_pipeline(obj::<RenderPipeline>(pipeline));
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_bind_group(
    pass: Handle,
    group_index: u32,
    bind_group: Handle,
    dynamic_offsets: *const u32,
    dynamic_offset_count: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            let offsets: &[u32] = if dynamic_offsets.is_null() {
                &[]
            } else {
                std::slice::from_raw_parts(dynamic_offsets, dynamic_offset_count as usize)
            };
            p.set_bind_group(group_index, obj::<BindGroup>(bind_group), offsets);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_vertex_buffer(
    pass: Handle,
    slot: u32,
    buffer: Handle,
    offset: u64,
    size: u64,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            let buf = obj::<Buffer>(buffer);
            let slice = if size == WHOLE_SIZE {
                buf.slice(offset..)
            } else {
                buf.slice(offset..offset + size)
            };
            p.set_vertex_buffer(slot, slice);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_index_buffer(
    pass: Handle,
    buffer: Handle,
    format: u32,
    offset: u64,
    size: u64,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            let buf = obj::<Buffer>(buffer);
            let slice = if size == WHOLE_SIZE {
                buf.slice(offset..)
            } else {
                buf.slice(offset..offset + size)
            };
            p.set_index_buffer(slice, enums::index_format(format));
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_draw(
    pass: Handle,
    vertex_count: u32,
    instance_count: u32,
    first_vertex: u32,
    first_instance: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.draw(
                first_vertex..first_vertex + vertex_count,
                first_instance..first_instance + instance_count,
            );
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_draw_indexed(
    pass: Handle,
    index_count: u32,
    instance_count: u32,
    first_index: u32,
    base_vertex: i32,
    first_instance: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.draw_indexed(
                first_index..first_index + index_count,
                base_vertex,
                first_instance..first_instance + instance_count,
            );
        }
    });
}

/// wgpu ends passes on drop — `end` drops the in-box pass; a later
/// `release_render_pass` then just frees the empty box.
#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_end(pass: Handle) {
    ffi!((), unsafe {
        obj_mut::<ShimRenderPass>(pass).0.take();
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_scissor_rect(
    pass: Handle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.set_scissor_rect(x, y, width, height);
        }
    });
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_viewport(
    pass: Handle,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    min_depth: f32,
    max_depth: f32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.set_viewport(x, y, width, height, min_depth, max_depth);
        }
    });
}

// ── Render pipeline ──
// color targets: 9 u32 each [format, hasBlend, colorSrc, colorDst, colorOp,
// alphaSrc, alphaDst, alphaOp, writeMask].
// depth stencil: 16 u32 [format, depthWriteEnabled(OptBool), depthCompare,
// front{compare,fail,depthFail,pass}, back{...}, readMask, writeMask,
// bias(i32 bits), biasSlope(f32 bits), biasClamp(f32 bits)].
// vertex buffers: per-buffer [stride, stepMode, attrCount] then attrCount ×
// [format, offset, shaderLocation].

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_create_render_pipeline(
    device: Handle,
    vertex_shader: Handle,
    vertex_entry: *const c_char,
    fragment_shader: Handle,
    fragment_entry: *const c_char,
    color_target_count: u32,
    color_targets: *const u32,
    depth_stencil: *const u32,
    topology: u32,
    strip_index_format: u32,
    sample_count: u32,
    layout: Handle,
    cull_mode: u32,
    front_face: u32,
    vertex_buffer_count: u32,
    vertex_buffer_data: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        // Vertex buffers — walked linearly, same as the C cursor loop.
        let mut vb_layouts: Vec<VertexBufferLayout> = Vec::new();
        let mut vb_attrs: Vec<Vec<VertexAttribute>> = Vec::new();
        let mut cursor = vertex_buffer_data;
        for _ in 0..vertex_buffer_count.min(8) {
            let attr_count = *cursor.add(2);
            cursor = cursor.add(3);
            let mut attrs = Vec::with_capacity(attr_count as usize);
            for _ in 0..attr_count {
                attrs.push(VertexAttribute {
                    format: enums::vertex_format(*cursor),
                    offset: *cursor.add(1) as u64,
                    shader_location: *cursor.add(2),
                });
                cursor = cursor.add(3);
            }
            vb_attrs.push(attrs);
        }
        // Second pass to build layouts borrowing the attr vecs.
        cursor = vertex_buffer_data;
        for b in 0..vb_attrs.len() {
            let array_stride = *cursor;
            let step_mode = *cursor.add(1);
            let attr_count = *cursor.add(2);
            cursor = cursor.add(3 + attr_count as usize * 3);
            vb_layouts.push(VertexBufferLayout {
                array_stride: array_stride as u64,
                step_mode: if step_mode == 1 {
                    VertexStepMode::Instance
                } else {
                    VertexStepMode::Vertex
                },
                attributes: &vb_attrs[b],
            });
        }

        let ventry = cstr(vertex_entry);
        let fentry = cstr(fragment_entry);
        let vertex_state = VertexState {
            module: obj::<ShaderModule>(vertex_shader),
            entry_point: Some(&ventry),
            compilation_options: PipelineCompilationOptions::default(),
            buffers: &vb_layouts,
        };

        // Color targets (max 8 MRT), blend states kept alongside.
        let nt = color_target_count.min(8) as usize;
        let mut targets: Vec<Option<ColorTargetState>> = Vec::with_capacity(nt);
        let mut fragment_state = None;
        if !fragment_shader.is_null() && nt > 0 {
            let flat = std::slice::from_raw_parts(color_targets, nt * 9);
            for i in 0..nt {
                let t = &flat[i * 9..];
                let Some(format) = enums::texture_format(t[0]) else {
                    eprintln!(
                        "[wgpu_shim] create_render_pipeline: invalid color target format 0x{:x} at index {i}",
                        t[0]
                    );
                    return ptr::null_mut();
                };
                let blend = if t[1] != 0 {
                    Some(BlendState {
                        color: BlendComponent {
                            src_factor: enums::blend_factor(t[2]),
                            dst_factor: enums::blend_factor(t[3]),
                            operation: enums::blend_operation(t[4]),
                        },
                        alpha: BlendComponent {
                            src_factor: enums::blend_factor(t[5]),
                            dst_factor: enums::blend_factor(t[6]),
                            operation: enums::blend_operation(t[7]),
                        },
                    })
                } else {
                    None
                };
                targets.push(Some(ColorTargetState {
                    format,
                    blend,
                    write_mask: if t[8] != 0 {
                        ColorWrites::from_bits_retain(t[8])
                    } else {
                        ColorWrites::ALL
                    },
                }));
            }
            fragment_state = Some(FragmentState {
                module: obj::<ShaderModule>(fragment_shader),
                entry_point: Some(&fentry),
                compilation_options: PipelineCompilationOptions::default(),
                targets: &targets,
            });
        }

        let depth_stencil_state = if !depth_stencil.is_null() && *depth_stencil != 0 {
            let ds = std::slice::from_raw_parts(depth_stencil, 16);
            let Some(format) = enums::texture_format(ds[0]) else {
                eprintln!(
                    "[wgpu_shim] create_render_pipeline: invalid depth format 0x{:x}",
                    ds[0]
                );
                return ptr::null_mut();
            };
            let face = |base: usize| StencilFaceState {
                compare: if ds[base] != 0 {
                    enums::compare_function(ds[base])
                } else {
                    CompareFunction::Always
                },
                fail_op: if ds[base + 1] != 0 {
                    enums::stencil_operation(ds[base + 1])
                } else {
                    StencilOperation::Keep
                },
                depth_fail_op: if ds[base + 2] != 0 {
                    enums::stencil_operation(ds[base + 2])
                } else {
                    StencilOperation::Keep
                },
                pass_op: if ds[base + 3] != 0 {
                    enums::stencil_operation(ds[base + 3])
                } else {
                    StencilOperation::Keep
                },
            };
            Some(DepthStencilState {
                format,
                // OptionalBool: 0=False, 1=True, 2=Undefined→True (wgpu-native
                // panics on Undefined-with-depth; C defaulted to True).
                depth_write_enabled: Some(ds[1] != 0),
                depth_compare: Some(if ds[2] != 0 {
                    enums::compare_function(ds[2])
                } else {
                    CompareFunction::Less
                }),
                stencil: StencilState {
                    front: face(3),
                    back: face(7),
                    read_mask: if ds[11] != 0 { ds[11] } else { 0xFFFF_FFFF },
                    write_mask: if ds[12] != 0 { ds[12] } else { 0xFFFF_FFFF },
                },
                bias: DepthBiasState {
                    constant: ds[13] as i32,
                    slope_scale: f32::from_bits(ds[14]),
                    clamp: f32::from_bits(ds[15]),
                },
            })
        } else {
            None
        };

        let desc = RenderPipelineDescriptor {
            label: None,
            layout: if layout.is_null() {
                None
            } else {
                Some(obj::<PipelineLayout>(layout))
            },
            vertex: vertex_state,
            fragment: fragment_state,
            primitive: PrimitiveState {
                topology: enums::primitive_topology(topology),
                strip_index_format: enums::strip_index_format(strip_index_format),
                front_face: if front_face == 0 {
                    FrontFace::Ccw
                } else {
                    enums::front_face(front_face)
                },
                cull_mode: if cull_mode == 0 {
                    None
                } else {
                    enums::cull_mode(cull_mode)
                },
                unclipped_depth: false,
                polygon_mode: PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: depth_stencil_state,
            multisample: MultisampleState {
                count: sample_count,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview_mask: None,
            cache: None,
        };
        boxed(
            obj::<ShimDevice>(device)
                .device
                .create_render_pipeline(&desc),
        )
    })
}

// ── Compute pipeline ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_compute_pipeline(
    device: Handle,
    shader: Handle,
    entry_point: *const c_char,
    layout: Handle,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let entry = cstr(entry_point);
        boxed(obj::<ShimDevice>(device).device.create_compute_pipeline(
            &ComputePipelineDescriptor {
                label: None,
                layout: if layout.is_null() {
                    None
                } else {
                    Some(obj::<PipelineLayout>(layout))
                },
                module: obj::<ShaderModule>(shader),
                entry_point: Some(&entry),
                compilation_options: PipelineCompilationOptions::default(),
                cache: None,
            },
        ))
    })
}

// ── Compute pass ──
// timestamp_writes: 4 u32 [qsLo, qsHi, beginIdx, endIdx] or NULL.

#[no_mangle]
pub extern "C" fn wgpu_shim_begin_compute_pass(
    encoder: Handle,
    timestamp_writes: *const u32,
) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        let ts = if !timestamp_writes.is_null() {
            let t = std::slice::from_raw_parts(timestamp_writes, 4);
            let qs = read_ptr(t);
            obj::<ShimQuerySet>(qs)
                .0
                .as_ref()
                .map(|qs| ComputePassTimestampWrites {
                    query_set: qs,
                    beginning_of_pass_write_index: if t[2] == u32::MAX { None } else { Some(t[2]) },
                    end_of_pass_write_index: if t[3] == u32::MAX { None } else { Some(t[3]) },
                })
        } else {
            None
        };
        let enc = obj_mut::<ShimEncoder>(encoder).0.as_mut().unwrap();
        let pass = enc
            .begin_compute_pass(&ComputePassDescriptor {
                label: None,
                timestamp_writes: ts,
            })
            .forget_lifetime();
        boxed(ShimComputePass(Some(pass)))
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_set_pipeline(pass: Handle, pipeline: Handle) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimComputePass>(pass).0.as_mut() {
            p.set_pipeline(obj::<ComputePipeline>(pipeline));
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_set_bind_group(
    pass: Handle,
    group_index: u32,
    bind_group: Handle,
    dynamic_offsets: *const u32,
    dynamic_offset_count: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimComputePass>(pass).0.as_mut() {
            let offsets: &[u32] = if dynamic_offsets.is_null() {
                &[]
            } else {
                std::slice::from_raw_parts(dynamic_offsets, dynamic_offset_count as usize)
            };
            p.set_bind_group(group_index, obj::<BindGroup>(bind_group), offsets);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_dispatch(pass: Handle, x: u32, y: u32, z: u32) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimComputePass>(pass).0.as_mut() {
            p.dispatch_workgroups(x, y, z);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_end(pass: Handle) {
    ffi!((), unsafe {
        obj_mut::<ShimComputePass>(pass).0.take();
    });
}

/// Inside-pass timestamp writes — require TIMESTAMP_QUERY_INSIDE_PASSES on
/// the device (the host requests it when the adapter supports it and the
/// device isn't a software rasterizer).
#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_write_timestamp(
    pass: Handle,
    query_set: Handle,
    query_index: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            if let Some(qs) = obj::<ShimQuerySet>(query_set).0.as_ref() {
                p.write_timestamp(qs, query_index);
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_write_timestamp(
    pass: Handle,
    query_set: Handle,
    query_index: u32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimComputePass>(pass).0.as_mut() {
            if let Some(qs) = obj::<ShimQuerySet>(query_set).0.as_ref() {
                p.write_timestamp(qs, query_index);
            }
        }
    });
}

// ── Copies ──

unsafe fn tex_copy_info<'a>(
    texture: Handle,
    mip: u32,
    x: u32,
    y: u32,
    z: u32,
    aspect: u32,
) -> TexelCopyTextureInfo<'a> {
    TexelCopyTextureInfo {
        texture: obj::<Texture>(texture),
        mip_level: mip,
        origin: Origin3d { x, y, z },
        aspect: if aspect == 0 {
            TextureAspect::All
        } else {
            enums::texture_aspect(aspect)
        },
    }
}

unsafe fn buf_copy_info<'a>(
    buffer: Handle,
    offset: u64,
    bpr: u32,
    rpi: u32,
) -> TexelCopyBufferInfo<'a> {
    TexelCopyBufferInfo {
        buffer: obj::<Buffer>(buffer),
        layout: TexelCopyBufferLayout {
            offset,
            bytes_per_row: if bpr == 0 { None } else { Some(bpr) },
            rows_per_image: if rpi == 0 { None } else { Some(rpi) },
        },
    }
}

#[no_mangle]
pub extern "C" fn wgpu_shim_copy_buffer_to_buffer(
    encoder: Handle,
    src: Handle,
    src_offset: u64,
    dst: Handle,
    dst_offset: u64,
    size: u64,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            e.copy_buffer_to_buffer(
                obj::<Buffer>(src),
                src_offset,
                obj::<Buffer>(dst),
                dst_offset,
                size,
            );
        }
    });
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_copy_texture_to_buffer(
    encoder: Handle,
    src_texture: Handle,
    src_mip_level: u32,
    src_origin_x: u32,
    src_origin_y: u32,
    src_origin_z: u32,
    src_aspect: u32,
    dst_buffer: Handle,
    dst_offset: u64,
    dst_bytes_per_row: u32,
    dst_rows_per_image: u32,
    copy_w: u32,
    copy_h: u32,
    copy_d: u32,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            let src = tex_copy_info(
                src_texture,
                src_mip_level,
                src_origin_x,
                src_origin_y,
                src_origin_z,
                src_aspect,
            );
            let dst = TexelCopyBufferInfo {
                buffer: obj::<Buffer>(dst_buffer),
                layout: TexelCopyBufferLayout {
                    offset: dst_offset,
                    bytes_per_row: if dst_bytes_per_row == 0 {
                        None
                    } else {
                        Some(dst_bytes_per_row)
                    },
                    rows_per_image: Some(if dst_rows_per_image == 0 {
                        copy_h
                    } else {
                        dst_rows_per_image
                    }),
                },
            };
            e.copy_texture_to_buffer(
                src,
                dst,
                Extent3d {
                    width: copy_w,
                    height: copy_h,
                    depth_or_array_layers: copy_d,
                },
            );
        }
    });
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_copy_buffer_to_texture(
    encoder: Handle,
    src_buffer: Handle,
    src_offset: u64,
    src_bytes_per_row: u32,
    src_rows_per_image: u32,
    dst_texture: Handle,
    dst_mip_level: u32,
    dst_origin_x: u32,
    dst_origin_y: u32,
    dst_origin_z: u32,
    dst_aspect: u32,
    copy_w: u32,
    copy_h: u32,
    copy_d: u32,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            let src = buf_copy_info(
                src_buffer,
                src_offset,
                src_bytes_per_row,
                src_rows_per_image,
            );
            let dst = tex_copy_info(
                dst_texture,
                dst_mip_level,
                dst_origin_x,
                dst_origin_y,
                dst_origin_z,
                dst_aspect,
            );
            e.copy_buffer_to_texture(
                src,
                dst,
                Extent3d {
                    width: copy_w,
                    height: copy_h,
                    depth_or_array_layers: copy_d,
                },
            );
        }
    });
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn wgpu_shim_copy_texture_to_texture(
    encoder: Handle,
    src_texture: Handle,
    src_mip_level: u32,
    src_origin_x: u32,
    src_origin_y: u32,
    src_origin_z: u32,
    src_aspect: u32,
    dst_texture: Handle,
    dst_mip_level: u32,
    dst_origin_x: u32,
    dst_origin_y: u32,
    dst_origin_z: u32,
    dst_aspect: u32,
    copy_w: u32,
    copy_h: u32,
    copy_d: u32,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            let src = tex_copy_info(
                src_texture,
                src_mip_level,
                src_origin_x,
                src_origin_y,
                src_origin_z,
                src_aspect,
            );
            let dst = tex_copy_info(
                dst_texture,
                dst_mip_level,
                dst_origin_x,
                dst_origin_y,
                dst_origin_z,
                dst_aspect,
            );
            e.copy_texture_to_texture(
                src,
                dst,
                Extent3d {
                    width: copy_w,
                    height: copy_h,
                    depth_or_array_layers: copy_d,
                },
            );
        }
    });
}

// ── Query sets ──

#[no_mangle]
pub extern "C" fn wgpu_shim_create_query_set(device: Handle, ty: u32, count: u32) -> Handle {
    ffi!(ptr::null_mut(), unsafe {
        boxed(ShimQuerySet(Some(
            obj::<ShimDevice>(device)
                .device
                .create_query_set(&QuerySetDescriptor {
                    label: None,
                    ty: enums::query_type(ty),
                    count,
                }),
        )))
    })
}

/// wgpu has no explicit query-set destroy — dropping is the destroy.
#[no_mangle]
pub extern "C" fn wgpu_shim_destroy_query_set(query_set: Handle) {
    ffi!((), unsafe {
        drop(obj_mut::<ShimQuerySet>(query_set).0.take())
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_write_timestamp(
    encoder: Handle,
    query_set: Handle,
    query_index: u32,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            if let Some(qs) = obj::<ShimQuerySet>(query_set).0.as_ref() {
                e.write_timestamp(qs, query_index);
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_resolve_query_set(
    encoder: Handle,
    query_set: Handle,
    first_query: u32,
    query_count: u32,
    dest_buffer: Handle,
    dest_offset: u64,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            if let Some(qs) = obj::<ShimQuerySet>(query_set).0.as_ref() {
                e.resolve_query_set(
                    qs,
                    first_query..first_query + query_count,
                    obj::<Buffer>(dest_buffer),
                    dest_offset,
                );
            }
        }
    });
}

// ── Indirect draws ──

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_draw_indirect(pass: Handle, buffer: Handle, offset: u64) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.draw_indirect(obj::<Buffer>(buffer), offset);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_draw_indexed_indirect(
    pass: Handle,
    buffer: Handle,
    offset: u64,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.draw_indexed_indirect(obj::<Buffer>(buffer), offset);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_compute_pass_dispatch_indirect(
    pass: Handle,
    buffer: Handle,
    offset: u64,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimComputePass>(pass).0.as_mut() {
            p.dispatch_workgroups_indirect(obj::<Buffer>(buffer), offset);
        }
    });
}

// ── Clear buffer / blend constant / stencil ref / occlusion ──

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_clear_buffer(
    encoder: Handle,
    buffer: Handle,
    offset: u64,
    size: u64,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            e.clear_buffer(
                obj::<Buffer>(buffer),
                offset,
                if size == WHOLE_SIZE { None } else { Some(size) },
            );
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_blend_constant(
    pass: Handle,
    r: f32,
    g: f32,
    b: f32,
    a: f32,
) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.set_blend_constant(Color {
                r: r as f64,
                g: g as f64,
                b: b as f64,
                a: a as f64,
            });
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_set_stencil_reference(pass: Handle, reference: u32) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.set_stencil_reference(reference);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_begin_occlusion_query(pass: Handle, query_index: u32) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.begin_occlusion_query(query_index);
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_render_pass_end_occlusion_query(pass: Handle) {
    ffi!((), unsafe {
        if let Some(p) = obj_mut::<ShimRenderPass>(pass).0.as_mut() {
            p.end_occlusion_query();
        }
    });
}

// ── Debug groups / markers ──

macro_rules! debug_label_fns {
    ($push:ident, $pop:ident, $marker:ident, $ty:ident, $wpush:ident, $wpop:ident, $wmarker:ident) => {
        #[no_mangle]
        pub extern "C" fn $push(pass: Handle, label: *const c_char) {
            ffi!((), unsafe {
                if let Some(p) = obj_mut::<$ty>(pass).0.as_mut() {
                    p.$wpush(&cstr(label));
                }
            });
        }
        #[no_mangle]
        pub extern "C" fn $pop(pass: Handle) {
            ffi!((), unsafe {
                if let Some(p) = obj_mut::<$ty>(pass).0.as_mut() {
                    p.$wpop();
                }
            });
        }
        #[no_mangle]
        pub extern "C" fn $marker(pass: Handle, label: *const c_char) {
            ffi!((), unsafe {
                if let Some(p) = obj_mut::<$ty>(pass).0.as_mut() {
                    p.$wmarker(&cstr(label));
                }
            });
        }
    };
}

debug_label_fns!(
    wgpu_shim_render_pass_push_debug_group,
    wgpu_shim_render_pass_pop_debug_group,
    wgpu_shim_render_pass_insert_debug_marker,
    ShimRenderPass,
    push_debug_group,
    pop_debug_group,
    insert_debug_marker
);
debug_label_fns!(
    wgpu_shim_compute_pass_push_debug_group,
    wgpu_shim_compute_pass_pop_debug_group,
    wgpu_shim_compute_pass_insert_debug_marker,
    ShimComputePass,
    push_debug_group,
    pop_debug_group,
    insert_debug_marker
);

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_push_debug_group(
    encoder: Handle,
    label: *const c_char,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            e.push_debug_group(&cstr(label));
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_pop_debug_group(encoder: Handle) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            e.pop_debug_group();
        }
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_command_encoder_insert_debug_marker(
    encoder: Handle,
    label: *const c_char,
) {
    ffi!((), unsafe {
        if let Some(e) = obj_mut::<ShimEncoder>(encoder).0.as_mut() {
            e.insert_debug_marker(&cstr(label));
        }
    });
}

// ── Error scopes ──

#[no_mangle]
pub extern "C" fn wgpu_shim_device_push_error_scope(device: Handle, filter: u32) {
    ffi!((), unsafe {
        let guard = obj::<ShimDevice>(device)
            .device
            .push_error_scope(enums::error_filter(filter));
        ERROR_SCOPES.with(|s| {
            s.borrow_mut()
                .entry(device as usize)
                .or_default()
                .push(guard);
        });
    });
}

/// Returns WGPUErrorType (1=NoError … 5=Unknown); 0 only on a popped-empty
/// stack. Message copied into out_msg.
#[no_mangle]
pub extern "C" fn wgpu_shim_device_pop_error_scope(
    device: Handle,
    out_msg: *mut c_char,
    out_msg_size: i32,
) -> u32 {
    ffi!(0, unsafe {
        let guard = ERROR_SCOPES.with(|s| {
            s.borrow_mut()
                .get_mut(&(device as usize))
                .and_then(|v| v.pop())
        });
        let Some(guard) = guard else {
            return 0;
        };
        // Drive the pop future to completion while pumping the instance —
        // same spin as the C shim's wgpuInstanceProcessEvents loop.
        let result = block_on_gpu(guard.pop());
        match result {
            Some(None) => 1, // NoError
            Some(Some(e)) => {
                if !out_msg.is_null() && out_msg_size > 0 {
                    let msg = e.to_string();
                    let bytes = msg.as_bytes();
                    let n = bytes.len().min(out_msg_size as usize - 1);
                    ptr::copy_nonoverlapping(bytes.as_ptr(), out_msg as *mut u8, n);
                    *out_msg.add(n) = 0;
                }
                enums::error_type(&e)
            }
            // Timed out waiting for the GPU — report an internal error with
            // a synthetic message rather than wedging the caller.
            None => {
                if !out_msg.is_null() && out_msg_size > 0 {
                    let msg = b"pop_error_scope timed out (GPU queue hung or device lost)";
                    let n = msg.len().min(out_msg_size as usize - 1);
                    ptr::copy_nonoverlapping(msg.as_ptr(), out_msg as *mut u8, n);
                    *out_msg.add(n) = 0;
                }
                4 // Internal
            }
        }
    })
}

// ── Limits / features ──

#[no_mangle]
pub extern "C" fn wgpu_shim_adapter_get_limits(adapter: Handle, out_buffer: *mut u8) -> i32 {
    ffi!(1, unsafe {
        let limits = obj::<Adapter>(adapter).limits();
        let buf = std::slice::from_raw_parts_mut(out_buffer, 8 + 36 * 4);
        buf.fill(0);
        enums::write_limits(&limits, buf);
        0
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_device_get_limits(device: Handle, out_buffer: *mut u8) -> i32 {
    ffi!(1, unsafe {
        let limits = obj::<ShimDevice>(device).device.limits();
        let buf = std::slice::from_raw_parts_mut(out_buffer, 8 + 36 * 4);
        buf.fill(0);
        enums::write_limits(&limits, buf);
        0
    })
}

fn write_features(features: Features, out: *mut u32, max_count: u32) -> u32 {
    let wire = enums::features_to_wire(features);
    if !out.is_null() && max_count > 0 {
        let dst = unsafe { std::slice::from_raw_parts_mut(out, max_count as usize) };
        let n = wire.len().min(dst.len());
        dst[..n].copy_from_slice(&wire[..n]);
    }
    wire.len() as u32
}

#[no_mangle]
pub extern "C" fn wgpu_shim_adapter_get_features(adapter: Handle, out: *mut u32, max: u32) -> u32 {
    ffi!(0, unsafe {
        write_features(obj::<Adapter>(adapter).features(), out, max)
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_device_get_features(device: Handle, out: *mut u32, max: u32) -> u32 {
    ffi!(0, unsafe {
        write_features(obj::<ShimDevice>(device).device.features(), out, max)
    })
}

fn json_escape(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Serializes wgpu::AdapterInfo as JSON into out_buf (NUL-terminated).
/// Returns bytes written excluding NUL; 0 on failure or too-small buffer.
/// Callers pass a fixed buffer — info strings are short (<< 1 KiB).
#[no_mangle]
pub extern "C" fn wgpu_shim_adapter_get_info(
    adapter: Handle,
    out_buf: *mut c_char,
    out_size: i32,
) -> i32 {
    ffi!(0, unsafe {
        if out_buf.is_null() || out_size <= 0 {
            return 0;
        }
        let info = obj::<Adapter>(adapter).get_info();
        let device_type = match info.device_type {
            DeviceType::IntegratedGpu => "integrated-gpu",
            DeviceType::DiscreteGpu => "discrete-gpu",
            DeviceType::VirtualGpu => "virtual-gpu",
            DeviceType::Cpu => "cpu",
            _ => "other",
        };
        let backend = format!("{:?}", info.backend).to_lowercase();
        let (mut name, mut driver, mut driver_info) = (String::new(), String::new(), String::new());
        json_escape(&info.name, &mut name);
        json_escape(&info.driver, &mut driver);
        json_escape(&info.driver_info, &mut driver_info);
        let json = format!(
            "{{\"name\":{name},\"vendor\":{},\"device\":{},\"deviceType\":\"{device_type}\",\"backend\":\"{backend}\",\"driver\":{driver},\"driverInfo\":{driver_info}}}",
            info.vendor, info.device,
        );
        let bytes = json.as_bytes();
        if out_size as usize <= bytes.len() {
            return 0;
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf as *mut u8, bytes.len());
        *out_buf.add(bytes.len()) = 0;
        bytes.len() as i32
    })
}

// ── Queue onSubmittedWorkDone ──

#[no_mangle]
pub extern "C" fn wgpu_shim_queue_on_submitted_work_done(queue: Handle) {
    ffi!((), unsafe {
        let (tx, rx) = std::sync::mpsc::channel();
        obj::<Queue>(queue).on_submitted_work_done(move || {
            let _ = tx.send(());
        });
        pump_until(&rx);
    });
}

// ── Surface ──

/// Created by sdl_shim_create_wgpu_surface (window/mod.rs) via
/// [`create_surface_for_window`].
pub(crate) fn create_surface_for_window(
    instance: Handle,
    window: std::sync::Arc<winit::window::Window>,
) -> Handle {
    if instance.is_null() {
        return ptr::null_mut();
    }
    #[cfg(target_os = "android")]
    {
        use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
        let wh = window.window_handle().map(|h| h.as_raw());
        let dh = window.display_handle().map(|h| h.as_raw());
        eprintln!("[wgpu_shim] create_surface: window_handle={wh:?} display_handle={dh:?}");
        android_segv_probe::install();
    }
    let instance = unsafe { obj::<Instance>(instance) };
    match instance.create_surface(window) {
        Ok(s) => boxed(s),
        Err(e) => {
            eprintln!("[wgpu_shim] surface creation failed: {e}");
            ptr::null_mut()
        }
    }
}

/// One-shot SIGSEGV reporter (diagnostic): logs si_addr/si_code for faults
/// inside the wgpu surface-creation call, then re-raises as SIG_DFL.
#[cfg(target_os = "android")]
mod android_segv_probe {
    use std::ffi::{c_char, c_int};

    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    unsafe extern "C" fn handler(sig: c_int, info: *mut libc::siginfo_t, ctx: *mut libc::c_void) {
        let code = unsafe { (*info).si_code };
        let addr = unsafe { (*info).si_addr() } as usize;
        // ucontext_t → uc_mcontext (arch layout differs: arm64 has
        // pc/sp/regs[], x86_64 a gregs[] array indexed by REG_*).
        let (pc, sp, x1) = unsafe {
            let uc = ctx as *const libc::ucontext_t;
            let mc = &(*uc).uc_mcontext;
            #[cfg(target_arch = "aarch64")]
            { (mc.pc as usize, mc.sp as usize, mc.regs[1] as usize) }
            #[cfg(target_arch = "x86_64")]
            { (mc.gregs[libc::REG_RIP as usize] as usize, mc.gregs[libc::REG_RSP as usize] as usize, mc.gregs[libc::REG_RDI as usize] as usize) }
        };
        // Async-signal-unsafe formatting is fine — we re-raise and die anyway.
        let msg = std::ffi::CString::new(format!(
            "segv probe: sig={sig} code={code} addr={addr:#x} pc={pc:#x} sp={sp:#x} x1={x1:#x}"
        ))
        .unwrap();
        unsafe {
            __android_log_write(6, c"downdraft".as_ptr(), msg.as_ptr());
            libc::signal(sig, libc::SIG_DFL);
            libc::raise(sig);
        }
    }

    pub(super) fn install() {
        unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = handler as usize;
            sa.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND;
            libc::sigemptyset(&mut sa.sa_mask);
            libc::sigaction(libc::SIGSEGV, &sa, std::ptr::null_mut());
        }
    }
}

#[no_mangle]
pub extern "C" fn wgpu_shim_surface_configure(
    surface: Handle,
    device: Handle,
    format: u32,
    usage: u32,
    width: u32,
    height: u32,
    present_mode: u32,
) {
    ffi!((), unsafe {
        let Some(format) = enums::texture_format(format) else {
            eprintln!("[wgpu_shim] surface_configure: invalid texture format 0x{format:x}");
            return;
        };
        // Drop any stashed frame first — configure() panics while a
        // SurfaceTexture is alive.
        G_SURFACE_TEXTURES
            .lock()
            .unwrap()
            .remove(&(surface as usize));
        obj::<Surface>(surface).configure(
            &obj::<ShimDevice>(device).device,
            &SurfaceConfiguration {
                usage: TextureUsages::from_bits_retain(usage),
                format,
                // Transient 0-size windows must never reach the HAL (same
                // guard as the C shim).
                width: width.max(1),
                height: height.max(1),
                present_mode: enums::present_mode(present_mode),
                desired_maximum_frame_latency: 2,
                alpha_mode: CompositeAlphaMode::Auto,
                view_formats: vec![],
            },
        );
        // Only reachable when configure() didn't panic — a panicked
        // configure leaves the surface unconfigured and the acquire guard
        // below keeps it out of wgpu.
        G_CONFIGURED_SURFACES
            .lock()
            .unwrap()
            .insert(surface as usize);
    });
}

/// WGPUSurfaceGetCurrentTextureStatus values: SuccessOptimal=1,
/// SuccessSuboptimal=2, Timeout=3, Outdated=4, Lost=5, Error=6,
/// Occluded=0x30001 (native ext). *texture_out receives a Texture handle.
#[no_mangle]
pub extern "C" fn wgpu_shim_surface_get_current_texture(
    surface: Handle,
    texture_out: *mut Handle,
) -> i32 {
    ffi!(6, unsafe {
        if !texture_out.is_null() {
            *texture_out = ptr::null_mut();
        }
        // wgpu panics on get_current_texture for a never-configured (or
        // failed-configure) surface. Check our own bookkeeping first and
        // report Error instead of unwinding through the panic hook.
        if !G_CONFIGURED_SURFACES
            .lock()
            .unwrap()
            .contains(&(surface as usize))
        {
            return 6;
        }
        let result = obj::<Surface>(surface).get_current_texture();
        let (st, status) = match result {
            CurrentSurfaceTexture::Success(st) => (Some(st), 1),
            CurrentSurfaceTexture::Suboptimal(st) => (Some(st), 2),
            CurrentSurfaceTexture::Timeout => (None, 3),
            CurrentSurfaceTexture::Outdated => (None, 4),
            CurrentSurfaceTexture::Lost => (None, 5),
            CurrentSurfaceTexture::Occluded => (None, 0x0003_0001),
            _ => (None, 6), // Validation and anything new
        };
        if let Some(st) = st {
            if !texture_out.is_null() {
                *texture_out = boxed(st.texture.clone());
            }
            G_SURFACE_TEXTURES
                .lock()
                .unwrap()
                .insert(surface as usize, st);
        }
        status
    })
}

#[no_mangle]
pub extern "C" fn wgpu_shim_surface_present(surface: Handle) {
    ffi!((), {
        if let Some(st) = G_SURFACE_TEXTURES
            .lock()
            .unwrap()
            .remove(&(surface as usize))
        {
            st.present();
        }
    });
}

/// wgpu's Surface has no public unconfigure — the config is dropped when the
/// surface is released, and a later configure() replaces it. The one hazard
/// (configure panicking while a frame is held) is handled in
/// surface_configure.
#[no_mangle]
pub extern "C" fn wgpu_shim_surface_unconfigure(surface: Handle) {
    ffi!((), {
        G_SURFACE_TEXTURES
            .lock()
            .unwrap()
            .remove(&(surface as usize));
        G_CONFIGURED_SURFACES
            .lock()
            .unwrap()
            .remove(&(surface as usize));
    });
}

/// WGPUTextureFormat_BGRA8Unorm = 27.
#[no_mangle]
pub extern "C" fn wgpu_shim_get_preferred_format() -> u32 {
    ffi!(27, { 27 })
}

/// Pick a surface-supported format: returns the first `candidates` entry
/// present in `surface.get_capabilities(adapter).formats`, else the caps'
/// own first format (wgpu's preferred ordering), else 0. The global
/// `get_preferred_format` bakes the desktop default (Bgra8) — Android
/// surfaces commonly offer only Rgba variants, so configure must pick
/// from the actual caps or validation rejects it.
#[no_mangle]
pub extern "C" fn wgpu_shim_surface_pick_format(
    surface: Handle,
    adapter: Handle,
    candidates: *const u32,
    count: usize,
) -> u32 {
    ffi!(0, unsafe {
        if adapter.is_null() {
            eprintln!("[wgpu_shim] surface_pick_format: null adapter");
            return 0;
        }
        let caps = obj::<Surface>(surface).get_capabilities(obj::<Adapter>(adapter));
        for i in 0..count {
            let code = *candidates.add(i);
            if let Some(f) = enums::texture_format(code) {
                if caps.formats.contains(&f) {
                    return code;
                }
            }
        }
        // No candidate matched — report the surface's own first choice. The
        // enum table has no reverse map, so scan the code space for the
        // format (called once per surface, so the linear scan is fine).
        match caps.formats.first() {
            Some(f) => (0u32..1024)
                .find(|c| enums::texture_format(*c) == Some(*f))
                .unwrap_or(0),
            None => 0,
        }
    })
}

// ── Release ──

macro_rules! release_fn {
    ($name:ident, $ty:ty) => {
        #[no_mangle]
        pub extern "C" fn $name(p: Handle) {
            ffi!((), unsafe { release::<$ty>(p) });
        }
    };
}

release_fn!(wgpu_shim_release_buffer, Buffer);
release_fn!(wgpu_shim_release_texture, Texture);
release_fn!(wgpu_shim_release_texture_view, TextureView);
release_fn!(wgpu_shim_release_sampler, Sampler);
release_fn!(wgpu_shim_release_bind_group, BindGroup);
release_fn!(wgpu_shim_release_bind_group_layout, BindGroupLayout);
release_fn!(wgpu_shim_release_pipeline_layout, PipelineLayout);
release_fn!(wgpu_shim_release_render_pipeline, RenderPipeline);
release_fn!(wgpu_shim_release_compute_pipeline, ComputePipeline);
release_fn!(wgpu_shim_release_shader_module, ShaderModule);
release_fn!(wgpu_shim_release_command_buffer, ShimCommandBuffer);
release_fn!(wgpu_shim_release_command_encoder, ShimEncoder);
release_fn!(wgpu_shim_release_adapter, Adapter);
release_fn!(wgpu_shim_release_render_pass, ShimRenderPass);
release_fn!(wgpu_shim_release_compute_pass, ShimComputePass);
release_fn!(wgpu_shim_release_queue, Queue);
release_fn!(wgpu_shim_release_query_set, ShimQuerySet);

#[no_mangle]
pub extern "C" fn wgpu_shim_release_device(p: Handle) {
    ffi!((), unsafe { release::<ShimDevice>(p) });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_release_instance(p: Handle) {
    ffi!((), unsafe {
        release::<Instance>(p);
        G_INSTANCES
            .lock()
            .unwrap()
            .retain(|(h, _)| *h != p as usize);
    });
}

#[no_mangle]
pub extern "C" fn wgpu_shim_release_surface(p: Handle) {
    ffi!((), unsafe {
        G_SURFACE_TEXTURES.lock().unwrap().remove(&(p as usize));
        G_CONFIGURED_SURFACES.lock().unwrap().remove(&(p as usize));
        release::<Surface>(p);
    });
}
