import { createRequire } from "node:module";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

// Shared alias for every build pass (popup / background / content / offscreen) — see
// NOTES/libsodium-esm-bug.md. libsodium-wrappers-sumo's ESM build imports a sibling file the
// package doesn't ship; the self-contained CJS build works everywhere.
export const libsodiumAlias = {
  "libsodium-wrappers-sumo": require
    .resolve("libsodium-wrappers-sumo")
    .replace(/dist[\/\\].*$/, "dist/modules-sumo/libsodium-wrappers.js"),
};

// This file is only used for `vite build --mode <chrome|firefox>` invoked directly (e.g. by an
// editor's Vite integration or `vite build` without arguments); the actual multi-entry,
// multi-format build (popup as ES module, background/content/offscreen as IIFE, manifest
// selection per target) is orchestrated by scripts/build.mjs — see README.md "Building".
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: libsodiumAlias },
  optimizeDeps: { include: ["libsodium-wrappers-sumo"] },
  build: {
    rollupOptions: { input: { popup: "popup.html", offscreen: "offscreen.html" } },
  },
});
