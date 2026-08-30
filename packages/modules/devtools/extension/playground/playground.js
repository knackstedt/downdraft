// ============================================================================
// Playground — Playground/Sandbox panel for DevTools
// Phase 5 — Stub implementation (will be expanded)
// ============================================================================

(function (global) {
  "use strict";

  function Playground(container, helpers) {
    this.container = container;
    this.evalInPage = helpers.evalInPage;
    this.callInspector = helpers.callInspector;
    this.active = false;
    this._buildDOM();
  }

  Playground.prototype._buildDOM = function () {
    this.root = document.createElement("div");
    this.root.style.display = "flex";
    this.root.style.flexDirection = "column";
    this.root.style.width = "100%";
    this.root.style.height = "100%";

    var placeholder = document.createElement("div");
    placeholder.style.flex = "1";
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.style.color = "#666688";
    placeholder.style.fontStyle = "italic";
    placeholder.textContent = "Playground — Phase 5 (coming soon)";

    this.root.appendChild(placeholder);
    this.container.appendChild(this.root);
  };

  Playground.prototype.setActive = function (active) {
    this.active = active;
  };

  Playground.prototype.destroy = function () {
    this.root.remove();
  };

  global.Playground = Playground;
})(typeof window !== "undefined" ? window : this);
