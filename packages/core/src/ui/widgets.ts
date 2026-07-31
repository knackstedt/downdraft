import { UIPanel, UIText, UIButton, UIElement, type UIDrawable, type UIColor } from "./element.ts";

export class UIProgressBar extends UIElement {
  value: number = 0;
  maxValue: number = 1;
  barColor: UIColor = [0.3, 0.6, 0.3, 1.0];
  trackColor: UIColor = [0.15, 0.15, 0.18, 0.8];
  label: string = "";
  showLabel: boolean = false;

  constructor(width: number = 100, height: number = 12) {
    super("progressbar");
    this.width = width;
    this.height = height;
    this.style.backgroundColor = [0, 0, 0, 0];
    this.style.borderWidth = 0;
  }

  setValue(v: number): void {
    this.value = Math.max(0, Math.min(v, this.maxValue));
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const drawables: UIDrawable[] = [];
    const pct = this.maxValue > 0 ? this.value / this.maxValue : 0;
    const barW = this.width * pct;

    drawables.push({
      kind: "rect",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [...this.trackColor] as UIColor,
      borderRadius: this.style.borderRadius,
      borderWidth: this.style.borderWidth,
      borderColor: [...this.style.borderColor] as UIColor,
    });

    if (barW > 0) {
      drawables.push({
        kind: "rect",
        x: this.x,
        y: this.y,
        width: barW,
        height: this.height,
        color: [...this.barColor] as UIColor,
        borderRadius: this.style.borderRadius,
        borderWidth: 0,
        borderColor: [0, 0, 0, 0],
      });
    }

    if (this.showLabel && this.label) {
      drawables.push({
        kind: "text",
        x: this.x + 4,
        y: this.y,
        width: this.width - 8,
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
    }

    return drawables;
  }
}

export class UISlider extends UIElement {
  value: number = 0;
  minValue: number = 0;
  maxValue: number = 1;
  trackColor: UIColor = [0.2, 0.2, 0.25, 0.8];
  handleColor: UIColor = [0.5, 0.6, 0.8, 1.0];
  handleSize: number = 16;
  onValueChange: ((value: number) => void) | null = null;
  private dragging: boolean = false;

  constructor(width: number = 120, height: number = 20) {
    super("slider");
    this.width = width;
    this.height = height;
    this.focusable = true;
    this.style.backgroundColor = [0, 0, 0, 0];
  }

  setValue(v: number): void {
    this.value = Math.max(this.minValue, Math.min(v, this.maxValue));
  }

  getHandleX(): number {
    const pct = (this.value - this.minValue) / (this.maxValue - this.minValue);
    return this.x + pct * (this.width - this.handleSize);
  }

  hitTest(px: number, py: number): UIElement | null {
    if (!this.visible) return null;
    const hx = this.getHandleX();
    if (px >= hx && px <= hx + this.handleSize && py >= this.y && py <= this.y + this.height) {
      return this;
    }
    if (px >= this.x && px <= this.x + this.width && py >= this.y + (this.height - 4) / 2 && py <= this.y + (this.height + 4) / 2) {
      return this;
    }
    return null;
  }

  handlePress(px: number, _py: number): void {
    this.dragging = true;
    this.updateFromMouse(px);
  }

  handleRelease(): void {
    this.dragging = false;
  }

  handleDrag(px: number, _py: number): void {
    if (this.dragging) {
      this.updateFromMouse(px);
    }
  }

  private updateFromMouse(px: number): void {
    const pct = Math.max(0, Math.min(1, (px - this.x) / this.width));
    const newValue = this.minValue + pct * (this.maxValue - this.minValue);
    if (newValue !== this.value) {
      this.value = newValue;
      this.onValueChange?.(newValue);
    }
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const drawables: UIDrawable[] = [];
    const trackY = this.y + (this.height - 4) / 2;
    const hx = this.getHandleX();

    drawables.push({
      kind: "rect",
      x: this.x,
      y: trackY,
      width: this.width,
      height: 4,
      color: [...this.trackColor] as UIColor,
      borderRadius: 2,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
    });

    drawables.push({
      kind: "rect",
      x: hx,
      y: this.y + (this.height - this.handleSize) / 2,
      width: this.handleSize,
      height: this.handleSize,
      color: [...this.handleColor] as UIColor,
      borderRadius: this.handleSize / 2,
      borderWidth: this.style.borderWidth,
      borderColor: [...this.style.borderColor] as UIColor,
    });

    return drawables;
  }
}

export class UIToggle extends UIElement {
  checked: boolean = false;
  onColor: UIColor = [0.3, 0.6, 0.3, 1.0];
  offColor: UIColor = [0.3, 0.3, 0.35, 1.0];
  knobColor: UIColor = [1, 1, 1, 1];
  label: string = "";
  onToggle: ((checked: boolean) => void) | null = null;

  constructor(width: number = 40, height: number = 20) {
    super("toggle");
    this.width = width;
    this.height = height;
    this.focusable = true;
  }

  toggle(): void {
    this.checked = !this.checked;
    this.onToggle?.(this.checked);
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const drawables: UIDrawable[] = [];
    const bg = this.checked ? this.onColor : this.offColor;
    const knobSize = this.height - 4;
    const knobX = this.checked ? this.x + this.width - knobSize - 2 : this.x + 2;

    drawables.push({
      kind: "rect",
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      color: [...bg] as UIColor,
      borderRadius: this.height / 2,
      borderWidth: this.style.borderWidth,
      borderColor: [...this.style.borderColor] as UIColor,
    });

    drawables.push({
      kind: "rect",
      x: knobX,
      y: this.y + 2,
      width: knobSize,
      height: knobSize,
      color: [...this.knobColor] as UIColor,
      borderRadius: knobSize / 2,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
    });

    if (this.label) {
      drawables.push({
        kind: "text",
        x: this.x + this.width + 8,
        y: this.y,
        width: 0,
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
        textAlign: "left",
      });
    }

    return drawables;
  }
}

export class UITabBar extends UIPanel {
  tabs: { id: string; label: string }[] = [];
  activeTabId: string = "";
  onTabChange: ((id: string) => void) | null = null;
  tabHeight: number = 32;
  activeColor: UIColor = [0.15, 0.2, 0.3, 0.95];
  inactiveColor: UIColor = [0.1, 0.1, 0.12, 0.5];

  constructor(width: number = 0) {
    super(width, 32);
    this.layoutMode = "horizontal";
  }

  setTabs(tabs: { id: string; label: string }[]): void {
    this.tabs = tabs;
    if (tabs.length > 0 && !this.activeTabId) {
      this.activeTabId = tabs[0].id;
    }
    this.rebuildTabs();
  }

  setActiveTab(id: string): void {
    this.activeTabId = id;
    this.onTabChange?.(id);
  }

  private rebuildTabs(): void {
    this.children = [];
    for (const tab of this.tabs) {
      const btn = new UIButton(tab.label, 80, this.tabHeight);
      btn.style.fontSize = 11;
      btn.style.fontWeight = "bold";
      btn.style.backgroundColor = tab.id === this.activeTabId ? [...this.activeColor] : [...this.inactiveColor];
      btn.callbacks.onClick = () => this.setActiveTab(tab.id);
      this.addChild(btn);
    }
  }
}

export class UIModal extends UIPanel {
  backdropColor: UIColor = [0, 0, 0, 0.6];
  onDismiss: (() => void) | null = null;
  private backdrop: UIPanel;

  constructor(width: number, height: number) {
    super(width, height);
    this.style.backgroundColor = [0.1, 0.1, 0.14, 0.95];
    this.style.borderColor = [0.3, 0.3, 0.35, 1.0];
    this.style.borderWidth = 1;
    this.style.borderRadius = 8;
    this.style.padding = [16, 16, 16, 16];
    this.layoutMode = "vertical";

    this.backdrop = new UIPanel(0, 0);
    this.backdrop.style.backgroundColor = [...this.backdropColor] as UIColor;
  }

  getDrawable(): UIDrawable[] {
    if (!this.visible) return [];
    const drawables: UIDrawable[] = [];

    drawables.push({
      kind: "rect",
      x: 0,
      y: 0,
      width: 99999,
      height: 99999,
      color: [...this.backdropColor] as UIColor,
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
    });

    drawables.push(...super.getDrawable());
    return drawables;
  }
}

export class UITextInput extends UIElement {
  text: string = "";
  placeholder: string = "";
  cursorPos: number = 0;
  cursorVisible: boolean = true;
  onTextChange: ((text: string) => void) | null = null;
  onEnter: (() => void) | null = null;
  private cursorBlink: number = 0;

  constructor(width: number = 150, height: number = 24) {
    super("textinput");
    this.width = width;
    this.height = height;
    this.focusable = true;
    this.style.backgroundColor = [0.08, 0.08, 0.1, 0.95];
    this.style.borderColor = [0.3, 0.3, 0.35, 1.0];
    this.style.borderWidth = 1;
    this.style.borderRadius = 4;
    this.style.fontSize = 12;
  }

  setText(text: string): void {
    this.text = text;
    this.cursorPos = text.length;
    this.onTextChange?.(text);
  }

  handleKeyDown(code: number): void {
    if (code === 8) {
      if (this.cursorPos > 0) {
        this.text = this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
        this.cursorPos--;
        this.onTextChange?.(this.text);
      }
    } else if (code === 13) {
      this.onEnter?.();
    } else if (code === 46) {
      if (this.cursorPos < this.text.length) {
        this.text = this.text.slice(0, this.cursorPos) + this.text.slice(this.cursorPos + 1);
        this.onTextChange?.(this.text);
      }
    } else if (code === 37) {
      this.cursorPos = Math.max(0, this.cursorPos - 1);
    } else if (code === 39) {
      this.cursorPos = Math.min(this.text.length, this.cursorPos + 1);
    } else if (code === 36) {
      this.cursorPos = 0;
    } else if (code === 35) {
      this.cursorPos = this.text.length;
    }
  }

  handleCharInput(char: string): void {
    this.text = this.text.slice(0, this.cursorPos) + char + this.text.slice(this.cursorPos);
    this.cursorPos++;
    this.onTextChange?.(this.text);
  }

  update(dt: number): void {
    this.cursorBlink += dt;
    this.cursorVisible = Math.floor(this.cursorBlink / 500) % 2 === 0;
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

    const displayText = this.text || this.placeholder;
    const textColor = this.text ? [...this.style.textColor] as UIColor : [0.5, 0.5, 0.55, 1] as UIColor;

    drawables.push({
      kind: "text",
      x: this.x + 6,
      y: this.y + 4,
      width: this.width - 12,
      height: this.height - 8,
      color: [0, 0, 0, 0],
      borderRadius: 0,
      borderWidth: 0,
      borderColor: [0, 0, 0, 0],
      text: displayText,
      fontSize: this.style.fontSize,
      textColor,
      fontFamily: this.style.fontFamily,
      fontWeight: this.style.fontWeight,
      textAlign: "left",
    });

    if (this._focused && this.cursorVisible && this.text) {
      const charW = this.style.fontSize * 0.6;
      const cursorX = this.x + 6 + this.cursorPos * charW;
      drawables.push({
        kind: "rect",
        x: cursorX,
        y: this.y + 4,
        width: 1,
        height: this.height - 8,
        color: [1, 1, 1, 1] as UIColor,
        borderRadius: 0,
        borderWidth: 0,
        borderColor: [0, 0, 0, 0],
      });
    }

    return drawables;
  }
}
