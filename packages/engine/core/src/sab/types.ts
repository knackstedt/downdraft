export type FieldType = "f32" | "f64" | "i32" | "u32" | "bool";

export type ChannelMode = "record" | "slots" | "grid";

export interface FieldDef {
  type: FieldType;
  count?: number;
  atomic?: boolean;
}

export type FieldMap = Record<string, FieldDef>;

export interface HeaderDef {
  size: number;
  fields: FieldMap;
}

export interface SlotSectionDef {
  name: string;
  maxSlots: number;
  slotSize: number;
  fields: FieldMap;
}

export interface GridLayerDef {
  type: FieldType;
  components: number;
}

export interface GridDef {
  size: number;
  layers: Record<string, GridLayerDef>;
}

export interface ChannelDef {
  name: string;
  magic: number;
  version: number;
  mode: ChannelMode;
  pollHz?: number;
  header: HeaderDef;
  fields?: FieldMap;
  sections?: SlotSectionDef[];
  grid?: GridDef;
}

export interface ManifestDef {
  [channelName: string]: ChannelInstance;
}

export interface FieldLayout {
  name: string;
  type: FieldType;
  count: number;
  atomic: boolean;
  byteOffset: number;
  index: number;
}

export interface HeaderLayout {
  size: number;
  fields: Record<string, FieldLayout>;
  magicIndex: number;
  versionIndex: number;
  sequenceIndex: number;
}

export interface SlotSectionLayout {
  name: string;
  maxSlots: number;
  slotSize: number;
  byteOffset: number;
  slotStride: number;
  fields: Record<string, FieldLayout>;
}

export interface GridLayerLayout {
  name: string;
  type: FieldType;
  components: number;
  byteOffset: number;
  length: number;
}

export interface ChannelLayout {
  byteLength: number;
  mode: ChannelMode;
  magic: number;
  version: number;
  header: HeaderLayout;
  fields?: Record<string, FieldLayout>;
  sections?: SlotSectionLayout[];
  grid?: {
    size: number;
    layers: Record<string, GridLayerLayout>;
  };
}

export interface SlotViews {
  f32: Float32Array;
  u32: Uint32Array;
  i32: Int32Array;
  f64: Float64Array;
}

export interface HeaderViews {
  u32: Uint32Array;
  i32: Int32Array;
  f32: Float32Array;
  f64: Float64Array;
}

export interface ChannelInstance {
  def: ChannelDef;
  layout: ChannelLayout;
  byteLength: number;
  offsets: Record<string, unknown>;
  allocate(): SharedArrayBuffer;
  reader(sab: SharedArrayBuffer): ChannelReader;
  writer(sab: SharedArrayBuffer): ChannelWriter;
}

export interface ChannelReader {
  isValid(): boolean;
  /** Why the header is invalid, or null when valid. See describeHeaderValidation. */
  validationError(): string | null;
  getSequence(): number;
  hasChanged(lastSeen: number): boolean;
  /** True while the writer holds an open write window (sequence odd). */
  isWriteInProgress(): boolean;
  /**
   * Run `fn` against a consistent snapshot — retries while the writer is
   * mid-publish or publishes during the read (seqlock). Bounded retries.
   */
  readConsistent<T>(fn: () => T, maxRetries?: number): T;
  header: HeaderViews;
  sections?: Record<string, SlotAccessor>;
  layers?: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
  fields?: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
  snapshot(): Record<string, unknown>;
}

export interface ChannelWriter {
  init(): void;
  /** Open a write window (sequence → odd). Idempotent. */
  beginWrite(): void;
  /** Close the current write window (sequence → even). */
  endWrite(): void;
  bumpSequence(): void;
  getSequence(): number;
  header: HeaderViews;
  sections?: Record<string, SlotAccessor>;
  layers?: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
  fields?: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
}

export interface SlotAccessor {
  slot(index: number): SlotViews;
  maxSlots: number;
  slotSize: number;
  slotStride: number;
  byteOffset: number;
}

export interface ManifestInstance {
  channels: Record<string, ChannelInstance>;
  allocate(): Record<string, SharedArrayBuffer>;
  attach(buffers: Record<string, SharedArrayBuffer>): Record<string, { reader: ChannelReader; writer: ChannelWriter }>;
}
