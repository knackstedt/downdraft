// PaintedTexture — stub (Phase 5)
export class PaintedTexture {
  bitmap: Uint8ClampedArray;
  width: number;
  height: number;
  dirty = false;
  dirtyX = 0;
  dirtyY = 0;
  dirtyW = 0;
  dirtyH = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.bitmap = new Uint8ClampedArray(width * height * 4);
  }
}
