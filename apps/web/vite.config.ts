import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);

export default defineConfig({
  // Relative base so the built app works from a GitHub Pages subpath.
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Never intercept Google endpoints (OAuth / Drive must hit the network).
        navigateFallbackDenylist: [/^https:\/\/(accounts|www)\.google/],
      },
      manifest: {
        name: "Password Vault",
        short_name: "Vault",
        description: "Zero-knowledge personal password manager for Indian users",
        start_url: "./",
        display: "standalone",
        background_color: "#f6f7f9",
        theme_color: "#1f6f5c",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      // libsodium-wrappers-sumo's ESM build imports a sibling libsodium-sumo.mjs that the
      // package doesn't ship (upstream packaging bug); the CJS build is self-contained.
      // See NOTES/libsodium-esm-bug.md.
      "libsodium-wrappers-sumo": require
        .resolve("libsodium-wrappers-sumo")
        .replace(/dist[\/\\].*$/, "dist/modules-sumo/libsodium-wrappers.js"),
    },
  },
  optimizeDeps: {
    include: ["libsodium-wrappers-sumo"],
  },
});
