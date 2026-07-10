import { defineConfig } from "vitest/config";
import { libsodiumAlias } from "./vite.config";

export default defineConfig({
  resolve: { alias: libsodiumAlias },
  test: { globals: true, environment: "jsdom" },
});
