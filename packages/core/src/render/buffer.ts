export class RingBuffer {
  private buffer: GPUBuffer | null = null;
  private capacity: number;
  private head: number = 0;
  private alignedSize: number;
  private device: GPUDevice;

  constructor(device: GPUDevice, capacity: number, alignedSize: number = 256) {
    this.device = device;
    this.capacity = capacity;
    this.alignedSize = alignedSize;
    this.buffer = device.createBuffer({
      size: capacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  allocate(size: number): { offset: number; buffer: GPUBuffer } | null {
    if (!this.buffer) return null;
    const aligned = Math.ceil(size / this.alignedSize) * this.alignedSize;
    if (this.head + aligned > this.capacity) {
      this.head = 0;
    }
    const offset = this.head;
    this.head += aligned;
    return { offset, buffer: this.buffer };
  }

  write(data: ArrayBuffer, offset: number = 0): void {
    if (!this.buffer) return;
    this.device.queue.writeBuffer(this.buffer, offset, data);
  }

  reset(): void {
    this.head = 0;
  }

  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
  }
}

export class ArenaBuffer {
  private buffer: GPUBuffer | null = null;
  private capacity: number;
  private offset: number = 0;
  private device: GPUDevice;

  constructor(device: GPUDevice, capacity: number) {
    this.device = device;
    this.capacity = capacity;
    this.buffer = device.createBuffer({
      size: capacity,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  allocate(size: number): number {
    const aligned = Math.ceil(size / 4) * 4;
    if (this.offset + aligned > this.capacity) {
      this.offset = 0;
    }
    const result = this.offset;
    this.offset += aligned;
    return result;
  }

  write(data: ArrayBuffer, offset: number): void {
    if (!this.buffer) return;
    this.device.queue.writeBuffer(this.buffer, offset, data);
  }

  reset(): void {
    this.offset = 0;
  }

  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
  }
}
