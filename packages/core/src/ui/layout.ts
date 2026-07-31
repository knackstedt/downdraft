import type { UIElement } from "./element.ts";

export class LayoutEngine {
  layout(root: UIElement): void {
    this.layoutElement(root, 0, 0);
  }

  private layoutElement(el: UIElement, parentX: number, parentY: number): void {
    const [pt, pr, pb, pl] = el.style.padding;
    const innerX = parentX + el.x + pl;
    const innerY = parentY + el.y + pt;
    const innerW = el.width - pl - pr;
    const innerH = el.height - pt - pb;

    if (el.layoutMode === "absolute") {
      for (const child of el.children) {
        this.layoutElement(child, innerX, innerY);
      }
    } else if (el.layoutMode === "vertical") {
      let cursorY = innerY;
      for (const child of el.children) {
        if (!child.visible) continue;
        const [mt, mr, mb, ml] = child.style.margin;
        child.x = ml;
        child.y = cursorY - innerY + mt;
        this.layoutElement(child, innerX, cursorY + mt);
        cursorY += child.height + mt + mb;
      }
    } else if (el.layoutMode === "horizontal") {
      let cursorX = innerX;
      for (const child of el.children) {
        if (!child.visible) continue;
        const [mt, mr, mb, ml] = child.style.margin;
        child.x = cursorX - innerX + ml;
        child.y = mt;
        this.layoutElement(child, cursorX + ml, innerY);
        cursorX += child.width + ml + mr;
      }
    }
  }

  measureText(text: string, fontSize: number): { width: number; height: number } {
    const charW = fontSize * 0.6;
    const charH = fontSize * 1.2;
    const lines = text.split("\n");
    let maxW = 0;
    for (const line of lines) {
      const w = line.length * charW;
      if (w > maxW) maxW = w;
    }
    return { width: maxW, height: lines.length * charH };
  }

  autoSize(el: UIElement): void {
    if (el.type === "text") {
      const text = (el as unknown as { text: string }).text;
      const measured = this.measureText(text, el.style.fontSize);
      if (el.width === 0) el.width = measured.width + el.style.padding[1] + el.style.padding[3];
      if (el.height === 0) el.height = measured.height + el.style.padding[0] + el.style.padding[2];
    }
    for (const child of el.children) {
      this.autoSize(child);
    }
  }
}
