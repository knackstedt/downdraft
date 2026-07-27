// DevTools extension entry point — creates the "3D Scene" panel
chrome.devtools.panels.create(
  "3D Scene",
  null,
  "panel.html",
  function (panel) {
    console.log("[3D Scene] Panel created");
  },
);
