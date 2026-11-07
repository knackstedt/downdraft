// Ambient module declarations for engine asset imports (published package
// ships TS source that references bundler-style ?raw/?url specifiers).
declare module "*.wgsl?raw" { const src: string; export default src; }
declare module "*.wasm?url" { const src: string; export default src; }
declare module "*.png?url" { const src: string; export default src; }
declare module "*.svg?raw" { const src: string; export default src; }
