import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-overburden",
  window: {
    title: "Overburden",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1a1a2e",
    placement: "remember",
    stateFile: "overburden-window-state.json",
  },
});
