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
  test: {
    globals: true,
    // *.manual.test.ts needs a live `docker compose up` stack (real Postgres over real
    // HTTP), so it is skipped unless LIVE_SERVER points at one:
    //   LIVE_SERVER=http://127.0.0.1:8787 npx vitest run test/live-pg.manual.test.ts
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.LIVE_SERVER ? [] : ["**/*.manual.test.ts"]),
    ],
  },
});
