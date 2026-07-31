import { UIPanel, type UIColor, type UIDrawable } from "./element.ts";

export class UIScrollPanel extends UIPanel {
  scrollX: number = 0;
  scrollY: number = 0;
  contentWidth: number = 0;
  contentHeight: number = 0;
  showScrollbar: boolean = true;
  scrollbarWidth: number = 8;
  scrollbarColor: UIColor = [0.5, 0.5, 0.55, 0.6];
  scrollbarHandleColor: UIColor = [0.7, 0.7, 0.75, 0.9];
  private wheelHandler: ((e: WheelEvent) => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor(width: number = 0, height: number = 0) {
    super(width, height);
    this.style.backgroundColor = [0, 0, 0, 0];
    this.style.borderColor = [0.3, 0.3, 0.35, 0.5];
    this.style.borderWidth = 0;
    this.layoutMode = "absolute";
  }

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    if (this.wheelHandler) {
      this.canvas.removeEventListener("wheel", this.wheelHandler);
    }
    this.wheelHandler = (e: WheelEvent) => {
      const rect = this.canvas!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (!this.hitTest(px, py)) return;
      e.preventDefault();
      this.scrollY += e.deltaY;
      this.clampScroll();
    };
    canvas.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  setScrollY(y: number): void {
    this.scrollY = y;
    this.clampScroll();
  }

  setScrollX(x: number): void {
    this.scrollX = x;
    this.clampScroll();
  }

  private clampScroll(): void {
    const maxScrollY = Math.max(0, this.contentHeight - this.height);
    const maxScrollX = Math.max(0, this.contentWidth - this.width);
    this.scrollY = Math.max(0, Math.min(this.scrollY, maxScrollY));
    this.scrollX = Math.max(0, Math.min(this.scrollX, maxScrollX));
  }

  updateContentSize(): void {
    let maxW = 0;
    let maxH = 0;
    for (const child of this.children) {
      maxW = Math.max(maxW, child.x + child.width);
      maxH = Math.max(maxH, child.y + child.height);
    }
    this.contentWidth = maxW;
    this.contentHeight = maxH;
  }

  getScrollOffset(): { x: number; y: number } {
    return { x: -this.scrollX, y: -this.scrollY };
  }

  getClipRect(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  override getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    this.updateContentSize();

    const drawables: UIDrawable[] = [];

    if (this.style.backgroundColor[3] > 0 || this.style.borderWidth > 0) {
      drawables.push({
        kind: "rect",
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        color: [...this.style.backgroundColor] as UIColor,
        borderRadius: this.style.borderRadius,
        borderWidth: this.style.borderWidth,
        borderColor: [...this.style.borderColor] as UIColor,
      });
    }

    for (const child of this.children) {
      if (!child.visible) continue;
      child.x -= this.scrollX;
      child.y -= this.scrollY;
      const childDrawables = child.getDrawable();
      for (const d of childDrawables) {
        if (d.y + d.height < this.y || d.y > this.y + this.height ||
            d.x + d.width < this.x || d.x > this.x + this.width) {
          continue;
        }
        drawables.push(d);
      }
      child.x += this.scrollX;
      child.y += this.scrollY;
    }

    if (this.showScrollbar && this.contentHeight > this.height) {
      const trackH = this.height;
      const handleH = Math.max(20, (this.height / this.contentHeight) * trackH);
      const handleY = this.y + (this.scrollY / Math.max(1, this.contentHeight - this.height)) * (trackH - handleH);
      const sbX = this.x + this.width - this.scrollbarWidth;

      drawables.push({
        kind: "rect",
        x: sbX,
        y: this.y,
        width: this.scrollbarWidth,
        height: trackH,
        color: [...this.scrollbarColor] as UIColor,
        borderRadius: 4,
        borderWidth: 0,
        borderColor: [0, 0, 0, 0],
      });
      drawables.push({
        kind: "rect",
        x: sbX,
        y: handleY,
        width: this.scrollbarWidth,
        height: handleH,
        color: [...this.scrollbarHandleColor] as UIColor,
        borderRadius: 4,
        borderWidth: 0,
        borderColor: [0, 0, 0, 0],
      });
    }

    return drawables;
  }

  destroy(): void {
    if (this.canvas && this.wheelHandler) {
      this.canvas.removeEventListener("wheel", this.wheelHandler);
    }
    this.wheelHandler = null;
    this.canvas = null;
  }
}
