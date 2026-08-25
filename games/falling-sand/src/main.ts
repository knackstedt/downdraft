import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-falling-sand",
  window: {
    title: "Falling Sand",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#000000",
    placement: "remember",
    stateFile: "window-state.json",
  },
});
