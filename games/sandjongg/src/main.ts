import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-sandjongg",
  window: {
    title: "Sandjongg",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "remember",
    stateFile: "window-state.json",
  },
});
