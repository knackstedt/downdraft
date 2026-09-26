import { ViewportLayout, viewportRectToPixels } from "./viewport";

describe("ViewportLayout", () => {
  it("should return empty for 0 players", () => {
    expect(ViewportLayout.compute(0, 1920, 1080)).toEqual([]);
  });

  it("should return fullscreen for 1 player", () => {
    const rects = ViewportLayout.compute(1, 1920, 1080);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("should return fullscreen for shared mode regardless of player count", () => {
    const rects = ViewportLayout.compute(4, 1920, 1080, "shared");
    expect(rects).toHaveLength(4);
    rects.forEach((r) => {
      expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    });
  });

  it("should split horizontally for 2 players on landscape", () => {
    const rects = ViewportLayout.compute(2, 1920, 1080, "split");
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rects[1]).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("should split vertically for 2 players on portrait", () => {
    const rects = ViewportLayout.compute(2, 600, 1080, "split");
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(rects[1]).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it("should create 2x2 grid for 3 players", () => {
    const rects = ViewportLayout.compute(3, 1920, 1080, "split");
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects[1]).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(rects[2]).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("should create 2x2 grid for 4 players", () => {
    const rects = ViewportLayout.compute(4, 1920, 1080, "split");
    expect(rects).toHaveLength(4);
    expect(rects[3]).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("should create dynamic grid for 6 players", () => {
    const rects = ViewportLayout.compute(6, 1920, 1080, "split");
    expect(rects).toHaveLength(6);
    const cols = Math.ceil(Math.sqrt(6));
    expect(cols).toBe(3);
    const cellW = 1 / cols;
    expect(rects[0].w).toBeCloseTo(cellW);
  });

  it("should create dynamic grid for 8 players", () => {
    const rects = ViewportLayout.compute(8, 1920, 1080, "split");
    expect(rects).toHaveLength(8);
  });

  it("should convert normalized rect to pixels", () => {
    const px = viewportRectToPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 1920, 1080);
    expect(px).toEqual({ x: 960, y: 540, w: 960, h: 540 });
  });
});
