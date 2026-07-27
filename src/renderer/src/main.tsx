// ============================================================================
// Renderer Entry Point — Generic engine bootstrap
// ============================================================================
// Games override this with their own entry point that registers plugins
// and configures the engine. This is a minimal fallback.

import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";

function App() {
  return React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#0a0a0a",
      color: "#666",
      fontFamily: "sans-serif",
    },
  }, "No game configured. Create a game project that provides a renderer entry.");
}

const root = createRoot(document.getElementById("root")!);
root.render(React.createElement(App));
