// ============================================================================
// Type declarations for optional Capacitor plugins
// ============================================================================
//
// Capacitor plugins (@capacitor/app, @capacitor/browser) are per-game
// dependencies, not engine dependencies. These ambient declarations allow
// the mobile bridge to dynamically import them without a hard dependency.
// Games that install the real packages get the real types; games that don't
// get these stubs (the dynamic import fails gracefully at runtime).

declare module "@capacitor/app" {
  export interface AppPlugin {
    exitApp(): Promise<void>;
    getState(): Promise<{ isActive: boolean }>;
    getLaunchUrl(): Promise<{ url: string }>;
  }
  export const App: AppPlugin;
}

declare module "@capacitor/browser" {
  export interface BrowserPlugin {
    open(options: { url: string; windowName?: string }): Promise<void>;
    close(): Promise<void>;
    prefetch(options: { urls: string[] }): Promise<void>;
  }
  export const Browser: BrowserPlugin;
}
