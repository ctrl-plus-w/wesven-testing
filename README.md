# @wesven/testing

Shared testing infrastructure for wesven-stack projects (Next.js + Drizzle + Postgres + Vitest + Cypress + MSW). Distributed as a git URL pinned by tag. Compiled with `tsup`; ships ESM `.js` + `.d.ts` from `dist/`.

## Install

```jsonc
// package.json
{
  "dependencies": {
    "@wesven/testing": "github:wesven/wesven-testing#v0.1.0"
  }
}
```

The package declares `vitest`, `cypress`, `msw`, `react`, `react-dom`, `@vitejs/plugin-react`, `vite-tsconfig-paths`, `@testing-library/jest-dom`, `@testing-library/react`, and `jsdom` as peer dependencies. Keep them in your project's own `package.json`.

## Entry points

Six split entry points; no barrel.

| Entry point | Purpose |
| --- | --- |
| `@wesven/testing/integration-runner` | Factory for the integration-test CLI runner |
| `@wesven/testing/e2e-runner` | Factory for the end-to-end CLI runner |
| `@wesven/testing/vitest-config` | Base Vitest configs (integration + unit), extended via `mergeConfig` |
| `@wesven/testing/vitest-setup` | Setup factories for integration and unit Vitest setup files |
| `@wesven/testing/cypress-config` | Cypress base config factory |
| `@wesven/testing/compose-file` | Absolute path to the default `compose.test.yaml` asset |

## Consumer shims

Each shim is under ten lines. See the wesven-mvp-template for the canonical example.

### `tests/runners/integration.ts`
```ts
import { createIntegrationRunner } from '@wesven/testing/integration-runner';

createIntegrationRunner({
  resetTables: async () => {
    const { resetTables } = await import('@/util/db');
    await resetTables();
  },
}).parse();
```

### `tests/runners/e2e.ts`
```ts
import { server } from '@/mock/node';
import { createE2eRunner } from '@wesven/testing/e2e-runner';

createE2eRunner({
  mswServer: server,
  resetTables: async () => {
    const { resetTables } = await import('@/util/db');
    await resetTables();
  },
}).parse();
```

> **Note** — `resetTables` is wrapped in a dynamic `import()` because the project's
> `db` module reads `DATABASE_URL` at module-evaluation time. The runner sets the
> test `DATABASE_URL` before invoking the callback, so the dynamic import sees
> the right value. A static `import { resetTables } from '@/util/db'` at the top
> of the shim would bind to the dev/prod URL and connect to the wrong database.

### `vitest.integration.config.mts`
```ts
import { mergeConfig } from 'vitest/config';
import { integrationConfig } from '@wesven/testing/vitest-config';

export default mergeConfig(integrationConfig, {
  test: { setupFiles: ['./tests/setup/vitest-integration.setup.ts'] },
});
```

### `vitest.unit.config.mts`
```ts
import { mergeConfig } from 'vitest/config';
import { unitConfig } from '@wesven/testing/vitest-config';

export default mergeConfig(unitConfig, {
  test: { setupFiles: ['./tests/setup/vitest-unit.setup.ts'] },
});
```

### `tests/setup/vitest-integration.setup.ts`
```ts
import { server } from '@/mock/node';
import { resetTables, setupTestDatabase, teardownTestDatabase } from '@/test-util/db';
import { setupIntegrationTests } from '@wesven/testing/vitest-setup';

setupIntegrationTests({
  server,
  db: { setup: setupTestDatabase, teardown: teardownTestDatabase, reset: resetTables },
});
```

### `tests/setup/vitest-unit.setup.ts`
```ts
import { setupUnitTests } from '@wesven/testing/vitest-setup';

setupUnitTests();
```

### `cypress.config.ts`
```ts
import { resetTables } from './src/utils/db';
import { defineE2EConfig } from '@wesven/testing/cypress-config';

export default defineE2EConfig({ resetTables });
```

## Lifecycle and override contract

The runner lifecycle order is fixed: `preSetup` → docker up → migrate → reset → `postSetup` → tests → `preTeardown` → cleanup. Reordering is not supported. Override surface:

- `preSetup`, `postSetup`, `preTeardown`: optional async hooks
- `extraEnv`: extra env vars passed to spawned processes
- `composeFile`: absolute path replacing the default `compose.test.yaml`
- `extendCompose`: absolute path to an additive overlay (`docker compose -f default -f overlay`)

Vitest configs are extended via `mergeConfig`. Cypress is extended via the factory's options.

## Versioning

Pre-1.0: minor bumps may include breaking changes; patches are bug fixes only. 1.0 will ship after a second consumer (besides the template) has migrated and two consecutive minor bumps have passed without breakage. Releases are a single `git tag && git push --tags`. See `CHANGELOG.md` for migration diffs.

## License

MIT.
