// ============================================================================
// Device classification filters — ported from Ember's evdev.ts heuristics.
// Used to flag auxiliary devices (motion sensors, touchpads, IR cameras)
// that enumerate alongside a pad's primary input node, and to sanity-check
// whether a name looks gamepad-like at all.
// ============================================================================

/** Name substrings that mark an aux node of a composite controller. */
const AUX_NAME_PATTERNS = [
  "motion sensors",
  "motion sensor",
  "touchpad",
  "accelerometer",
  "gyro",
  "gyroscope",
  "imu",
  "ir camera",
  "nintendo wii remote accelerometer",
  "msi amblink",
  "sensor hub",
];

/** Name substrings indicating something that isn't a gamepad at all. */
const NON_GAMEPAD_PATTERNS = [
  "keyboard",
  "mouse",
  "consumer control",
  "system control",
  "power button",
  "video bus",
  "lidar",
];

export function isAuxDeviceName(name: string): boolean {
  const n = name.toLowerCase();
  return AUX_NAME_PATTERNS.some((p) => n.includes(p));
}

export function isLikelyGamepadName(name: string): boolean {
  const n = name.toLowerCase();
  if (NON_GAMEPAD_PATTERNS.some((p) => n.includes(p))) return false;
  return (
    n.includes("gamepad") ||
    n.includes("controller") ||
    n.includes("joystick") ||
    n.includes("pad") ||
    n.includes("remote")
  );
}
