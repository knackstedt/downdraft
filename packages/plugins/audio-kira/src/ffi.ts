export interface AudioLib {
  init(sampleRate: number, bufferSize: number): number;
  destroy(): number;
  loadBuffer(data: Uint8Array, format: number): number;
  unloadBuffer(bufferId: number): number;
  play(bufferId: number, loop: number, volume: number): number;
  stop(soundId: number): number;
  pause(soundId: number): number;
  resume(soundId: number): number;
  setVolume(soundId: number, volume: number): number;
  setMasterVolume(volume: number): number;
  update(): number;
  isPlaying(soundId: number): number;
}

let cachedLib: AudioLib | null = null;
let loadAttempted = false;

export async function loadAudioLib(): Promise<AudioLib | null> {
  if (cachedLib) return cachedLib;
  if (loadAttempted) return null;
  loadAttempted = true;

  try {
    const lib = await tryLoadNative();
    if (lib) {
      cachedLib = lib;
      return lib;
    }
  } catch (err) {
    console.warn("[audio-kira] Failed to load native library:", err);
  }

  console.warn("[audio-kira] Native library not available. Using JS fallback audio.");
  return null;
}

async function tryLoadNative(): Promise<AudioLib | null> {
  const platform = process.platform;
  const ext = platform === "win32" ? ".dll" : platform === "darwin" ? ".dylib" : ".so";
  const libName = `libdowndraft_audio${ext}`;

  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");

    const lib = dlopen(libName, {
      dd_audio_init: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      dd_audio_destroy: { args: [], returns: FFIType.i32 },
      dd_audio_load_buffer: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      dd_audio_unload_buffer: { args: [FFIType.i32], returns: FFIType.i32 },
      dd_audio_play: { args: [FFIType.i32, FFIType.i32, FFIType.f32], returns: FFIType.i32 },
      dd_audio_stop: { args: [FFIType.i32], returns: FFIType.i32 },
      dd_audio_pause: { args: [FFIType.i32], returns: FFIType.i32 },
      dd_audio_resume: { args: [FFIType.i32], returns: FFIType.i32 },
      dd_audio_set_volume: { args: [FFIType.i32, FFIType.f32], returns: FFIType.i32 },
      dd_audio_set_master_volume: { args: [FFIType.f32], returns: FFIType.i32 },
      dd_audio_update: { args: [], returns: FFIType.i32 },
      dd_audio_is_playing: { args: [FFIType.i32], returns: FFIType.i32 },
    });

    return {
      init(sampleRate, bufferSize) {
        return lib.symbols.dd_audio_init(sampleRate, bufferSize) as number;
      },
      destroy() {
        return lib.symbols.dd_audio_destroy() as number;
      },
      loadBuffer(data, format) {
        const buf = new Uint8Array(data);
        return lib.symbols.dd_audio_load_buffer(ptr(buf), BigInt(buf.length), format) as number;
      },
      unloadBuffer(bufferId) {
        return lib.symbols.dd_audio_unload_buffer(bufferId) as number;
      },
      play(bufferId, loop, volume) {
        return lib.symbols.dd_audio_play(bufferId, loop, volume) as number;
      },
      stop(soundId) {
        return lib.symbols.dd_audio_stop(soundId) as number;
      },
      pause(soundId) {
        return lib.symbols.dd_audio_pause(soundId) as number;
      },
      resume(soundId) {
        return lib.symbols.dd_audio_resume(soundId) as number;
      },
      setVolume(soundId, volume) {
        return lib.symbols.dd_audio_set_volume(soundId, volume) as number;
      },
      setMasterVolume(volume) {
        return lib.symbols.dd_audio_set_master_volume(volume) as number;
      },
      update() {
        return lib.symbols.dd_audio_update() as number;
      },
      isPlaying(soundId) {
        return lib.symbols.dd_audio_is_playing(soundId) as number;
      },
    };
  } catch {
    return null;
  }
}
