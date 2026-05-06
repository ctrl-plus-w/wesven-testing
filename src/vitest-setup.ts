import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import type { SetupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

interface DatabaseLifecycle {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Options for `setupIntegrationTests`. Each toggle defaults to `true` and bypasses
 * one block of the default behavior when set to `false`.
 */
export interface SetupIntegrationOptions {
  /** Project's MSW server (the `node` setup). */
  server: SetupServer;
  /** Project's database lifecycle triple: setup, teardown, reset. */
  db: DatabaseLifecycle;
  /** Register the `next/navigation` mock (default: true). */
  mockNextNavigation?: boolean;
  /** Register the `next/headers` mock (default: true). */
  mockNextHeaders?: boolean;
  /** Silence `console.error` and `console.warn` per test (default: true). */
  silenceConsole?: boolean;
  /** Run the MSW lifecycle (listen / resetHandlers / close) (default: true). */
  msw?: boolean;
  /** Run the database lifecycle (setup / reset / teardown) (default: true). */
  database?: boolean;
}

/**
 * Registers the integration-test Vitest hooks that are common to every wesven project:
 *
 * - `@testing-library/jest-dom/vitest` matchers (loaded by importing this module)
 * - `@testing-library/react`'s `cleanup()` after each test
 * - MSW lifecycle: `server.listen` / `resetHandlers` / `close`
 * - Database lifecycle: `setup` / `reset` / `teardown`
 * - Console silencing
 * - `next/navigation` and `next/headers` mocks
 *
 * Call this from your `tests/setup/vitest-integration.setup.ts` shim, passing in
 * the project's MSW server and database lifecycle. Each block can be disabled
 * individually via the corresponding option.
 */
export const setupIntegrationTests = (options: SetupIntegrationOptions): void => {
  const {
    server,
    db,
    mockNextNavigation = true,
    mockNextHeaders = true,
    silenceConsole = true,
    msw = true,
    database = true,
  } = options;

  beforeAll(async () => {
    if (msw) server.listen({ onUnhandledRequest: 'warn' });
    if (database) await db.setup();
  });

  afterAll(async () => {
    if (msw) server.close();
    if (database) await db.teardown();
  });

  beforeEach(() => {
    if (msw) server.resetHandlers();
    if (silenceConsole) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    }
  });

  afterEach(async () => {
    cleanup();
    if (database) await db.reset();
    vi.clearAllMocks();
  });

  // vi.doMock is the runtime (non-hoisted) variant — required because this call
  // site is inside a function in a separate module. The hoisted vi.mock pattern
  // only applies when called at the top level of a setup or test file.
  if (mockNextNavigation) {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({
        push: vi.fn(),
        replace: vi.fn(),
        prefetch: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
      }),
      usePathname: () => '/',
      useSearchParams: () => new URLSearchParams(),
      useParams: () => ({}),
      redirect: vi.fn(),
      notFound: vi.fn(),
    }));
  }

  if (mockNextHeaders) {
    vi.doMock('next/headers', () => ({
      cookies: () => ({
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        getAll: vi.fn(() => []),
        has: vi.fn(() => false),
      }),
      headers: () => new Headers(),
    }));
  }
};

export interface SetupUnitOptions {
  /** Silence `console.error` and `console.warn` per test (default: true). */
  silenceConsole?: boolean;
}

/**
 * Registers the unit-test Vitest hooks: console silencing per test and
 * `vi.clearAllMocks()` after each test. Call from `tests/setup/vitest-unit.setup.ts`.
 */
export const setupUnitTests = (options: SetupUnitOptions = {}): void => {
  const { silenceConsole = true } = options;

  beforeEach(() => {
    if (silenceConsole) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
};
