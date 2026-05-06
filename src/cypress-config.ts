import { defineConfig } from 'cypress';

type CypressConfig = ReturnType<typeof defineConfig>;
type CypressTaskMap = Record<string, (arg?: unknown) => unknown | Promise<unknown>>;

/**
 * Options for `defineE2EConfig`.
 */
export interface DefineE2EConfigOptions {
  /**
   * Project's `resetTables` function. Registered as the `resetDb` Cypress task,
   * so test specs can call `cy.task('resetDb')` to truncate state.
   */
  resetTables: () => Promise<void>;
  /**
   * Cypress baseUrl. Defaults to `http://localhost:3000`. The runner sets
   * `CYPRESS_BASE_URL` at spawn time, which always wins over this default.
   */
  baseUrl?: string;
  /** Path to the Cypress support file. Defaults to `tests/cypress/support/e2e.ts`. */
  supportFile?: string;
  /** Glob for Cypress spec files. Defaults to `tests/cypress/e2e/**\/*.cy.ts`. */
  specPattern?: string;
  /**
   * Extra Cypress tasks merged into the default set. Override `resetDb` here to
   * extend it (the user-supplied `resetTables` is the default implementation).
   */
  tasks?: CypressTaskMap;
}

/**
 * Builds a Cypress `defineConfig`-shaped object with sensible wesven defaults
 * and the `resetDb` task wired to the project's `resetTables`.
 */
export const defineE2EConfig = (options: DefineE2EConfigOptions): CypressConfig => {
  const baseUrl = options.baseUrl ?? 'http://localhost:3000';
  const supportFile = options.supportFile ?? 'tests/cypress/support/e2e.ts';
  const specPattern = options.specPattern ?? 'tests/cypress/e2e/**/*.cy.ts';

  return defineConfig({
    e2e: {
      baseUrl,
      supportFile,
      specPattern,
      setupNodeEvents(on) {
        on('task', {
          async resetDb() {
            await options.resetTables();
            return null;
          },
          ...options.tasks,
        });
      },
    },
  });
};
