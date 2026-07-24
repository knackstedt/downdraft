import { RenderGraph, type RenderPassDescriptor, type RenderResource } from "./render-graph.ts";

describe("RenderGraph", () => {
  it("should add passes", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    expect(rg.getPasses().length).toBe(1);
    expect(rg.getPasses()[0].name).toBe("pass1");
  });

  it("should register resources", () => {
    const rg = new RenderGraph();
    const res: RenderResource = { name: "color", type: "texture", format: "rgba8" };
    rg.registerResource(res);
    expect(rg.getPasses().length).toBe(0);
  });

  it("should validate with no errors for valid graph", () => {
    const rg = new RenderGraph();
    rg.registerResource({ name: "depth", type: "texture", format: "depth" });
    rg.addPass({ name: "pass1", inputs: ["depth"], outputs: ["color"] });
    rg.addPass({ name: "pass2", inputs: ["color"], outputs: ["final"] });

    const errors = rg.validate();
    expect(errors.length).toBe(0);
  });

  it("should validate with errors for unproduced inputs", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: ["missing"], outputs: ["color"] });

    const errors = rg.validate();
    expect(errors.length).toBe(1);
    expect(errors[0].pass).toBe("pass1");
    expect(errors[0].resource).toBe("missing");
  });

  it("should not report errors for inputs produced by earlier passes", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    rg.addPass({ name: "pass2", inputs: ["color"], outputs: ["final"] });

    const errors = rg.validate();
    expect(errors.length).toBe(0);
  });

  it("should topological sort passes in dependency order", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    rg.addPass({ name: "pass2", inputs: ["color"], outputs: ["final"] });

    const order = rg.topologicalSort();
    expect(order).toContain("pass1");
    expect(order).toContain("pass2");
    expect(order.indexOf("pass1")).toBeLessThan(order.indexOf("pass2"));
  });

  it("should handle independent passes in topological sort", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "a", inputs: [], outputs: ["a_out"] });
    rg.addPass({ name: "b", inputs: [], outputs: ["b_out"] });
    rg.addPass({ name: "c", inputs: ["a_out", "b_out"], outputs: ["c_out"] });

    const order = rg.topologicalSort();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("should cache execution order", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });

    const order1 = rg.getExecutionOrder();
    const order2 = rg.getExecutionOrder();
    expect(order1).toBe(order2);
  });

  it("should invalidate execution order cache on new pass", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    rg.getExecutionOrder();

    rg.addPass({ name: "pass2", inputs: ["color"], outputs: ["final"] });
    const order = rg.getExecutionOrder();
    expect(order.length).toBe(2);
  });

  it("should resolve aliasing for non-overlapping lifetimes", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["a"] });
    rg.addPass({ name: "pass2", inputs: ["a"], outputs: ["b"] });
    rg.addPass({ name: "pass3", inputs: ["b"], outputs: ["c"] });

    rg.resolveAliasing();
    const aliasing = rg.getAliasing();
    expect(aliasing.size).toBeGreaterThan(0);
  });

  it("should not alias overlapping lifetimes", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["a"] });
    rg.addPass({ name: "pass2", inputs: ["a"], outputs: ["b"] });

    rg.resolveAliasing();
    const aliasing = rg.getAliasing();
    expect(aliasing.has("a")).toBe(false);
  });

  it("should clear all passes and resources", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    rg.registerResource({ name: "depth", type: "texture" });
    rg.clear();

    expect(rg.getPasses().length).toBe(0);
  });

  it("should handle empty graph validation", () => {
    const rg = new RenderGraph();
    expect(rg.validate().length).toBe(0);
  });

  it("should handle empty graph topological sort", () => {
    const rg = new RenderGraph();
    expect(rg.topologicalSort()).toEqual([]);
  });

  it("syncUsageFlags should not throw", () => {
    const rg = new RenderGraph();
    rg.addPass({ name: "pass1", inputs: [], outputs: ["color"] });
    expect(() => rg.syncUsageFlags()).not.toThrow();
  });
});
