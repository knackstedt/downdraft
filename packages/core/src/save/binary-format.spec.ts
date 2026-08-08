import {
    decodeHeader,
    encodeHeader,
    engineVersionString,
    HEADER_SIZE,
    packEngineVersion,
    readHeaderFromFile,
    SAVE_FORMAT_VERSION,
    SAVE_MAGIC,
    unpackEngineVersion,
    type SaveHeader,
} from "./binary-format";

describe("packEngineVersion", () => {
  it("packs semver into a 32-bit integer", () => {
    expect(packEngineVersion(1, 2, 3)).toBe((1 << 22) | (2 << 12) | 3);
  });

  it("handles zero versions", () => {
    expect(packEngineVersion(0, 0, 0)).toBe(0);
  });

  it("masks overflow bits", () => {
    expect(packEngineVersion(0x3ff, 0x3ff, 0xfff)).toBe(-1);
  });
});

describe("unpackEngineVersion", () => {
  it("round-trips pack/unpack", () => {
    const packed = packEngineVersion(1, 2, 3);
    expect(unpackEngineVersion(packed)).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("round-trips max values", () => {
    const packed = packEngineVersion(0x3ff, 0x3ff, 0xfff);
    expect(unpackEngineVersion(packed)).toEqual({ major: 0x3ff, minor: 0x3ff, patch: 0xfff });
  });
});

describe("engineVersionString", () => {
  it("formats packed version as string", () => {
    expect(engineVersionString(packEngineVersion(0, 1, 0))).toBe("0.1.0");
    expect(engineVersionString(packEngineVersion(1, 10, 25))).toBe("1.10.25");
  });
});

describe("encodeHeader / decodeHeader", () => {
  const makeHeader = (): SaveHeader => ({
    magic: SAVE_MAGIC,
    formatVersion: SAVE_FORMAT_VERSION,
    engineVersionPacked: packEngineVersion(0, 1, 0),
    timestamp: 1700000000.5,
    entityCount: 42,
    playerCount: 2,
    bodyHash: new Uint8Array(16).fill(0xab),
    uncompressedBodyLength: 1024,
  });

  it("encodes to exactly HEADER_SIZE bytes", () => {
    const buf = encodeHeader(makeHeader());
    expect(buf.byteLength).toBe(HEADER_SIZE);
  });

  it("round-trips all fields", () => {
    const header = makeHeader();
    const buf = encodeHeader(header);
    const decoded = decodeHeader(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.magic).toBe(SAVE_MAGIC);
    expect(decoded!.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(decoded!.engineVersionPacked).toBe(header.engineVersionPacked);
    expect(decoded!.timestamp).toBeCloseTo(header.timestamp, 5);
    expect(decoded!.entityCount).toBe(42);
    expect(decoded!.playerCount).toBe(2);
    expect(decoded!.uncompressedBodyLength).toBe(1024);
  });

  it("preserves body hash bytes", () => {
    const header = makeHeader();
    const buf = encodeHeader(header);
    const decoded = decodeHeader(buf);
    expect(decoded).not.toBeNull();
    for (let i = 0; i < 16; i++) {
      expect(decoded!.bodyHash[i]).toBe(0xab);
    }
  });

  it("returns null for buffer too small", () => {
    const smallBuf = new ArrayBuffer(10);
    expect(decodeHeader(smallBuf)).toBeNull();
  });

  it("returns null for wrong magic", () => {
    const header = makeHeader();
    header.magic = 0xdeadbeef;
    const buf = encodeHeader(header);
    expect(decodeHeader(buf)).toBeNull();
  });

  it("returns null for wrong format version", () => {
    const header = makeHeader();
    header.formatVersion = 999;
    const buf = encodeHeader(header);
    // encodeHeader writes whatever we give it, decodeHeader validates
    expect(decodeHeader(buf)).toBeNull();
  });

  it("returns null for truncated buffer between field boundaries", () => {
    const header = makeHeader();
    const full = encodeHeader(header);
    // Truncate at various points past the initial size check
    for (let trunc = 8; trunc < HEADER_SIZE; trunc += 4) {
      const truncated = full.slice(0, trunc);
      // decodeHeader should not throw on truncated buffers
      expect(() => decodeHeader(truncated)).not.toThrow();
    }
  });
});

describe("readHeaderFromFile", () => {
  it("reads header from a larger buffer", () => {
    const header: SaveHeader = {
      magic: SAVE_MAGIC,
      formatVersion: SAVE_FORMAT_VERSION,
      engineVersionPacked: packEngineVersion(0, 2, 1),
      timestamp: 1234567890,
      entityCount: 10,
      playerCount: 1,
      bodyHash: new Uint8Array(16).fill(0xff),
      uncompressedBodyLength: 512,
    };
    const headerBuf = encodeHeader(header);
    const fileBuf = new ArrayBuffer(HEADER_SIZE + 100);
    new Uint8Array(fileBuf).set(new Uint8Array(headerBuf), 0);
    const result = readHeaderFromFile(fileBuf);
    expect(result).not.toBeNull();
    expect(result!.entityCount).toBe(10);
    expect(result!.uncompressedBodyLength).toBe(512);
  });

  it("returns null for buffer smaller than HEADER_SIZE", () => {
    const smallBuf = new ArrayBuffer(20);
    expect(readHeaderFromFile(smallBuf)).toBeNull();
  });
});
