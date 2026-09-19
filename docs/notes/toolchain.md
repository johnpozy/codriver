# Toolchain Notes — codriver

Recorded: 2026-09-19 (todo 1: scaffold)

## tsgo vs tsc decision

**Decision: `typecheck` target uses `tsgo --noEmit`** (from `@typescript/native-preview@7.0.0-dev.20260707.2`).

- `@typescript/native-preview` installed cleanly on linux-x64 (native binary via
  `@typescript/native-preview-linux-x64`); `tsgo --version` → `7.0.0-dev.20260707.2`.
- `tsgo --noEmit` verified green on both packages before wiring.
- Fallback (`tsc --noEmit`) was NOT needed. If the native-preview package ever
  fails to install on a platform, switch the `typecheck` command in each
  `project.json` (and the matching `package.json` script) to `tsc --noEmit`.

Note: `typescript@7.0.2` (used for `build` via `tsc -p tsconfig.build.json`) is
itself the Go-native compiler (Project Corsa GA, 2026-07). So both `tsc` and
`tsgo` are native; `tsgo` is the dev-preview channel, `tsc` the stable channel.

## TS 7 breaking default: `types` now defaults to `[]`

TypeScript 7.0 no longer auto-includes `node_modules/@types/*` packages
(verified empirically: TS 5.9 auto-includes, TS 7.0.2 does not; confirmed in the
official 7.0 announcement). Consequence for this repo:

- `tsconfig.base.json` sets `"types": ["bun", "node"]` explicitly.
  - `bun` → `@types/bun` → `bun-types` (declares the `bun:test` module used by
    `bun test` files).
  - `node` → `@types/node`.
- Without this, typecheck fails with `TS2307: Cannot find module 'bun:test'`.
- Other TS7 defaults we already satisfy explicitly: `strict: true`,
  `module: "NodeNext"`, and `rootDir` is pinned in each `tsconfig.build.json`
  (TS7 defaults `rootDir` to `./`).

## nx target wiring

Hand-rolled workspace (no `create-nx-workspace` generator):

- Root `package.json`: `"workspaces": ["packages/*"]`, npm workspaces.
  `codriver-opencode` links `codriver` via `"devDependencies": { "codriver": "*" }`
  (npm resolves it to the local workspace package; todo 13 moves it to
  peerDependencies).
- Each package's `project.json` uses the `nx:run-commands` executor with an
  explicit `cwd` set to the package root (relative to workspace root), because
  nx does not natively cache bun/tsc/oxlint commands:
  - `build` = `tsc -p tsconfig.build.json` (outDir `dist`, `declaration: true`)
  - `typecheck` = `tsgo --noEmit`
  - `lint` = `oxlint src`
  - `test` = `bun test`
- `nx.json` `targetDefaults`: `cache: true` for build/typecheck/lint/test;
  `build` has `dependsOn: ["^build"]` so `core` builds before `opencode`
  (dependency inferred by nx from the package.json devDependency).
- `nx.json` `namedInputs`: `src` = `{projectRoot}/src/**/*.ts`,
  `tests` = `{projectRoot}/test/**/*.ts`, `tsconfig` = `{projectRoot}/tsconfig*.json`;
  targets reference these so cache keys track the right files.
- Binaries resolve from the root `node_modules/.bin` (inherited PATH when
  invoked via `npx nx`); `bun` is global.

## Versions pinned at scaffold time

| Package | Version |
|---|---|
| nx | 23.2.1 |
| typescript | 7.0.2 (native) |
| @typescript/native-preview | 7.0.0-dev.20260707.2 |
| oxlint | 1.83.0 |
| @types/node | ^24 (node v24.20.0) |
| @types/bun | ^1.4.2 |
| bun (global) | 1.4.0 |

## Final toolchain state (todo 13: packaging, 2026-09-20)

### tsgo vs tsc — the as-built split

- `typecheck` = `tsgo --noEmit` — the fast Go-native checker (dev-preview
  channel, `@typescript/native-preview`): check-only, no artifact, the
  per-change feedback loop.
- `build` = `tsc -p tsconfig.build.json` — the emitter (stable channel,
  `typescript@7.0.2`): produces `dist/` with `declaration: true`.
- Why the split: checking and emitting are different jobs. `tsgo` exists to
  answer "any type errors?" as fast as possible; `tsc` is the channel that
  actually emits the published `.js` + `.d.ts` artifacts. Both channels are
  Go-native in TS 7 (Project Corsa — see the note above), so the split is
  about channel stability, not speed of the emitter: the published artifact
  comes from the stable channel, the fast loop from dev-preview. `tsc
  --noEmit` remains the documented fallback if native-preview ever fails to
  install on a platform.

### nx target wiring — as-built

- Per-package `project.json` (`nx:run-commands`, `cwd` pinned to the package
  root): `build` / `typecheck` / `lint` / `test` targets per package, matching
  each `package.json` script one-to-one (`tsc -p tsconfig.build.json`,
  `tsgo --noEmit`, `oxlint src`, `bun test`).
- `nx.json` `targetDefaults`: `cache: true` on build/typecheck/lint/test,
  keyed by the `namedInputs` (`src`, `tests`, `tsconfig`).
- `targetDefaults.build.dependsOn: ["^build"]` — `codriver` (core) builds
  before `codriver-opencode`; nx infers the project-graph edge from the
  opencode package's dependency on `codriver`. As of todo 13 that dependency
  is declared twice, deliberately: `peerDependencies` (the real, published
  requirement) and `devDependencies` (so the local workspace build resolves
  `codriver` through the npm-workspaces symlink).

### Dist entry extension — FINAL: `.js` (ESM)

- Decision: the published entry is `dist/index.js` with `"type": "module"`
  in the package.json; `exports` maps `.` to
  `{ "types": "./dist/index.d.ts", "import": "./dist/index.js" }`.
- Evidence: spike A module-format experiment
  (docs/notes/spike-a.md, "Module-format experiment (decides dist entry for
  todos 1/13)") — the built-style `.js` + adjacent `{"type": "module"}`
  variant enumerated `codriver/auto` with exit 0: the opencode (Bun-compiled)
  loader honors nearest-package.json `type` resolution for `.js` entries.
- Why `.js` over `.mjs`: it is the standard tsc NodeNext output shape (no
  emit extension rewriting needed) and unambiguous under both Bun and Node.
  `.mjs` remains the documented fallback if the adjacent package.json ever
  stops being controlled by us.
