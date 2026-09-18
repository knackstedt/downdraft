// ============================================================================
// OSR Module Tests — Atlas HTML generation, instance packing, input routing
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
    buildAddPanelCall,
    buildRemovePanelCall,
    buildSetContentCall,
    buildUpdateDataCall,
    buildUpdatePanelCall,
    escapeJSString,
    generateAtlasHTML,
    generateDedicatedHTML,
} from "../src/main/atlas-html";
import type { AtlasPanelRect } from "../src/types";

describe("atlas-html", () => {
  describe("generateAtlasHTML", () => {
    it("should generate valid HTML with correct dimensions", () => {
      const html = generateAtlasHTML(1024, 768);
      expect(html).toContain("1024px");
      expect(html).toContain("768px");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("atlas-container");
    });

    it("should include panel management functions", () => {
      const html = generateAtlasHTML(512, 512);
      expect(html).toContain("__osrAddPanel");
      expect(html).toContain("__osrRemovePanel");
      expect(html).toContain("__osrUpdatePanel");
      expect(html).toContain("__osrUpdateData");
    });
  });

  describe("generateDedicatedHTML", () => {
    it("should generate HTML with correct dimensions", () => {
      const html = generateDedicatedHTML(800, 600);
      expect(html).toContain("800px");
      expect(html).toContain("600px");
      expect(html).toContain("osr-content");
    });

    it("should include content and data update functions", () => {
      const html = generateDedicatedHTML(256, 256);
      expect(html).toContain("__osrSetContent");
      expect(html).toContain("__osrUpdateData");
    });
  });

  describe("escapeJSString", () => {
    it("should escape backslashes", () => {
      expect(escapeJSString("hello\\world")).toBe("hello\\\\world");
    });

    it("should escape single quotes", () => {
      expect(escapeJSString("it's")).toBe("it\\'s");
    });

    it("should escape newlines", () => {
      expect(escapeJSString("line1\nline2")).toBe("line1\\nline2");
    });

    it("should escape carriage returns", () => {
      expect(escapeJSString("line1\rline2")).toBe("line1\\rline2");
    });

    it("should handle empty strings", () => {
      expect(escapeJSString("")).toBe("");
    });
  });

  describe("buildAddPanelCall", () => {
    it("should build a valid JS call string", () => {
      const rect: AtlasPanelRect = { x: 0, y: 0, w: 256, h: 128 };
      const call = buildAddPanelCall("panel1", rect, "<div>Hello</div>");
      expect(call).toContain("__osrAddPanel");
      expect(call).toContain("'panel1'");
      expect(call).toContain("0, 0, 256, 128");
      expect(call).toContain("<div>Hello</div>");
    });

    it("should escape HTML content", () => {
      const rect: AtlasPanelRect = { x: 10, y: 20, w: 100, h: 50 };
      const call = buildAddPanelCall("test", rect, "<div class='foo'>It's</div>");
      // Single quotes in the HTML should be escaped with backslash
      expect(call).toContain("class=\\'foo\\'");
      expect(call).toContain("It\\'s</div>");
    });
  });

  describe("buildRemovePanelCall", () => {
    it("should build a valid JS call string", () => {
      const call = buildRemovePanelCall("panel1");
      expect(call).toBe("window.__osrRemovePanel('panel1');");
    });
  });

  describe("buildUpdatePanelCall", () => {
    it("should build a valid JS call string", () => {
      const call = buildUpdatePanelCall("panel1", "<span>Updated</span>");
      expect(call).toContain("__osrUpdatePanel");
      expect(call).toContain("'panel1'");
      expect(call).toContain("<span>Updated</span>");
    });
  });

  describe("buildUpdateDataCall", () => {
    it("should build a valid JS call with JSON values", () => {
      const call = buildUpdateDataCall("panel1", { health: 100, name: "Player", active: true });
      expect(call).toContain("__osrUpdateData");
      expect(call).toContain("'panel1'");
      expect(call).toContain('"health":100');
      expect(call).toContain('"name":"Player"');
      expect(call).toContain('"active":true');
    });

    it("should handle empty values", () => {
      const call = buildUpdateDataCall("panel1", {});
      expect(call).toContain("{}");
    });
  });

  describe("buildSetContentCall", () => {
    it("should build a valid JS call string", () => {
      const call = buildSetContentCall("<div>Content</div>");
      expect(call).toContain("__osrSetContent");
      expect(call).toContain("<div>Content</div>");
    });
  });
});
