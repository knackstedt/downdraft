// ============================================================================
// BlitzUiRouter — drop-in replacement for the engine's UIInputRouter.
//
// The engine's InputManager already delivers window-level mouse/wheel events
// converted to canvas *backing-pixel* coordinates — exactly what the wasm
// exports expect. Keyboard events need the full KeyboardEvent (key/code/mods)
// which InputManager doesn't pass, so the router registers its own key
// listeners in attachKeyboard()/detachKeyboard().
// ============================================================================

import { UIInputRouter } from "@downdraft/engine";

/** The subset of the generated wasm-bindgen module the router uses. */
export interface BlitzWasmInput {
    ui_pointer(kind: number, x: number, y: number, button: number, mods: number): void;
    ui_pointer_leave(): void;
    ui_wheel(dx: number, dy: number, x: number, y: number, mods: number): void;
    ui_key(pressed: boolean, key: string, code: string, mods: number, text?: string): void;
    ui_hit_test(x: number, y: number): boolean;
}

export class BlitzUiRouter extends UIInputRouter {
    private lastX = -1;
    private lastY = -1;
    private mods = 0;
    private keyDown: (e: KeyboardEvent) => void;
    private keyUp: (e: KeyboardEvent) => void;

    constructor(private wasm: BlitzWasmInput) {
        super();
        this.keyDown = (e) => {
            this.mods = modBits(e);
            this.wasm.ui_key(true, e.key, e.code, this.mods, e.key.length === 1 ? e.key : undefined);
        };
        this.keyUp = (e) => {
            this.mods = modBits(e);
            this.wasm.ui_key(false, e.key, e.code, this.mods);
        };
    }

    /** Register the router's own keyboard listeners (call once on mount). */
    attachKeyboard(): void {
        window.addEventListener("keydown", this.keyDown);
        window.addEventListener("keyup", this.keyUp);
    }

    detachKeyboard(): void {
        window.removeEventListener("keydown", this.keyDown);
        window.removeEventListener("keyup", this.keyUp);
    }

    override handleMouseMove(mx: number, my: number): void {
        this.lastX = mx;
        this.lastY = my;
        this.wasm.ui_pointer(0, mx, my, 0, this.mods);
    }

    override handleMouseDown(mx: number, my: number): void {
        this.lastX = mx;
        this.lastY = my;
        this.wasm.ui_pointer(1, mx, my, 0, this.mods);
    }

    override handleMouseUp(mx: number, my: number): void {
        this.lastX = mx;
        this.lastY = my;
        this.wasm.ui_pointer(2, mx, my, 0, this.mods);
    }

    override handleWheel(dx: number, dy: number): boolean {
        // DOM WheelEvent deltas (+y = scroll down) → Blitz wheel-delta
        // semantics (+y = scroll up / decreases the scroll offset).
        this.wasm.ui_wheel(-dx, -dy, this.lastX, this.lastY, this.mods);
        // Consume the event when over an interactive element so the page
        // doesn't scroll behind a scrollable panel.
        return this.isPointerOverUI();
    }

    override handlePointerLeave(): void {
        this.lastX = -1;
        this.lastY = -1;
        this.wasm.ui_pointer_leave();
    }

    override getPointerPos(): [number, number] {
        return [this.lastX, this.lastY];
    }

    /** Hit-test the live document at the last pointer position. */
    override isPointerOverUI(): boolean {
        return this.lastX >= 0 && this.wasm.ui_hit_test(this.lastX, this.lastY);
    }

    // Key routing happens through our own listeners (InputManager only passes
    // keyCode, which can't reconstruct `key`). Base no-ops are fine.
    override handleKeyDown(_code: number): void {}
    override handleKeyUp(_code: number): void {}
    override handleCharInput(_char: string): void {}
}

function modBits(e: KeyboardEvent | MouseEvent | WheelEvent): number {
    return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}
