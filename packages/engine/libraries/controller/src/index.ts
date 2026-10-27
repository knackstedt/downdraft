// Public API for @downdraft/engine/libraries/controller

export { getHostControllerReader, writePadToInput } from "./feed-input";
export type { PadKeyBinding } from "./feed-input";
export { isAuxDeviceName, isLikelyControllerName } from "./filters";
export { glyphFor } from "./glyphs";
export type { GlyphResult } from "./glyphs";
export { ControllerDevice, ControllerHub } from "./hub";
export type { ControllerDeviceInfo, ControllerHubOptions } from "./hub";
export { ControllerHubTok, ControllerLib, ControllerSourceTok } from "./library";
export type { ControllerLibConfig } from "./library";
export { CONTROLLER_DEVICES_SAB_NAME, controllerDevicesSabSize, SabControllerSource } from "./source-sab";
export { SysfsControllerEnricher } from "./sysfs-enrich";
export type { EnrichResult } from "./sysfs-enrich";

// Re-export the channel contract for convenience.
export {
    CONTROLLER_MAX_SLOTS, ControllerDevicesChannel, ControllerDevicesHostMetaWriter, ControllerDevicesReader, GP_AXIS, GP_BTN, PAD_BATTERY_UNKNOWN,
    PAD_BATTERY_WIRED, PAD_FLAG, PadConnType, PadType
} from "@downdraft/engine/sab/controller-devices";
export type { ControllerDeviceSlot, PadConnTypeValue, PadTypeValue } from "@downdraft/engine/sab/controller-devices";

