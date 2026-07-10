import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      // libsodium-wrappers-sumo's ESM build imports a sibling libsodium-sumo.mjs that the
      // package doesn't ship (upstream packaging bug); the CJS build is self-contained.
      // Absolute path because the package's exports map blocks deep imports.
      // The web app's vite.config.ts needs this same alias. See NOTES/libsodium-esm-bug.md.
      "libsodium-wrappers-sumo": require
        .resolve("libsodium-wrappers-sumo") // resolves to the CJS main via require condition
        .replace(/dist[\/\\].*$/, "dist/modules-sumo/libsodium-wrappers.js"),
    },
  },
  test: { globals: true },
});
