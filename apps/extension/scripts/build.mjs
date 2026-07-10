#!/usr/bin/env node
// Builds a loadable MV3 extension directory for one or both targets (chrome | firefox | all).
//
// Vite's normal multi-entry build assumes one output format for every entry, but a browser
// extension needs the popup as an ES module (loaded via <script type="module"> in popup.html /
// offscreen.html) AND the background service worker + content script as plain classic scripts
// (so they work as a non-module chrome.scripting.executeScript target and, on Firefox, a
// classic background script). So this does three separate `build()` calls per target instead
// of fighting a single rollupOptions.input/output.format combination:
//   1. popup.html + offscreen.html  -> ES modules   (dist/<target>/{popup,offscreen}.html + assets)
//   2. src/background/index.ts      -> IIFE          (dist/<target>/background.js)
//   3. src/content/index.ts         -> IIFE          (dist/<target>/content.js)
// then copies the target's manifest.json + icons on top.
import { existsSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { libsodiumAlias } from "../vite.config.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = process.argv[2] === "all" || !process.argv[2] ? ["chrome", "firefox"] : [process.argv[2]];

for (const target of targets) {
  if (target !== "chrome" && target !== "firefox") {
    console.error(`Unknown target "${target}" — expected "chrome", "firefox", or "all".`);
    process.exit(1);
  }
  await buildTarget(target);
}

async function buildTarget(target) {
  const outDir = join(root, "dist", target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`\n[${target}] building popup + offscreen (ES modules)…`);
  await build({
    root,
    configFile: false,
    resolve: { alias: libsodiumAlias },
    optimizeDeps: { include: ["libsodium-wrappers-sumo"] },
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: { input: { popup: join(root, "popup.html"), offscreen: join(root, "offscreen.html") } },
    },
  });

  console.log(`[${target}] building background.js (IIFE)…`);
  await build({
    root,
    configFile: false,
    resolve: { alias: libsodiumAlias },
    optimizeDeps: { include: ["libsodium-wrappers-sumo"] },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: join(root, "src/background/index.ts"),
        formats: ["iife"],
        name: "PwmBackground",
        fileName: () => "background.js",
      },
      rollupOptions: { output: { extend: true } },
    },
  });

  console.log(`[${target}] building content.js (IIFE)…`);
  await build({
    root,
    configFile: false,
    resolve: { alias: libsodiumAlias },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: join(root, "src/content/index.ts"),
        formats: ["iife"],
        name: "PwmContent",
        fileName: () => "content.js",
      },
    },
  });

  const manifestSrc = join(root, `manifest.${target}.json`);
  writeFileSync(join(outDir, "manifest.json"), readFileSync(manifestSrc));
  cpSync(join(root, "public/icons"), join(outDir, "icons"), { recursive: true });

  console.log(`[${target}] done -> ${outDir}`);
  const required = ["manifest.json", "popup.html", "background.js", "content.js", "offscreen.html"];
  const missing = required.filter((f) => !existsSync(join(outDir, f)));
  if (missing.length) {
    console.error(`[${target}] MISSING expected output files: ${missing.join(", ")}`);
    process.exit(1);
  }
}
