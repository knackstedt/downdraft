import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-mining-rpg",
  window: {
    title: "Mining RPG",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#000000",
    placement: "remember",
    stateFile: "mining-rpg-window-state.json",
  },
});
