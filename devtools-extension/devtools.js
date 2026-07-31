// DevTools extension entry point — creates panels
chrome.devtools.panels.create(
  "3D Scene",
  null,
  "panel.html",
  function (panel) {
    console.log("[3D Scene] Panel created");
  },
);

chrome.devtools.panels.create(
  "GPU",
  null,
  "gpu-panel.html",
  function (panel) {
    console.log("[GPU] Panel created");
  },
);
