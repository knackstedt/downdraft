export type UIColor = [number, number, number, number];

export type UIVerticalAlign = "top" | "center" | "bottom";
export type UIHorizontalAlign = "left" | "center" | "right";

export interface UIStyle {
  backgroundColor: UIColor;
  borderColor: UIColor;
  borderWidth: number;
  padding: [number, number, number, number]; // top, right, bottom, left
  margin: [number, number, number, number];
  fontSize: number;
  textColor: UIColor;
  borderRadius: number;
  opacity: number;
  fontFamily: string;
  fontWeight: string;
  textAlign: CanvasTextAlign;
}

export const DEFAULT_STYLE: UIStyle = {
  backgroundColor: [0.1, 0.1, 0.12, 0.9],
  borderColor: [0.3, 0.3, 0.35, 1.0],
  borderWidth: 1,
  padding: [4, 4, 4, 4],
  margin: [0, 0, 0, 0],
  fontSize: 12,
  textColor: [1, 1, 1, 1],
  borderRadius: 0,
  opacity: 1.0,
  fontFamily: "sans-serif",
  fontWeight: "normal",
  textAlign: "left",
};

export type UILayoutMode = "absolute" | "vertical" | "horizontal" | "grid";

export interface UICallbacks {
  onClick?: (el: UIElement) => void;
  onHover?: (el: UIElement) => void;
  onPress?: (el: UIElement) => void;
  onRelease?: (el: UIElement) => void;
  onFocus?: (el: UIElement) => void;
  onBlur?: (el: UIElement) => void;
  onKeyDown?: (el: UIElement, code: number) => void;
  onKeyUp?: (el: UIElement, code: number) => void;
}

let nextId = 0;

export abstract class UIElement {
  readonly id: number;
  type: string;
  name: string = "";
  visible: boolean = true;
  enabled: boolean = true;
  focusable: boolean = false;

  x: number = 0;
  y: number = 0;
  width: number = 0;
  height: number = 0;

  layoutMode: UILayoutMode = "absolute";
  style: UIStyle = { ...DEFAULT_STYLE };

  parent: UIElement | null = null;
  children: UIElement[] = [];

  callbacks: UICallbacks = {};

  protected _focused: boolean = false;
  protected _hovered: boolean = false;
  protected _pressed: boolean = false;

  constructor(type: string) {
    this.id = nextId++;
    this.type = type;
  }

  addChild<T extends UIElement>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: UIElement): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parent = null;
    }
  }

  removeChildren(): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
  }

  getFocused(): boolean {
    return this._focused;
  }

  getHovered(): boolean {
    return this._hovered;
  }

  getPressed(): boolean {
    return this._pressed;
  }

  setFocused(focused: boolean): void {
    if (this._focused === focused) return;
    this._focused = focused;
    if (focused) {
      this.callbacks.onFocus?.(this);
    } else {
      this.callbacks.onBlur?.(this);
    }
  }

  setHovered(hovered: boolean): void {
    if (this._hovered === hovered) return;
    this._hovered = hovered;
    if (hovered) {
      this.callbacks.onHover?.(this);
    }
  }

  setPressed(pressed: boolean): void {
    if (this._pressed === pressed) return;
    this._pressed = pressed;
    if (pressed) {
      this.callbacks.onPress?.(this);
    } else {
      this.callbacks.onRelease?.(this);
    }
  }

  hitTest(px: number, py: number): UIElement | null {
    if (!this.visible || !this.enabled) return null;
    if (px < this.x || px >= this.x + this.width || py < this.y || py >= this.y + this.height) {
      return null;
    }
    // Convert screen coordinates to local coordinates for children
    const localX = px - this.x;
    const localY = py - this.y;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTest(localX, localY);
      if (hit) return hit;
    }
    return this;
  }

  abstract getDrawable(): UIDrawable[];
}

export interface UIDrawable {
  kind: "rect" | "text" | "image" | "lines";
  x: number;
  y: number;
  width: number;
  height: number;
  color: UIColor;
  borderRadius: number;
  borderWidth: number;
  borderColor: UIColor;
  text?: string;
  fontSize?: number;
  textColor?: UIColor;
  fontFamily?: string;
  fontWeight?: string;
  textAlign?: CanvasTextAlign;
  maxWidth?: number;
  textureView?: GPUTextureView;
  uv?: [number, number, number, number];
  lines?: number[]; // flat array: x1,y1,x2,y2,color(r,g,b,a) per segment
  lineWidth?: number;
}

export class UIPanel extends UIElement {
  constructor(width: number = 0, height: number = 0) {
    super("panel");
    this.width = width;
    this.height = height;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const drawables: UIDrawable[] = [];
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
    for (const child of this.children) {
      if (!child.visible) continue;
      // Children's coordinates are local to this panel. Offset them by
      // this panel's position so drawables are in the parent's coordinate
      // system (i.e. screen space at the root level). This cascades
      // correctly through nested panels.
      const childDrawables = child.getDrawable();
      for (const d of childDrawables) {
        d.x += this.x;
        d.y += this.y;
      }
      drawables.push(...childDrawables);
    }
    return drawables;
  }
}

export class UIText extends UIElement {
  text: string;
  valign: UIVerticalAlign = "top";
  halign: UIHorizontalAlign = "left";

  constructor(text: string = "", width: number = 0, height: number = 0) {
    super("text");
    this.text = text;
    this.width = width;
    this.height = height;
  }

  setText(text: string): void {
    this.text = text;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    return [{
      kind: "text",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [0, 0, 0, 0],
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
      text: this.text,
      fontSize: this.style.fontSize,
      textColor: [...this.style.textColor] as UIColor,
      fontFamily: this.style.fontFamily,
      fontWeight: this.style.fontWeight,
      textAlign: this.style.textAlign,
    }];
  }
}

export class UIButton extends UIElement {
  label: string;

  constructor(label: string = "Button", width: number = 100, height: number = 30) {
    super("button");
    this.label = label;
    this.width = width;
    this.height = height;
    this.focusable = true;
    this.style.backgroundColor = [0.15, 0.2, 0.3, 0.95];
    this.style.borderColor = [0.4, 0.5, 0.7, 1.0];
    this.style.borderWidth = 1;
    this.style.borderRadius = 4;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const bg = this._pressed
      ? ([0.1, 0.15, 0.2, 0.95] as UIColor)
      : this._hovered
        ? ([0.2, 0.28, 0.4, 0.95] as UIColor)
        : ([...this.style.backgroundColor] as UIColor);

    const drawables: UIDrawable[] = [];
    drawables.push({
      kind: "rect",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: bg,
      borderRadius: this.style.borderRadius,
      borderWidth: this.style.borderWidth,
      borderColor: [...this.style.borderColor] as UIColor,
    });
    drawables.push({
      kind: "text",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [0, 0, 0, 0],
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
      text: this.label,
      fontSize: this.style.fontSize,
      textColor: [...this.style.textColor] as UIColor,
      fontFamily: this.style.fontFamily,
      fontWeight: this.style.fontWeight,
      textAlign: "center",
    });
    return drawables;
  }
}

export class UIImage extends UIElement {
  textureView: GPUTextureView | null = null;
  uv: [number, number, number, number] = [0, 0, 1, 1];
  tint: UIColor = [1, 1, 1, 1];

  constructor(width: number = 0, height: number = 0) {
    super("image");
    this.width = width;
    this.height = height;
  }

  setTexture(view: GPUTextureView, uv?: [number, number, number, number]): void {
    this.textureView = view;
    if (uv) this.uv = uv;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible || !this.textureView) return [];
    return [{
      kind: "image",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [...this.tint] as UIColor,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
      textureView: this.textureView,
      uv: this.uv,
    }];
  }
}

export class UILine extends UIElement {
  segments: number[] = []; // flat: x1,y1,x2,y2 per segment
  lineWidth: number = 1.5;
  lineColor: UIColor = [1, 1, 1, 1];

  constructor() {
    super("lines");
  }

  setSegments(segments: number[]): void {
    this.segments = segments;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible || this.segments.length === 0) return [];
    return [{
      kind: "lines",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [...this.lineColor] as UIColor,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
      lines: this.segments,
      lineWidth: this.lineWidth,
    }];
  }
}

export class UIRoot extends UIPanel {
  constructor(width: number, height: number) {
    super(width, height);
    this.type = "root";
    this.style.backgroundColor = [0, 0, 0, 0];
  }
}
