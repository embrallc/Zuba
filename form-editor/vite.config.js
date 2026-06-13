import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file output: everything (JS + CSS) inlined into dist/index.html so
// the Supabase Edge Function can serve the whole editor as one document.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // Escape every non-ASCII char in the JS output (⠿ style). The bundle
  // is served by third-party hosts that may omit the charset header — a pure
  // ASCII bundle renders identically under any charset fallback, so the UI
  // glyphs (drag dots, arrows, emoji) can never mojibake again.
  esbuild: {
    charset: "ascii",
  },
  build: {
    target: "es2018",
    cssCodeSplit: false,
  },
  // bindings config lives at the repo root (shared/formBindings.js) so the
  // app and report generator import the same file — let the dev server reach
  // above the editor's root.
  server: {
    fs: { allow: [".."] },
  },
});
