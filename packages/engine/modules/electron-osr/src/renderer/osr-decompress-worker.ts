// ============================================================================
// OSR Decompression Worker — Inline blob worker factory
// ============================================================================
// Creates a Worker from a Blob URL containing self-contained decompression +
// SAB ring buffer logic. Avoids Vite worker URL resolution issues in workspace
// plugin packages.

const WORKER_SOURCE = `
const HEADER_BYTES = 64;
const SLOT_META_BYTES = 24;

let sab = null;
let i32 = null;
let slotSize = 0;
let slotCount = 0;
let dataOffset = HEADER_BYTES;
let paintPort = null;

function slotByteOffset(slotIndex) {
  return dataOffset + slotIndex * (SLOT_META_BYTES + slotSize);
}

function nextWriteSlot() {
  const writeIdx = Atomics.load(i32, 0);
  const readIdx = Atomics.load(i32, 1);
  const next = (writeIdx + 1) % slotCount;
  if (next === readIdx) return null;
  return writeIdx;
}

function writeSlot(slotIndex, x, y, w, h, fullWidth, fullHeight, data) {
  const offset = slotByteOffset(slotIndex);
  const u32 = new Uint32Array(sab, offset, 6);
  u32[0] = x; u32[1] = y; u32[2] = w; u32[3] = h;
  u32[4] = fullWidth; u32[5] = fullHeight;
  const dataBytes = new Uint8Array(sab, offset + SLOT_META_BYTES, slotSize);
  dataBytes.set(data.subarray(0, Math.min(data.length, slotSize)));
}

function publishSlot(slotIndex) {
  const writeIdx = Atomics.load(i32, 0);
  const next = (writeIdx + 1) % slotCount;
  Atomics.store(i32, 0, next);
  Atomics.add(i32, 2, 1);
  Atomics.notify(i32, 2, 1);
}

function isAlive() {
  return Atomics.load(i32, 5) === 1;
}

async function decompress(data) {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(data));
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let totalLen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function handlePaintData(msg) {
  if (!sab || !isAlive()) return;
  try {
    let raw;
    if (msg.compressed) {
      decompress(msg.data).then((decompressed) => {
        const slot = nextWriteSlot();
        if (slot === null) return;
        writeSlot(slot, msg.x, msg.y, msg.width, msg.height, msg.fullWidth, msg.fullHeight, decompressed);
        publishSlot(slot);
      }).catch((err) => {
        self.postMessage({ type: "error", error: String(err) });
      });
      return;
    }
    raw = new Uint8Array(msg.data);
    const slot = nextWriteSlot();
    if (slot === null) return;
    writeSlot(slot, msg.x, msg.y, msg.width, msg.height, msg.fullWidth, msg.fullHeight, raw);
    publishSlot(slot);
  } catch (err) {
    self.postMessage({ type: "error", error: String(err) });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "init") {
    sab = msg.sab;
    i32 = new Int32Array(sab);
    slotSize = Atomics.load(i32, 3) || 0;
    slotCount = Atomics.load(i32, 4) || 0;
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "port") {
    paintPort = msg.port;
    paintPort.onmessage = (ev) => handlePaintData(ev.data);
    paintPort.start();
    return;
  }

  if (msg.type === "decompress") {
    handlePaintData(msg);
    return;
  }
};
`;

export function createDecompressWorker(): Worker {
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  // Revoke URL after worker loads — worker keeps a reference internally
  worker.addEventListener("message", function onReady(e: MessageEvent) {
    if (e.data?.type === "ready") {
      worker.removeEventListener("message", onReady);
      URL.revokeObjectURL(url);
    }
  });
  return worker;
}
