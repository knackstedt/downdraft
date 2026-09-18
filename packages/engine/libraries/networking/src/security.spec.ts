import { safeJsonParse } from "@downdraft/engine";
import { WebSocketTransport } from "./transport";
import { isValidIceCandidate } from "./webrtc";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType: string = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closeCode: number | null = null;
  closeReason: string | null = null;

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.readyState = MockWebSocket.CLOSING;
  }

  send(_data: unknown): void {
    // no-op
  }
}

describe("security: message size limit", () => {
  it("should reject WebSocket messages larger than 16MB", async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    const mock = new MockWebSocket();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = function () {
      return mock;
    };

    try {
      const transport = new WebSocketTransport();
      const connectPromise = transport.connect("ws://test");
      // simulate open
      mock.readyState = MockWebSocket.OPEN;
      mock.onopen?.();
      await connectPromise;

      // send an oversized message (17MB)
      const oversized = new ArrayBuffer(17 * 1024 * 1024);
      mock.onmessage?.({ data: oversized });

      expect(mock.closeCode).toBe(1009);
      expect(mock.closeReason).toBe("message too large");
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
    }
  });

  it("should accept WebSocket messages within the 16MB limit", async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    const mock = new MockWebSocket();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = function () {
      return mock;
    };

    try {
      const transport = new WebSocketTransport();
      const connectPromise = transport.connect("ws://test");
      mock.readyState = MockWebSocket.OPEN;
      mock.onopen?.();
      await connectPromise;

      // send a small valid message (4-byte ping header)
      const buf = new ArrayBuffer(4);
      const view = new Uint8Array(buf);
      view[0] = 0xff; view[1] = 0xff;
      mock.onmessage?.({ data: buf });

      expect(mock.closeCode).toBe(null);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
    }
  });
});

describe("security: safe JSON parse", () => {
  it("should block prototype pollution via __proto__", () => {
    const parsed = safeJsonParse<Record<string, unknown>>('{"__proto__":{"polluted":true}}');
    // Object.prototype must not be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // the __proto__ key must be stripped as an own property
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
  });

  it("should block constructor pollution", () => {
    const parsed = safeJsonParse<Record<string, unknown>>('{"constructor":{"prototype":{"polluted":true}}}');
    // Object.prototype must not be polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // the constructor key must be stripped as an own property
    expect(Object.prototype.hasOwnProperty.call(parsed, "constructor")).toBe(false);
  });

  it("should still parse normal objects", () => {
    const parsed = safeJsonParse<{ a: number; b: string }>('{"a":1,"b":"hi"}');
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe("hi");
  });

  it("should throw on invalid JSON", () => {
    expect(() => safeJsonParse("not json")).toThrow();
  });
});

describe("security: ICE candidate validation", () => {
  it("should accept a valid ICE candidate", () => {
    const candidate = {
      candidate: "candidate:842163049 1 udp 1677729535 192.0.2.3 64052 typ srflx",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    expect(isValidIceCandidate(candidate)).toBe(true);
  });

  it("should accept an ICE candidate with null sdpMid/sdpMLineIndex", () => {
    const candidate = {
      candidate: "candidate:842163049 1 udp 1677729535 192.0.2.3 64052 typ srflx",
      sdpMid: null,
      sdpMLineIndex: null,
    };
    expect(isValidIceCandidate(candidate)).toBe(true);
  });

  it("should reject an ICE candidate with missing candidate string", () => {
    const candidate = { sdpMid: "0", sdpMLineIndex: 0 };
    expect(isValidIceCandidate(candidate)).toBe(false);
  });

  it("should reject an ICE candidate with wrong sdpMid type", () => {
    const candidate = { candidate: "c", sdpMid: 123, sdpMLineIndex: 0 };
    expect(isValidIceCandidate(candidate)).toBe(false);
  });

  it("should reject an ICE candidate with wrong sdpMLineIndex type", () => {
    const candidate = { candidate: "c", sdpMid: "0", sdpMLineIndex: "0" };
    expect(isValidIceCandidate(candidate)).toBe(false);
  });

  it("should reject non-object ICE candidates", () => {
    expect(isValidIceCandidate(null)).toBe(false);
    expect(isValidIceCandidate("candidate")).toBe(false);
    expect(isValidIceCandidate(42)).toBe(false);
    expect(isValidIceCandidate(undefined)).toBe(false);
  });
});
