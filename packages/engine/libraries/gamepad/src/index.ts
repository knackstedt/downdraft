// Public API for @downdraft/engine/libraries/gamepad

export { getHostGamepadReader, writePadToInput } from "./feed-input";
export type { PadKeyBinding } from "./feed-input";
export { isAuxDeviceName, isLikelyGamepadName } from "./filters";
export { glyphFor } from "./glyphs";
export type { GlyphResult } from "./glyphs";
export { GamepadDevice, GamepadHub } from "./hub";
export type { GamepadDeviceInfo, GamepadHubOptions } from "./hub";
export { GamepadHubTok, GamepadLib, GamepadSourceTok } from "./library";
export type { GamepadLibConfig } from "./library";
export { GAMEPAD_DEVICES_SAB_NAME, gamepadDevicesSabSize, SabGamepadSource } from "./source-sab";
export { SysfsGamepadEnricher } from "./sysfs-enrich";
export type { EnrichResult } from "./sysfs-enrich";

// Re-export the channel contract for convenience.
export {
    GAMEPAD_MAX_SLOTS, GamepadDevicesChannel, GamepadDevicesHostMetaWriter, GamepadDevicesReader, GP_AXIS, GP_BTN, PAD_BATTERY_UNKNOWN,
    PAD_BATTERY_WIRED, PAD_FLAG, PadConnType, PadType
} from "@downdraft/engine/sab/gamepad-devices";
export type { GamepadDeviceSlot, PadConnTypeValue, PadTypeValue } from "@downdraft/engine/sab/gamepad-devices";

