import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-alchemy",
  window: {
    title: "Alchemist's Lab",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "remember",
    stateFile: "window-state.json",
  },
});
