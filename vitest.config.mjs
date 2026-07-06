import { defineConfig } from "vitest/config";

// Dev-only test runner. Never bundled into the Expo app. Vitest transforms the
// ESM/JSX sources with esbuild, so it runs shared/ + form-editor logic that
// plain `node --test` can't (root package.json has no "type": "module").
//
// Scope = pure logic (Tier 1): shared contracts, the form/report builder logic,
// store reducers, and dependency-light utils. React Native components and
// native modules (Skia, expo-*, sqlite) are out of scope here — they need a
// jest-expo / testing-library harness and stay on device/manual testing.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    reporters: "default",
  },
});
