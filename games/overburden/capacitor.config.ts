import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.downdraft.overburden",
  appName: "Overburden",
  webDir: "dist/mobile",
  server: {
    // The embedded HTTP server (started by the shell's MainActivity/AppDelegate)
    // serves assets with COOP/COEP headers for SharedArrayBuffer cross-origin
    // isolation. Capacitor loads from this URL directly.
    androidScheme: "http",
    iosScheme: "http",
    url: "http://127.0.0.1:8765/index.html",
  },
};

export default config;
