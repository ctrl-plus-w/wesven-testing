# Changelog

All notable changes to `@wesven/testing` are documented here. Format: hand-written, breaking changes shown as before/after diffs against ten-line shim files.

## [0.1.0] - Unreleased

Initial release. Extracted from `wesven-mvp-template`'s `src/scripts/` runners, root Vitest/Cypress configs, and `tests/setup/*` files.

- Six split entry points: `integration-runner`, `e2e-runner`, `vitest-config`, `vitest-setup`, `cypress-config`, `compose-file`
- Fixed runner lifecycle with four hook points: `preSetup`, `postSetup`, `preTeardown`, `extraEnv`
- Default `compose.test.yaml` ships as a static asset (Postgres 17, fsync-off perf flags)
- Compiled with `tsup` (`src/` → `dist/`); ships ESM `.js` + `.d.ts`. `src/` uses `@/*` path aliases (`tsconfig` `paths`); `tsup` rewrites them to relative paths in the emitted output.
- Pre-1.0: minor bumps may break. Patches are bug fixes only.
