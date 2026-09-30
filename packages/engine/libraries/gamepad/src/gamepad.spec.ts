import {
    GamepadDevicesChannel,
    GamepadDevicesHostMetaWriter,
    GamepadDevicesReader,
    GP_AXIS,
    GP_BTN,
    PAD_FLAG,
    PadType,
} from "@downdraft/engine/sab/gamepad-devices";
import { describe, expect, it } from "bun:test";
import { isAuxDeviceName, isLikelyGamepadName } from "./filters";
import { glyphFor } from "./glyphs";
import { GamepadHub } from "./hub";
import { SabGamepadSource } from "./source-sab";

const F = GamepadDevicesChannel.offsets.sections.pads.fields;

/** Simulate the native writer: poke a slot's u32 views directly. */
function writePad(sab: SharedArrayBuffer, slot: number, opts: {
  connected?: boolean;
  padType?: number;
  connType?: number;
  battery?: number;
  flags?: number;
  buttonsLo?: number;
  buttonsHi?: number;
  axes?: number[];
  vendorId?: number;
  productId?: number;
  name?: string;
  eventNode?: number;
}) {
  const sv = GamepadDevicesChannel.reader(sab).sections.pads.slot(slot);
  const meta0 =
    ((opts.connected ?? true) ? 1 : 0) |
    ((opts.padType ?? PadType.XBOX) << 8) |
    ((opts.connType ?? 1) << 16) |
    ((opts.battery ?? 100) << 24);
  sv.u32[F.meta0] = meta0 >>> 0;
  sv.u32[F.meta1] = opts.flags ?? PAD_FLAG.FF_SUPPORTED;
  sv.u32[F.buttonsLo] = opts.buttonsLo ?? 0;
  sv.u32[F.buttonsHi] = opts.buttonsHi ?? 0;
  (opts.axes ?? []).forEach((v, i) => {
    sv.f32[F.axes + i] = v;
  });
  sv.u32[F.slotSeq] = 1;
  sv.u32[F.vendorId] = opts.vendorId ?? 0x045e;
  sv.u32[F.productId] = opts.productId ?? 0x02fd;
  const nameBytes = new TextEncoder().encode(opts.name ?? "Test Pad");
  const nameView = new Uint8Array(sv.u32.buffer, sv.u32.byteOffset + F.name * 4, 56);
  nameView.fill(0);
  nameView.set(nameBytes.subarray(0, 55));
  sv.u32[F.aux] = opts.eventNode ?? 0xffff;

  const hdr = new Uint32Array(sab);
  let mask = 0;
  for (let i = 0; i < 16; i++) {
    const m = GamepadDevicesChannel.reader(sab).sections.pads.slot(i).u32[F.meta0];
    if (m & 1) mask |= 1 << i;
  }
  hdr[3] = mask; // connectedMask header field at index 3
  hdr[2] += 1; // sequence
}

function clearPads(sab: SharedArrayBuffer) {
  const hdr = new Uint32Array(sab);
  for (let i = 0; i < 16; i++) {
    const sv = GamepadDevicesChannel.reader(sab).sections.pads.slot(i);
    sv.u32[F.meta0] = 0;
  }
  hdr[3] = 0;
}

describe("GamepadDevicesChannel", () => {
  it("produces the documented ABI layout", () => {
    // Rust-side SLOT_* offsets must match these byte offsets.
    expect(F.meta0 * 4).toBe(0x00);
    expect(F.meta1 * 4).toBe(0x04);
    expect(F.hostMeta * 4).toBe(0x08);
    expect(F.buttonsLo * 4).toBe(0x0c);
    expect(F.buttonsHi * 4).toBe(0x10);
    expect(F.axes * 4).toBe(0x14);
    expect(F.lastEventMs * 4).toBe(0x34);
    expect(F.slotSeq * 4).toBe(0x38);
    expect(F.vendorId * 4).toBe(0x3c);
    expect(F.productId * 4).toBe(0x40);
    expect(F.name * 4).toBe(0x44);
    expect(F.aux * 4).toBe(0x7c);
    expect(GamepadDevicesChannel.layout.sections?.[0].slotSize).toBe(128);
    expect(GamepadDevicesChannel.layout.header.size).toBe(64);
  });

  it("round-trips a device slot", () => {
    const sab = GamepadDevicesChannel.allocate();
    writePad(sab, 2, {
      padType: PadType.PS5,
      connType: 2,
      battery: 73,
      buttonsLo: (1 << GP_BTN.SOUTH) | (1 << GP_BTN.DPAD_LEFT),
      axes: [0.25, -0.5, 0, 0, 0.9, 0, 0, 0],
      name: "DualSense Wireless Controller",
      eventNode: 12,
    });

    const reader = new GamepadDevicesReader(sab);
    expect(reader.getConnectedMask()).toBe(1 << 2);
    const d = reader.readSlot(2);
    expect(d).not.toBeNull();
    expect(d!.padType).toBe(PadType.PS5);
    expect(d!.connType).toBe(2);
    expect(d!.battery).toBe(73);
    expect(d!.name).toBe("DualSense Wireless Controller");
    expect(d!.eventNode).toBe(12);
    expect(d!.buttonsLo & (1 << GP_BTN.SOUTH)).toBeTruthy();
    expect(d!.axes[GP_AXIS.LEFT_TRIGGER]).toBeCloseTo(0.9);
    expect(reader.readSlot(3)).toBeNull();
  });
});

describe("GamepadHub", () => {
  it("emits connect/disconnect on mask diff", () => {
    const sab = GamepadDevicesChannel.allocate();
    const hub = new GamepadHub(sab);
    const events: string[] = [];
    hub.on("connect", (d) => events.push(`+${d.slot}`));
    hub.on("disconnect", (d) => events.push(`-${d.slot}`));

    writePad(sab, 0, { name: "Pad A" });
    hub.poll();
    expect(events).toEqual(["+0"]);
    expect(hub.device(0)?.info.name).toBe("Pad A");
    expect(hub.device(0)?.info.ffSupported).toBe(true);

    clearPads(sab);
    hub.poll();
    expect(events).toEqual(["+0", "-0"]);
    expect(hub.device(0)).toBeUndefined();
  });

  it("exposes battery + rumble", () => {
    const sab = GamepadDevicesChannel.allocate();
    const rumbles: number[][] = [];
    const hub = new GamepadHub(sab, { rumble: (...a) => rumbles.push([...a]) });
    writePad(sab, 1, { battery: 55, flags: PAD_FLAG.FF_SUPPORTED | PAD_FLAG.CHARGING });
    hub.poll();
    const dev = hub.device(1)!;
    expect(dev.batteryPercent).toBe(55);
    expect(dev.charging).toBe(true);
    dev.rumble(1000, 2000, 50);
    expect(rumbles).toEqual([[1, 1000, 2000, 50]]);
  });
});

describe("SabGamepadSource", () => {
  it("implements GamepadSource over the channel", () => {
    const sab = GamepadDevicesChannel.allocate();
    const src = new SabGamepadSource(sab);
    expect(src.listConnected()).toEqual([]);

    writePad(sab, 3, { buttonsLo: 1 << GP_BTN.START, axes: [0, 0, 0, 0, 0, 0, 1, -1] });
    expect(src.listConnected()).toEqual([3]);
    const snap = src.read(3);
    expect(snap!.buttonsLo).toBe(1 << GP_BTN.START);
    expect(snap!.axes[GP_AXIS.DPAD_X]).toBe(1);
    expect(src.read(4)).toBeNull();
  });
});

describe("hostMeta writer", () => {
  it("writes rssi without touching Rust-owned fields", () => {
    const sab = GamepadDevicesChannel.allocate();
    writePad(sab, 0, { flags: PAD_FLAG.FF_SUPPORTED });
    const w = new GamepadDevicesHostMetaWriter(sab);
    w.setHostMeta(0, 77, 0x02);
    const d = new GamepadDevicesReader(sab).readSlot(0)!;
    expect(d.rssi).toBe(77);
    expect(d.flags).toBe(PAD_FLAG.FF_SUPPORTED);
  });
});

describe("glyphs + filters", () => {
  it("maps face buttons per pad family", () => {
    expect(glyphFor(PadType.XBOX, GP_BTN.SOUTH)).toEqual({ set: "xbox", glyph: "a" });
    expect(glyphFor(PadType.PS5, GP_BTN.SOUTH)).toEqual({ set: "playstation", glyph: "cross" });
    expect(glyphFor(PadType.SWITCH, GP_BTN.EAST)).toEqual({ set: "switch", glyph: "a" });
    expect(glyphFor(PadType.PS4, GP_BTN.LEFT_SHOULDER).glyph).toBe("l1");
  });

  it("filters aux device names", () => {
    expect(isAuxDeviceName("Wireless Controller Motion Sensors")).toBe(true);
    expect(isAuxDeviceName("DualSense Wireless Controller Touchpad")).toBe(true);
    expect(isAuxDeviceName("Xbox Wireless Controller")).toBe(false);
    expect(isLikelyGamepadName("Power Button")).toBe(false);
    expect(isLikelyGamepadName("8BitDo Pro 2 Controller")).toBe(true);
  });
});
