// ============================================================================
// Device classification filters — ported from Ember's evdev.ts heuristics.
// Used to flag auxiliary devices (motion sensors, touchpads, IR cameras)
// that enumerate alongside a pad's primary input node, and to sanity-check
// whether a name looks controller-like at all.
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

/** Name substrings indicating something that isn't a controller at all. */
const NON_CONTROLLER_PATTERNS = [
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

export function isLikelyControllerName(name: string): boolean {
  const n = name.toLowerCase();
  if (NON_CONTROLLER_PATTERNS.some((p) => n.includes(p))) return false;
  return (
    n.includes("controller") ||
    n.includes("controller") ||
    n.includes("joystick") ||
    n.includes("pad") ||
    n.includes("remote")
  );
}
