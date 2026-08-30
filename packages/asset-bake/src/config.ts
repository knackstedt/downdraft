// ============================================================================
// Bake config — option types, defaults, and resolution.
// ============================================================================

/** Bumped when bake output format/defaults change → cache invalidation. */
export const BAKE_CONFIG_VERSION = 1;

/** Texture codec target for glTF embedded textures. */
export type TextureCodecMode = "auto" | "uastc" | "etc1s";

export interface TextureBakeOptions {
  /** Enable texture → KTX2/basisu transcode. Default: true. */
  enabled?: boolean;
  /**
   * Codec mode.
   *   "auto"  → UASTC for normal/ORM/emissive slots, ETC1S for base color.
   *   "uastc" → UASTC for all (higher quality, larger).
   *   "etc1s" → ETC1S for all (smallest, lower quality).
   * Default: "auto".
   */
  codec?: TextureCodecMode;
  /** Generate mipmaps. Default: true. */
  generateMipmap?: boolean;
  /** ETC1S quality level [1,255]. Default: 224. */
  etc1sQuality?: number;
  /** UASTC quality level [0,4]. Default: 2. */
  uastcLevel?: number;
  /** Apply UASTC RDO post-processor. Default: false. */
  uastcRdo?: boolean;
  /** Max texture dimension (power-of-two friendly). Default: 4096. 0 = no limit. */
  maxSize?: number;
}

export interface GltfBakeOptions {
  /** Enable glTF/GLB baking. Default: true. */
  enabled?: boolean;
  /** meshopt compression level. Default: "medium". */
  meshoptLevel?: "low" | "medium" | "high";
  /** Remove unused nodes/textures/materials. Default: true. */
  prune?: boolean;
  /** Remove duplicate vertices/accessors. Default: true. */
  dedup?: boolean;
  /** Weld coincident vertices. Default: true. */
  weld?: boolean;
  /** Quantize vertex attributes. Default: true. */
  quantize?: boolean;
  /** Texture options. */
  textures?: TextureBakeOptions;
}

export interface AudioBakeOptions {
  /** Enable audio transcoding. Default: true. */
  enabled?: boolean;
  /** Target container/codec. Default: "ogg" (Vorbis/Opus). */
  target?: "ogg" | "mp3" | "wav" | "flac";
  /** Bitrate in kbps (lossy targets). Default: 96. */
  bitrate?: number;
  /** Target sample rate in Hz. 0 = preserve source. Default: 48000. */
  sampleRate?: number;
  /** Output channels: 1 (mono), 2 (stereo), 0 = preserve source. Default: 0. */
  channels?: 0 | 1 | 2;
}

export interface AssetBakeOptions {
  /** Master enable. Default: true (the plugin gates this separately). */
  enabled?: boolean;
  gltf?: GltfBakeOptions;
  audio?: AudioBakeOptions;
  /**
   * Glob patterns (minimatch-style, relative to game root) to include in
   * baking. Default: all matched extensions.
   */
  include?: string[];
  /** Glob patterns to exclude. */
  exclude?: string[];
}

export interface ResolvedBakeOptions {
  enabled: boolean;
  gltf: {
    enabled: boolean;
    meshoptLevel: "low" | "medium" | "high";
    prune: boolean;
    dedup: boolean;
    weld: boolean;
    quantize: boolean;
    textures: {
      enabled: boolean;
      codec: TextureCodecMode;
      generateMipmap: boolean;
      etc1sQuality: number;
      uastcLevel: number;
      uastcRdo: boolean;
      maxSize: number;
    };
  };
  audio: {
    enabled: boolean;
    target: "ogg" | "mp3" | "wav" | "flac";
    bitrate: number;
    sampleRate: number;
    channels: 0 | 1 | 2;
  };
  include: string[];
  exclude: string[];
}

export const DEFAULT_BAKE_OPTIONS: ResolvedBakeOptions = {
  enabled: true,
  gltf: {
    enabled: true,
    meshoptLevel: "medium",
    prune: true,
    dedup: true,
    weld: true,
    quantize: true,
    textures: {
      enabled: true,
      codec: "auto",
      generateMipmap: true,
      etc1sQuality: 224,
      uastcLevel: 2,
      uastcRdo: false,
      maxSize: 4096,
    },
  },
  audio: {
    enabled: true,
    target: "ogg",
    bitrate: 96,
    sampleRate: 48000,
    channels: 0,
  },
  include: [],
  exclude: [],
};

export function resolveOptions(user?: AssetBakeOptions): ResolvedBakeOptions {
  if (!user) return structuredClone(DEFAULT_BAKE_OPTIONS);
  const d = structuredClone(DEFAULT_BAKE_OPTIONS);
  if (user.enabled !== undefined) d.enabled = user.enabled;
  if (user.include) d.include = user.include;
  if (user.exclude) d.exclude = user.exclude;
  if (user.gltf) {
    const g = user.gltf;
    if (g.enabled !== undefined) d.gltf.enabled = g.enabled;
    if (g.meshoptLevel) d.gltf.meshoptLevel = g.meshoptLevel;
    if (g.prune !== undefined) d.gltf.prune = g.prune;
    if (g.dedup !== undefined) d.gltf.dedup = g.dedup;
    if (g.weld !== undefined) d.gltf.weld = g.weld;
    if (g.quantize !== undefined) d.gltf.quantize = g.quantize;
    if (g.textures) {
      const t = g.textures;
      const dt = d.gltf.textures;
      if (t.enabled !== undefined) dt.enabled = t.enabled;
      if (t.codec) dt.codec = t.codec;
      if (t.generateMipmap !== undefined) dt.generateMipmap = t.generateMipmap;
      if (t.etc1sQuality !== undefined) dt.etc1sQuality = t.etc1sQuality;
      if (t.uastcLevel !== undefined) dt.uastcLevel = t.uastcLevel;
      if (t.uastcRdo !== undefined) dt.uastcRdo = t.uastcRdo;
      if (t.maxSize !== undefined) dt.maxSize = t.maxSize;
    }
  }
  if (user.audio) {
    const a = user.audio;
    const da = d.audio;
    if (a.enabled !== undefined) da.enabled = a.enabled;
    if (a.target) da.target = a.target;
    if (a.bitrate !== undefined) da.bitrate = a.bitrate;
    if (a.sampleRate !== undefined) da.sampleRate = a.sampleRate;
    if (a.channels !== undefined) da.channels = a.channels;
  }
  return d;
}

/** Result of baking a single asset. */
export interface BakeResult {
  /** Optimized bytes. */
  bytes: Uint8Array;
  /** Output file extension (without dot), e.g. "glb", "ogg". */
  ext: string;
  /** MIME type of the output. */
  mimeType: string;
  /** Original byte length (for logging ratio). */
  sourceSize: number;
}
