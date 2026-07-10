# libsodium-wrappers-sumo ESM build is broken — always alias to the CJS build

`libsodium-wrappers-sumo@0.7.16` declares an ESM entry (`dist/modules-sumo-esm/libsodium-wrappers.mjs`)
that does `import "./libsodium-sumo.mjs"` — a sibling file the package does **not** ship (it lives in
the separate `libsodium-sumo` package). Any ESM-aware resolver (Node ESM, Vitest, Vite SSR) fails with
`ERR_MODULE_NOT_FOUND`.

**Fix that works everywhere:** alias the package to its self-contained CJS build in every bundler config:

```ts
resolve: {
  alias: {
    "libsodium-wrappers-sumo": "libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js",
  },
}
```

Applied in `packages/core/vitest.config.ts` and `apps/web/vite.config.ts`. If a future upgrade fixes
upstream packaging, the alias becomes harmless.
