// Re-exported from @downdraft/core — moved to engine SAB module
export { allocateInputBuffer, allocateSimBuffer, ENT, MAX_ENTITIES, MAX_PLAYERS, PLR, PLR_FLAG, SIM_ENTITY_SLOT_SIZE, SIM_HDR, SIM_MAGIC, SIM_PLAYER_SLOT_SIZE, SIM_VERSION, SimBufferReader, SimBufferWriter, SimChannel } from "@downdraft/core";
export { WaterChannel };

// allocateWaterBuffer re-exported from @downdraft/plugin-water
import { WaterChannel } from "@downdraft/plugin-water";
export function allocateWaterBuffer(): SharedArrayBuffer {
  return WaterChannel.allocate();
}
