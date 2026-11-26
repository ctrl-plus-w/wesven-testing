# Changelog

All notable changes to `@wesven/testing` are documented here. Format: hand-written, breaking changes shown as before/after diffs against ten-line shim files.

## [0.2.0] - 2026-11-26

### Breaking

- Releases ship prebuilt. Each `vX.Y.Z` tag gets a GitHub Release with `wesven-testing-X.Y.Z.tgz` as its asset, and consumers depend on that tarball instead of the git URL. pnpm builds a git dependency on every install by running a nested `pnpm install` inside it. With the pnpm store inside the consumer project (as on Vercel), that nested install read the consumer's settings-only `pnpm-workspace.yaml` and failed with `ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION`. A tarball dependency is never built. Also drop the `@wesven/testing` entry from `allowBuilds` in `pnpm-workspace.yaml`: the tarball runs no install script.

```diff
- "@wesven/testing": "github:ctrl-plus-w/wesven-testing#v0.1.9"
+ "@wesven/testing": "https://github.com/ctrl-plus-w/wesven-testing/releases/download/v0.2.0/wesven-testing-0.2.0.tgz"
```

- `e2e-runner` takes a pinned app port from `E2E_APP_PORT` and no longer reads `PORT`. It sets `PORT` only for `pnpm run start`: the runner's own `process.env`, the build, the migrations and Cypress no longer get the app port as `PORT` (`NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL` still carry it). Before, a `PORT` in the shell, such as the one a wesven task sets for its dev server, put the app on that port, and Cypress could end up testing the dev server. When `PORT` is set without `E2E_APP_PORT`, the runner prints a warning, except for the `PORT` of a wesven task (equal to `WESVEN_PORT_BASE`).

```diff
- PORT=3001 pnpm test:e2e
+ E2E_APP_PORT=3001 pnpm test:e2e
```

### Fixed

- `e2e-runner` fails before building or starting anything when something already answers on the app port, instead of running Cypress against it. When `:up` reuses a saved testbed, it keeps that testbed and its state, so `:down` can still remove it.
- `e2e-runner` fails when `pnpm run start` exits before the app port opens, with the exit code and the last 20 lines of its stderr, instead of waiting out the 60 s timeout or passing on another server.
- `e2e-runner` no longer leaves the app's process tree running. It starts the app in its own process group, saves its pid in the runner state, and stops the whole group on teardown, on `:down` and on the next `:up`, escalating to `SIGKILL` after a grace period. `0.1.10` was never released, so this is the first release with it.

### Changed

- The repository uses pnpm 10.34.9 (`packageManager`), the same as the consumers. The lockfile moves to format 9.0 with the same resolved versions.

## [0.1.0] - Unreleased

Initial release. Extracted from `wesven-mvp-template`'s `src/scripts/` runners, root Vitest/Cypress configs, and `tests/setup/*` files.

- Six split entry points: `integration-runner`, `e2e-runner`, `vitest-config`, `vitest-setup`, `cypress-config`, `compose-file`
- Fixed runner lifecycle with four hook points: `preSetup`, `postSetup`, `preTeardown`, `extraEnv`
- Default `compose.test.yaml` ships as a static asset (Postgres 17, fsync-off perf flags)
- Compiled with `tsup` (`src/` → `dist/`); ships ESM `.js` + `.d.ts`. `src/` uses `@/*` path aliases (`tsconfig` `paths`); `tsup` rewrites them to relative paths in the emitted output.
- Pre-1.0: minor bumps may break. Patches are bug fixes only.
