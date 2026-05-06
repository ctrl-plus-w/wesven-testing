# PLAN — Extract testing infrastructure into `@wesven/testing`

## Problem Statement

The wesven-mvp-template ships ~700 lines of bespoke testing infrastructure (two large runner scripts, three Vitest/Cypress configs, two setup files, a compose file, and a small set of shared utilities) that gets copied into every project spawned from the template. As the number of spawned projects grows, this duplication causes four concrete pains, all of which are currently being felt:

1. **Sync drift** — fixes to one project's runner have to be manually ported to N others, and divergence accumulates silently.
2. **Onboarding cost** — every new project carries ~1000 lines of testing scaffolding that is not the project's own concern.
3. **Improvement amplification** — improvements made once should propagate to every project without N PRs.
4. **Cleanliness** — testing infrastructure lives inside `src/scripts/` of every project but is not really project code; it is reusable infrastructure that has been pasted in.

## Solution

Extract the testing infrastructure into a single dedicated package, `@wesven/testing`, distributed as a git URL dependency pinned by tag. Each consuming project keeps a small set of thin shim files (each under ten lines), which import factories from the package and pass project-specific bindings (the database reset function, the MSW server instance, optional lifecycle hooks). Configs are extended via Vitest's standard `mergeConfig` and a Cypress factory; the runner exposes a fixed lifecycle with a small set of explicit hook points; the compose file is owned by the package with native docker-compose `-f` extension as the override mechanism.

The wesven-mvp-template adopts the package on day one, becoming the first consumer and the integration-test fixture. Existing spawned projects migrate lazily via the existing project-migration CLI when each project hits its own pain.

## User Stories

1. As a template maintainer, I want testing infrastructure to live in a single shared package, so that I do not copy-paste fixes across multiple project repositories.
2. As a template maintainer, I want the package distributed as a git URL dependency pinned by tag, so that I do not need to set up an npm publish pipeline or registry authentication.
3. As a template maintainer, I want consumers to opt into each new version explicitly via a tag bump, so that no project is auto-upgraded silently.
4. As a template maintainer, I want consumer-side integration files to be under ten lines each, so that the project-side surface is trivially auditable.
5. As a template maintainer, I want the package to ship raw TypeScript source executed via the consumer's `tsx`, so that I avoid maintaining a build step or `dist/` folder.
6. As a template maintainer, I want to issue a new version by pushing a git tag, so that the release ceremony is one command.
7. As a template maintainer, I want the package to expose split entry points (one per concern), so that consumers only load the dependencies they actually use and the package's structure is self-documenting.
8. As a template maintainer, I want vitest, cypress, msw, vitest plugins, testing-library, and react to be peer dependencies, so that the package and the consumer share a single module instance for these libraries (avoiding the silent two-instance failure mode where MSW handlers attach to a server the package never touches).
9. As a template maintainer, I want the wesven-mvp-template to adopt the package on day one, so that I dogfood the API immediately and avoid maintaining two parallel implementations.
10. As a template maintainer, I want a hand-written CHANGELOG with explicit before/after diffs for breaking changes, so that consumers can migrate without reading source diffs.
11. As a template maintainer, I want TSDoc on every public symbol, so that consumers see documentation in their IDE at the call site rather than chasing external docs.
12. As a template maintainer, I want the package's lifecycle order to be fixed and the override surface to be explicit, so that I do not paint myself into supporting arbitrary lifecycle composition.
13. As a new-project author, I want a fresh project spawned from the template to depend on `@wesven/testing` out of the box, so that I never write a runner or test config from scratch.
14. As a new-project author, I want to provide my project's `resetTables`, MSW server, and optional lifecycle hooks via shim files, so that the package can run my project's tests without being coupled to my file paths.
15. As a new-project author, I want `pnpm test:integration` and `pnpm test:e2e` to work without docker port conflicts even when I run multiple projects concurrently, so that I do not coordinate ports manually.
16. As a new-project author, I want the testbed to be reused across consecutive `:up` / `:run` invocations, so that I do not pay docker startup cost between iterations during TDD.
17. As a new-project author, I want stale testbed state from a crashed previous run to be detected and recovered automatically, so that I am not blocked by an orphaned state file.
18. As a new-project author, I want a Listr-style progress UI during test runs, so that I can see what step is running and which step failed.
19. As a new-project author, I want a `:status` subcommand that tells me whether a testbed is currently up, so that I can check before tearing it down.
20. As a new-project author, I want all docker resources to be cleaned up reliably on `:down` and on SIGINT/SIGTERM, so that I do not leave orphaned containers behind.
21. As a new-project author, I want to add project-specific MSW handlers, vitest setup hooks, or cypress commands without forking the package, so that the package handles the common case while I extend the uncommon case in place.
22. As a new-project author, I want to override `compose.test.yaml` (replace) or extend it (additive `-f` overlay), so that I can add a Redis service or change the postgres version without forking.
23. As a new-project author, I want to use Vitest's `mergeConfig` to override the base config, so that I can change the test include glob, plugins, or pool configuration when my project diverges from the default.
24. As a new-project author, I want my project's path aliases (`@/...`) to resolve naturally inside the runner and setup files, so that I do not configure tsconfig-paths plugins for the test runner.
25. As a new-project author, I want `pnpm install` to require no auth or registry configuration, so that fresh checkouts and CI agents work with no extra setup.
26. As a new-project author, I want pre-setup / post-setup / pre-teardown hooks and an extra-env passthrough, so that one-off project lifecycle needs do not require forking the runner.
27. As a new-project author, I want the package to ship a sensible default `compose.test.yaml`, so that a brand-new project does not need to write one.
28. As an existing-project maintainer, I want my project to keep working unchanged after the package exists, so that the template's adoption does not force urgent migration work on me.
29. As an existing-project maintainer, I want a thirty-minute migration path from embedded runners to the package, so that adopting it is a low-cost decision.
30. As an existing-project maintainer, I want the project-migration CLI to convert embedded runners to package shims, so that adoption is mechanical.
31. As an existing-project maintainer with a patched runner, I want explicit hook points (preSetup, postSetup, preTeardown, extraEnv) so that I can move my customization into the package's API instead of forking.
32. As an existing-project maintainer, I want to "eject" from the package by copying its source back into my project, so that nothing prevents me from going back to embedded runners if my needs diverge dramatically.
33. As future-me debugging a regression, I want the package's CI to run the wesven-mvp-template's full integration and e2e test suite against the local package, so that orchestration regressions are caught before tagging.
34. As future-me debugging a regression, I want a nightly CI run against the template's `main` branch (not the pinned fixture ref), so that drift between the package and the live template is surfaced as a tripwire rather than discovered by a consumer.
35. As future-me debugging a regression, I want unit tests for the pure logic (state file lifecycle, port allocation, project-name building, output formatting), so that subtle silent bugs in those areas are caught without docker.
36. As future-me, I want every breaking change recorded in the CHANGELOG with a before/after diff, so that I can migrate consumer projects without reading the source diff.
37. As future-me, I want pre-1.0 minor bumps to be allowed to break, so that I can shape the API in early use without burning major versions.
38. As future-me, I want to ship 1.0 only after a second consumer (besides the template) has migrated and two consecutive minor bumps have passed without breaks, so that I do not lock in a bad design.
39. As future-me, I want peer-dep ranges to stay wide (caret on the major), so that consumers can be on different patch versions without warnings.
40. As future-me, I want to bump the template-fixture pin in the package's CI in the same PR that lands a runner change requiring it, so that the fixture stays in sync with deliberate, traceable updates.

## Implementation Decisions

### New package: `@wesven/testing`

**Distribution and shipping shape**
- Lives in a separate repository, owned by the same author as the template.
- Distributed as a git URL dependency, pinned by tag (`github:<owner>/wesven-testing#vX.Y.Z`). No npm registry, no publish workflow, no install-time auth.
- Source-mode: raw `.ts` files are shipped; the consumer's `tsx` resolves and executes them. No `dist/`, no build step, no source maps to debug.
- ESM only (`"type": "module"`).
- TypeScript configuration mirrors the template: `moduleResolution: bundler`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `skipLibCheck: true`, `noEmit: true`. Inside the package, imports between modules are relative (no `@/...` aliases within the package).

**Six split entry points (no barrel)**
- Integration runner — exports the runner factory; consumers pass project bindings.
- E2E runner — exports the runner factory; consumers pass project bindings plus the MSW server.
- Vitest configs — exports a base integration config and a base unit config, both extendable via Vitest's standard `mergeConfig`.
- Vitest setup — exports an integration setup factory (which takes the MSW server and the database lifecycle as required arguments) and a unit setup factory (no required arguments).
- Cypress base — exports a Cypress config factory that requires `resetTables` and accepts overrides for tasks, baseUrl, spec patterns, and support file path.
- A static `compose.test.yaml` asset, available by package-relative path. The runners default to this file; consumers can override its location or add a docker-compose `-f` overlay for additive services.

**Peer vs direct dependencies**
- Peer (must match consumer's instance): `vitest`, `cypress`, `msw`, `@vitejs/plugin-react`, `vite-tsconfig-paths`, `@testing-library/jest-dom`, `@testing-library/react`, `jsdom`, `react`, `react-dom`. `@vitest/coverage-v8` and `@vitest/ui` are optional peers.
- Direct (package-internal, never imported by consumer): `commander`, `@commander-js/extra-typings`, `execa`, `listr2`, `wait-on`, `picocolors`.
- Peer-dep ranges are kept wide on the major (e.g., `^3.0.0`), tightened only when a feature genuinely requires it.

**Module breakdown (deep modules with stable interfaces)**

*Internal core (not exported)*
- **Runner state** — owns reading, writing, and clearing a small persistent state file per runner kind, including PID-liveness checks for stale-recovery. Single source of truth for "is a testbed up, and which one." Stable surface: `read()`, `write(state)`, `clear()`, `isPidAlive(pid)`.
- **Available port allocation** — returns an OS-allocated free port. Single function. Stable.
- **Project-name builder** — produces a unique-per-run docker `COMPOSE_PROJECT_NAME`. Single function. Stable.
- **Runner output formatter** — formats the "ready" and "status" output blocks. Pure formatting; takes a state-shaped input and returns a string.
- **Docker / migration / reset task primitives** — small Listr task factories for the lifecycle steps. Used by both runners.

*Public surface*
- **Integration runner** — Builds a Commander program with subcommands `default`, `up`, `run`, `down`, `status`, wiring the docker → migrate → reset → vitest lifecycle. Accepts: `resetTables` (required), `composeFile` (optional override), `extendCompose` (optional `-f` overlay path), `preSetup` / `postSetup` / `preTeardown` (optional hooks), `extraEnv` (optional pass-through).
- **E2E runner** — Same shape, plus `mswServer` (required), and additional internal lifecycle for the Next build/start dance and MSW server start/stop.
- **Vitest base configs** — Two `defineConfig`-shaped exports, one for integration (jsdom, single-fork pool, integration setup file path, longer timeouts) and one for unit (node, unit setup file). Both include `tsconfigPaths()` and `react()` plugins.
- **Vitest setup factory** — A function the consumer invokes from a setup file. Takes the MSW server and the database setup/teardown/reset triple as required arguments and accepts optional overrides for which default behaviors run (next/navigation mocks, next/headers mocks, console silencing, MSW lifecycle, database lifecycle).
- **Cypress base config** — A `defineConfig`-shaped factory taking `resetTables` (required) and optional override fields.

**Lifecycle and override contract**

- The runner lifecycle order is fixed: docker up → migrate → (optional) reset → tests → cleanup. Reordering is not supported; if needed, the project forks.
- Hook points are explicit: `preSetup` (before docker up), `postSetup` (after migrate, before tests), `preTeardown` (after tests, before docker down), and `extraEnv` (additional env for spawned processes).
- The Listr UI, state file location, port allocation strategy, and project-name format are not configurable. Consumers who need different behavior fork.
- Configuration overrides for Vitest go through `mergeConfig`; for Cypress through the base factory's options; for the compose file through `composeFile` replacement or `extendCompose` additive overlay.

### Modifications to `wesven-mvp-template` (becomes consumer #1)

- The entire `src/scripts/` folder is removed.
- The root `compose.test.yaml` is removed (the default shipped by the package replaces it).
- The two Vitest configs and the Cypress config become tiny shims that re-export `mergeConfig`-extended or factory-built config objects from the package.
- The two Vitest setup files become tiny shims that call the corresponding setup factory with the project's bindings.
- Two thin runner shim files are added (one for integration, one for e2e), each invoking the package's runner factory with the project's bindings; the existing `package.json` test scripts continue to invoke them via `tsx`.
- `@wesven/testing` is added as a git URL dependency in `package.json`.
- The shim files together total roughly seven files, each under ten lines.

### Versioning, documentation, and CI

- Pre-1.0: minor bumps may include breaking changes; patches are bug fixes only.
- 1.0 ships only after a second consumer (besides the template) has migrated AND two consecutive minor bumps have passed with no breaking changes.
- Post-1.0: strict semver. Major for breaking changes; minor for additive; patch for fixes.
- A hand-maintained `CHANGELOG.md` records every release, with breaking changes shown as a before/after diff.
- TSDoc on every public symbol; no separate website or auto-generated API reference.
- No automated release pipeline; releases are a single `git tag && git push --tags`.

### Migration and rollout

- Single big-bang migration with local rehearsal: the package is built, the template is wired to the on-disk package via `pnpm add file:..`, the template's full test suite is run, the API is iterated until green, then the package is tagged `v0.1.0`, the template's dependency is switched from `file:..` to the git URL ref, and the template PR is merged.
- Existing spawned projects migrate lazily, per-project, via the existing project-migration CLI. There is no coordinated batch rollout. Each project decides when it adopts the package.
- Pre-rollout audit: any existing project with a patched embedded runner needs its patch mapped to a package hook (preSetup, postSetup, preTeardown, extraEnv) before the migration CLI runs against it, to prevent silent loss of customization.

## Testing Decisions

**What makes a good test (philosophy)**

Tests verify external behavior, not implementation details. For the runner orchestration as a whole — which is mostly a state machine over docker and child processes — isolated unit tests have low value: mocking docker and execa produces tests that test the mocks rather than the runner. The signal worth investing in is a real consumer running the runner against a real stack. Unit tests are reserved for pure logic where a silent bug can survive end-to-end runs unnoticed.

**Modules with unit tests in the package's own repo**

- **Runner state** — write / read / clear / stale-recovery semantics, including the PID-liveness behavior when the recorded PID is dead. The state file format is verified through round-trip behavior (write then read returns the same shape), not by asserting the exact serialized JSON.
- **Available port allocation** — returns a usable port; does not return the same port twice in immediate succession.
- **Project-name builder** — produces unique values across calls so concurrent runners do not collide on docker project names.
- **Runner output formatter** — snapshot tests on the formatted "ready" and "status" output blocks.

**Integration testing strategy**

- The package's CI clones the wesven-mvp-template at a pinned ref, redirects its `@wesven/testing` dependency to the local package source via `pnpm add file:..`, and runs the template's full `pnpm test:integration` and `pnpm test:e2e` suites. The template *is* the integration fixture; there is no synthetic sample project.
- A nightly scheduled CI run uses `template@main` instead of the pinned ref. On failure, it surfaces drift between the package and the live template before a consumer hits it.
- Linux runners only (no cross-OS matrix). One Node version, one postgres version (whatever the package's bundled compose file declares), one Next.js version (whatever the template currently uses).

**Prior art in the existing template that informs the package's tests**

- The template's existing unit-test layout under `tests/unit/`, the existing `vitest.unit.config.mts` shape (node environment, simple setup), and the existing Vitest patterns (`forks` pool, `singleFork: true`) are the model for the package's own unit tests.
- The runner's existing Listr2 / execa / Commander code (currently in `src/scripts/`) is the production-tested reference for the runner internals being moved into the package.
- The template's integration setup file is the reference for what `setupIntegrationTests` must reproduce: testing-library cleanup, jest-dom matchers, MSW lifecycle, database lifecycle, console silencing, next/navigation mocks, next/headers mocks.

## Out of Scope

- Generic / multi-stack support. The package is intentionally locked to the wesven stack (Next.js, Drizzle, Postgres, Vitest, Cypress, MSW, Better Auth, pnpm). No abstract core, no presets for other stacks.
- npm registry publishing. Distribution is git URL only for the foreseeable future.
- Automated release pipeline. Tagging is manual.
- Composable lifecycle. The lifecycle order is fixed; only the four named hook points are exposed.
- Cross-OS CI. Linux only.
- Multiple integration-test fixtures. The wesven-mvp-template is the single fixture.
- Codemods for breaking changes. Migration is manual, guided by CHANGELOG diffs against ten-line shim files.
- Test utilities such as a `renderWithProviders` helper. These wire project-specific providers (theme, query client config) and remain project-side.
- Project-specific test factories, fixtures, seeds, and MSW handlers. These are inherently project-specific and remain project-side.
- A formal coordinated migration of every existing spawned project. Existing projects migrate lazily through the user's own project-migration CLI.
- A `monorepo` reorganization (e.g., placing the package as a workspace inside the template repo). The package is a separate repo with a separate lifecycle.

## Further Notes

- The user's memory note about ESM dual-context behavior (`@next/env`, `pg-tsquery` and the `import * as ... ?? .default` workaround) is relevant: the first local rehearsal of the migration is the most likely place to find a similar module-resolution surprise, particularly because the package will be loaded by the consumer's `tsx` and may have nested CJS-flavored deps. Budget time for diagnosis on the first end-to-end run.
- The user has a custom CLI for migrating spawned projects from the template; once the package is adopted by the template, this CLI is the primary mechanism by which existing projects pick up the package. Auditing for diverged runners must happen before the CLI overwrites them.
- The `:up` blocking behavior (the e2e runner blocks on SIGINT/SIGTERM until killed) is preserved as part of the runner's contract. Consumers depend on this for testbed reuse during TDD.
- Pre-1.0 readiness criteria are deliberately set against real-use signals: a second consumer migrating successfully, and two minor bumps without breakage. Calendar-based 1.0 timing is rejected as not informative.
- A documented "eject" path (copy the package source back into a project) remains available as a release valve. The package is not designed to fight ejection; consumers can always fall back to embedded runners if their needs diverge.
