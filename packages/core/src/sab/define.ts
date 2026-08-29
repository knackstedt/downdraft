import { GridReader, GridWriter } from "./grid-buffer";
import { computeLayout } from "./layout";
import { RecordReader, RecordWriter } from "./record-buffer";
import { SlotReader, SlotWriter } from "./slot-buffer";
import type {
    ChannelDef,
    ChannelInstance,
    ChannelLayout,
    ChannelReader,
    ChannelWriter,
    FieldMap,
    SlotSectionDef,
} from "./types";

// ============================================================================
// Single-writer constraint
// ============================================================================
//
// All SAB channels in the Downdraft engine follow a single-writer-per-region
// constraint: each buffer region (header, slots, records, grids, input, stats,
// board) has exactly ONE thread that writes to it. The other thread only reads.
//
// This constraint is critical for the SAB polyfill (sab-polyfill.ts), which
// replaces SharedArrayBuffer with an ArrayBuffer subclass on Android WebView.
// The polyfill uses a copy-based buffer-sync protocol (buffer-sync.ts) that
// copies each side's written regions to the other side via postMessage. If
// both sides write to the same region, the sync will overwrite one side's
// writes with stale data from the other, causing unpredictable behavior.
//
// When adding a new channel or buffer region:
//   1. Document which thread writes (sim worker vs main/renderer).
//   2. Ensure the other thread only reads (use Reader classes, not Writer).
//   3. Declare the region in the BufferSyncConfig (see buffer-sync.ts).
//
// Current channel ownership:
//   - SimChannel: worker writes (entities, players, header), main reads
//   - InputChannel: main writes (input), worker reads
//   - WaterChannel: worker writes, renderer reads
//   - BoatChannel: worker writes, renderer reads
//   - GridSimBuffer (sand): worker writes (grid, fields, stats, board),
//     main writes (input region only — embedded at INPUT_OFFSET)
//
// ============================================================================

// --- Type-level inference helpers ---

type HeaderOffsets<Def extends ChannelDef> = {
  magic: number;
  version: number;
  sequence: number;
} & {
  [K in keyof Def["header"]["fields"] & string]: number;
};

type SectionFieldOffsets<S extends SlotSectionDef> = {
  [K in keyof S["fields"] & string]: number;
};

type SectionsOffsets<Def extends ChannelDef> =
  Def extends { sections: infer S extends SlotSectionDef[] }
    ? {
        [Section in S[number] as Section["name"]]: {
          sectionByteOffset: number;
          slotStride: number;
          fields: SectionFieldOffsets<Section>;
        };
      }
    : never;

type GridLayerOffsets<Def extends ChannelDef> =
  Def extends { grid: { layers: infer L } }
    ? { [K in keyof L & string]: { byteOffset: number; length: number } }
    : never;

type RecordFieldOffsets<Def extends ChannelDef> =
  Def extends { fields: infer F extends FieldMap }
    ? { [K in keyof F & string]: number }
    : never;

export type ChannelOffsets<Def extends ChannelDef> = {
  header: HeaderOffsets<Def>;
} & (Def["mode"] extends "record" ? { fields: RecordFieldOffsets<Def> } : {}) &
  (Def["mode"] extends "slots" ? { sections: SectionsOffsets<Def> } : {}) &
  (Def["mode"] extends "grid" ? { grid: GridLayerOffsets<Def> } : {});

type TypedReader<Def extends ChannelDef> = Omit<ChannelReader, "sections" | "layers" | "fields"> &
  (Def["mode"] extends "slots" ? { sections: Record<string, import("./types").SlotAccessor> } : {}) &
  (Def["mode"] extends "grid" ? { layers: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array> } : {}) &
  (Def["mode"] extends "record" ? { fields: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array> } : {});

type TypedWriter<Def extends ChannelDef> = Omit<ChannelWriter, "sections" | "layers" | "fields"> &
  (Def["mode"] extends "slots" ? { sections: Record<string, import("./types").SlotAccessor> } : {}) &
  (Def["mode"] extends "grid" ? { layers: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array> } : {}) &
  (Def["mode"] extends "record" ? { fields: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array> } : {});

export interface ChannelInstanceTyped<Def extends ChannelDef> extends ChannelInstance {
  offsets: ChannelOffsets<Def>;
  reader(sab: SharedArrayBuffer): TypedReader<Def>;
  writer(sab: SharedArrayBuffer): TypedWriter<Def>;
}

// --- Runtime implementation ---

function buildOffsets(layout: ChannelLayout): Record<string, unknown> {
  const headerOffsets: Record<string, number> = {
    magic: layout.header.magicIndex,
    version: layout.header.versionIndex,
    sequence: layout.header.sequenceIndex,
  };
  for (const [name, field] of Object.entries(layout.header.fields)) {
    if (name === "magic" || name === "version" || name === "sequence") continue;
    headerOffsets[name] = field.index;
  }

  if (layout.mode === "record" && layout.fields) {
    const fieldOffsets: Record<string, number> = {};
    for (const [name, field] of Object.entries(layout.fields)) {
      fieldOffsets[name] = field.index;
    }
    return { header: headerOffsets, fields: fieldOffsets };
  }

  if (layout.mode === "slots" && layout.sections) {
    const sections: Record<string, unknown> = {};
    for (const section of layout.sections) {
      const fieldOffsets: Record<string, number> = {};
      for (const [name, field] of Object.entries(section.fields)) {
        fieldOffsets[name] = field.index;
      }
      sections[section.name] = {
        sectionByteOffset: section.byteOffset,
        slotStride: section.slotStride,
        fields: fieldOffsets,
      };
    }
    return { header: headerOffsets, sections };
  }

  if (layout.mode === "grid" && layout.grid) {
    const grid: Record<string, { byteOffset: number; length: number }> = {};
    for (const [name, layer] of Object.entries(layout.grid.layers)) {
      grid[name] = { byteOffset: layer.byteOffset, length: layer.length };
    }
    return { header: headerOffsets, grid };
  }

  return { header: headerOffsets };
}

function createReader(sab: SharedArrayBuffer, layout: ChannelLayout): ChannelReader {
  switch (layout.mode) {
    case "record": return new RecordReader(sab, layout);
    case "slots": return new SlotReader(sab, layout);
    case "grid": return new GridReader(sab, layout);
  }
}

function createWriter(sab: SharedArrayBuffer, layout: ChannelLayout): ChannelWriter {
  switch (layout.mode) {
    case "record": {
      const w = new RecordWriter(sab, layout);
      w.init();
      return w;
    }
    case "slots": {
      const w = new SlotWriter(sab, layout);
      w.init();
      return w;
    }
    case "grid": {
      const w = new GridWriter(sab, layout);
      w.init();
      return w;
    }
  }
}

export function defineChannel<const Def extends ChannelDef>(def: Def): ChannelInstanceTyped<Def> {
  const layout = computeLayout(def);
  const offsets = buildOffsets(layout);

  const instance: ChannelInstance = {
    def,
    layout,
    byteLength: layout.byteLength,
    offsets,
    allocate(): SharedArrayBuffer {
      const sab = new SharedArrayBuffer(layout.byteLength);
      const u32 = new Uint32Array(sab);
      u32[layout.header.magicIndex] = layout.magic;
      u32[layout.header.versionIndex] = layout.version;
      return sab;
    },
    reader(sab: SharedArrayBuffer): ChannelReader {
      return createReader(sab, layout);
    },
    writer(sab: SharedArrayBuffer): ChannelWriter {
      return createWriter(sab, layout);
    },
  };

  return instance as ChannelInstanceTyped<Def>;
}

// --- Manifest ---

export function defineManifest<const M extends Record<string, ChannelInstance>>(
  channels: M,
): import("./types").ManifestInstance {
  return {
    channels: channels as Record<string, ChannelInstance>,
    allocate(): Record<string, SharedArrayBuffer> {
      const buffers: Record<string, SharedArrayBuffer> = {};
      for (const [name, ch] of Object.entries(channels)) {
        buffers[name] = ch.allocate();
      }
      return buffers;
    },
    attach(buffers: Record<string, SharedArrayBuffer>): Record<string, { reader: ChannelReader; writer: ChannelWriter }> {
      const result: Record<string, { reader: ChannelReader; writer: ChannelWriter }> = {};
      for (const [name, ch] of Object.entries(channels)) {
        const sab = buffers[name];
        if (!sab) {
          throw new Error(`[SAB] Manifest attach: no buffer provided for channel "${name}"`);
        }
        if (sab.byteLength < ch.byteLength) {
          throw new Error(
            `[SAB] Manifest attach: buffer for channel "${name}" is ${sab.byteLength} bytes, need ${ch.byteLength}`,
          );
        }
        result[name] = {
          reader: ch.reader(sab),
          writer: ch.writer(sab),
        };
      }
      return result;
    },
  };
}
