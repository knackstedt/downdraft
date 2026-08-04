import { alignUp, typeSize, ValidationError } from "./errors";
import type {
    ChannelDef,
    ChannelLayout,
    FieldDef,
    FieldLayout,
    FieldMap,
    GridDef,
    GridLayerLayout,
    HeaderDef,
    HeaderLayout,
    SlotSectionDef,
    SlotSectionLayout
} from "./types";

const HEADER_MAGIC_INDEX = 0;
const HEADER_VERSION_INDEX = 1;
const HEADER_SEQUENCE_INDEX = 2;
const HEADER_RESERVED_END = 3;

function computeFieldLayout(
  name: string,
  def: FieldDef,
  byteOffset: number,
): { layout: FieldLayout; nextOffset: number } {
  const size = typeSize(def.type);
  const count = def.count ?? 1;
  const aligned = alignUp(byteOffset, size);
  const totalBytes = size * count;
  return {
    layout: {
      name,
      type: def.type,
      count,
      atomic: def.atomic ?? false,
      byteOffset: aligned,
      index: aligned / 4,
    },
    nextOffset: aligned + totalBytes,
  };
}

function computeFieldMap(
  fields: FieldMap,
  startOffset: number,
): { layouts: Record<string, FieldLayout>; endOffset: number } {
  const layouts: Record<string, FieldLayout> = {};
  let offset = startOffset;
  for (const [name, def] of Object.entries(fields)) {
    const { layout, nextOffset } = computeFieldLayout(name, def, offset);
    layouts[name] = layout;
    offset = nextOffset;
  }
  return { layouts, endOffset: offset };
}

function computeHeaderLayout(header: HeaderDef): HeaderLayout {
  const fields: Record<string, FieldLayout> = {};

  fields["magic"] = {
    name: "magic",
    type: "u32",
    count: 1,
    atomic: false,
    byteOffset: HEADER_MAGIC_INDEX * 4,
    index: HEADER_MAGIC_INDEX,
  };
  fields["version"] = {
    name: "version",
    type: "u32",
    count: 1,
    atomic: false,
    byteOffset: HEADER_VERSION_INDEX * 4,
    index: HEADER_VERSION_INDEX,
  };
  fields["sequence"] = {
    name: "sequence",
    type: "u32",
    count: 1,
    atomic: true,
    byteOffset: HEADER_SEQUENCE_INDEX * 4,
    index: HEADER_SEQUENCE_INDEX,
  };

  const userStart = HEADER_RESERVED_END * 4;
  const { layouts, endOffset } = computeFieldMap(header.fields, userStart);
  Object.assign(fields, layouts);

  if (endOffset > header.size) {
    throw new ValidationError(
      `Header fields overflow: need ${endOffset} bytes but header size is ${header.size}`,
    );
  }

  return {
    size: header.size,
    fields,
    magicIndex: HEADER_MAGIC_INDEX,
    versionIndex: HEADER_VERSION_INDEX,
    sequenceIndex: HEADER_SEQUENCE_INDEX,
  };
}

function computeSlotSectionLayouts(
  sections: SlotSectionDef[],
  headerSize: number,
): { layouts: SlotSectionLayout[]; endOffset: number } {
  const layouts: SlotSectionLayout[] = [];
  let offset = headerSize;

  for (const section of sections) {
    const { layouts: fieldLayouts, endOffset: fieldsEnd } = computeFieldMap(
      section.fields,
      0,
    );

    if (fieldsEnd > section.slotSize) {
      throw new ValidationError(
        `Slot section "${section.name}" fields overflow: need ${fieldsEnd} bytes but slot size is ${section.slotSize}`,
      );
    }

    const sectionByteOffset = offset;
    const slotStride = section.slotSize / 4;

    layouts.push({
      name: section.name,
      maxSlots: section.maxSlots,
      slotSize: section.slotSize,
      byteOffset: sectionByteOffset,
      slotStride,
      fields: fieldLayouts,
    });

    offset += section.maxSlots * section.slotSize;
  }

  return { layouts, endOffset: offset };
}

function computeGridLayout(grid: GridDef, headerSize: number): {
  size: number;
  layers: Record<string, GridLayerLayout>;
  endOffset: number;
} {
  const layers: Record<string, GridLayerLayout> = {};
  let offset = headerSize;
  const gridSize = grid.size;

  for (const [name, layer] of Object.entries(grid.layers)) {
    const size = typeSize(layer.type);
    const aligned = alignUp(offset, size);
    const elementCount = gridSize * gridSize * layer.components;
    const totalBytes = size * elementCount;

    layers[name] = {
      name,
      type: layer.type,
      components: layer.components,
      byteOffset: aligned,
      length: elementCount,
    };

    offset = aligned + totalBytes;
  }

  return { size: gridSize, layers, endOffset: offset };
}

export function computeLayout(def: ChannelDef): ChannelLayout {
  const header = computeHeaderLayout(def.header);

  if (def.mode === "record") {
    if (!def.fields) {
      throw new ValidationError(`Channel "${def.name}" in record mode requires "fields"`);
    }
    const { layouts, endOffset } = computeFieldMap(def.fields, header.size);
    return {
      byteLength: endOffset,
      mode: "record",
      magic: def.magic,
      version: def.version,
      header,
      fields: layouts,
    };
  }

  if (def.mode === "slots") {
    if (!def.sections || def.sections.length === 0) {
      throw new ValidationError(`Channel "${def.name}" in slots mode requires "sections"`);
    }
    const { layouts, endOffset } = computeSlotSectionLayouts(def.sections, header.size);
    return {
      byteLength: endOffset,
      mode: "slots",
      magic: def.magic,
      version: def.version,
      header,
      sections: layouts,
    };
  }

  if (def.mode === "grid") {
    if (!def.grid) {
      throw new ValidationError(`Channel "${def.name}" in grid mode requires "grid"`);
    }
    const { size, layers, endOffset } = computeGridLayout(def.grid, header.size);
    return {
      byteLength: endOffset,
      mode: "grid",
      magic: def.magic,
      version: def.version,
      header,
      grid: { size, layers },
    };
  }

  throw new ValidationError(`Unknown channel mode: "${def.mode}"`);
}
