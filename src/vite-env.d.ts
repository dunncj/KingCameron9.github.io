// Ambient module declarations for Vite's own import-suffix conventions —
// TypeScript has no built-in idea what "?raw" means, so without this the
// only ?raw import in the app (settings/store.ts pulling in settings.toml
// as plain text) fails to type-check even though it works fine at runtime
// (Vite handles the suffix, not TypeScript).
declare module '*?raw' {
  const content: string;
  export default content;
}
