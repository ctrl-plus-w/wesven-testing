# Changelog

All notable changes to `@wesven/testing` are documented here. Format: hand-written, breaking changes shown as before/after diffs against ten-line shim files.

## [Unreleased]

### Breaking

- `e2e-runner` takes a pinned app port from `E2E_APP_PORT` and no longer reads `PORT`. It sets `PORT` only for `pnpm run start`: the runner's own `process.env`, the build, the migrations and Cypress no longer get the app port as `PORT` (`NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL` still carry it). Before, a `PORT` in the shell, such as the one a wesven task sets for its dev server, put the app on that port, and Cypress could end up testing the dev server.

```diff
- PORT=3001 pnpm test:e2e
+ E2E_APP_PORT=3001 pnpm test:e2e
```

### Fixed

- `e2e-runner` fails before building or starting anything when something already answers on the app port, instead of running Cypress against it. When `:up` reuses a saved testbed, it keeps that testbed and its state, so `:down` can still remove it.
- `e2e-runner` fails when `pnpm run start` exits before the app port opens, with the exit code and the last 20 lines of its stderr, instead of waiting out the 60 s timeout or passing on another server.

## [0.1.0] - Unreleased

Initial release. Extracted from `wesven-mvp-template`'s `src/scripts/` runners, root Vitest/Cypress configs, and `tests/setup/*` files.

- Six split entry points: `integration-runner`, `e2e-runner`, `vitest-config`, `vitest-setup`, `cypress-config`, `compose-file`
- Fixed runner lifecycle with four hook points: `preSetup`, `postSetup`, `preTeardown`, `extraEnv`
- Default `compose.test.yaml` ships as a static asset (Postgres 17, fsync-off perf flags)
- Compiled with `tsup` (`src/` → `dist/`); ships ESM `.js` + `.d.ts`. `src/` uses `@/*` path aliases (`tsconfig` `paths`); `tsup` rewrites them to relative paths in the emitted output.
- Pre-1.0: minor bumps may break. Patches are bug fixes only.
