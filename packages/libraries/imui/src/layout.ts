import type { UIElement } from "./element";
import type { TextAtlasCache } from "./text-cache";

export class LayoutEngine {
  private textCache: TextAtlasCache | null = null;

  setTextCache(cache: TextAtlasCache | null): void {
    this.textCache = cache;
  }

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
    } else if (el.layoutMode === "grid") {
      const cols = (el as unknown as { gridColumns: number }).gridColumns || 1;
      const gap = (el as unknown as { gridGap: number }).gridGap || 0;
      let cursorX = innerX;
      let cursorY = innerY;
      let col = 0;
      const cellW = (innerW - gap * (cols - 1)) / cols;
      for (const child of el.children) {
        if (!child.visible) continue;
        if (col >= cols) {
          col = 0;
          cursorX = innerX;
          cursorY += child.height + gap;
        }
        child.x = cursorX - innerX;
        child.y = cursorY - innerY;
        if (child.width === 0 || child.width < cellW) {
          child.width = cellW;
        }
        this.layoutElement(child, cursorX, cursorY);
        cursorX += cellW + gap;
        col++;
      }
    }
  }

  measureText(text: string, fontSize: number, fontFamily?: string, fontWeight?: string): { width: number; height: number } {
    if (this.textCache && fontFamily) {
      return this.textCache.measureText(text, {
        fontFamily,
        fontSize,
        fontWeight: fontWeight ?? "normal",
        color: "#fff",
        textAlign: "left",
        textBaseline: "top",
      });
    }
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
      const measured = this.measureText(text, el.style.fontSize, el.style.fontFamily, el.style.fontWeight);
      if (el.width === 0) el.width = measured.width + el.style.padding[1] + el.style.padding[3];
      if (el.height === 0) el.height = measured.height + el.style.padding[0] + el.style.padding[2];
    }
    for (const child of el.children) {
      this.autoSize(child);
    }
  }
}
