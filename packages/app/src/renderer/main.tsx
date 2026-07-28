import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./bridge.ts";

const container = document.getElementById("ui-overlay");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
