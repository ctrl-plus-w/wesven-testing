import { Command } from '@commander-js/extra-typings';
import { execa } from 'execa';
import { Listr } from 'listr2';

import { resolvePort } from '@/internal/get-available-port';
import {
  type BaseRunnerEnv,
  dockerDownTask,
  dockerUpTask,
  type ListrCtx,
  migrateTask,
  resetTask,
} from '@/internal/listr-tasks';
import { printReady, printStatus } from '@/internal/runner-print';
import {
  buildProjectName,
  clearRunnerState,
  isPidAlive,
  type RunnerState,
  readRunnerState,
  writeRunnerState,
} from '@/internal/runner-state';

import { composeFilePath } from '@/compose-file';

const RUNNER = 'integration' as const;

/**
 * Options accepted by `createIntegrationRunner`.
 */
export interface IntegrationRunnerOptions {
  /**
   * Project's `resetTables` function. Called between every test run to truncate
   * all tables in dependency-safe order.
   */
  resetTables: () => Promise<void>;
  /**
   * Absolute path to a compose file replacing the package's bundled
   * `compose.test.yaml`. Defaults to `composeFilePath` from
   * `@wesven/testing/compose-file`.
   */
  composeFile?: string;
  /**
   * Absolute path to an additive overlay (`docker compose -f base -f overlay`).
   * Useful for adding services like Redis without forking the base file.
   */
  extendCompose?: string;
  /**
   * Hook fired before any docker / migration work. Receives nothing; runs in the
   * runner's process so it can read env or write state.
   */
  preSetup?: () => Promise<void>;
  /**
   * Hook fired after migrate + reset, before tests start. Use this to seed data
   * or warm caches.
   */
  postSetup?: () => Promise<void>;
  /**
   * Hook fired after tests finish, before the docker teardown.
   */
  preTeardown?: () => Promise<void>;
  /**
   * Extra environment variables passed to spawned processes (vitest, db:migrate,
   * docker compose). Merged after the runner's own env block, so callers cannot
   * override DATABASE_URL etc.
   */
  extraEnv?: Record<string, string>;
}

const buildEnv = (dbPort: number, extraEnv: Record<string, string> | undefined): BaseRunnerEnv => ({
  FORCE_COLOR: 'true',
  NODE_ENV: 'test',
  DATABASE_URL: `postgres://postgres:postgres@localhost:${dbPort}/main`,
  TEST_DB_PORT: String(dbPort),
  ...extraEnv,
});

const exportEnv = (env: BaseRunnerEnv) => {
  process.env.DATABASE_URL = env.DATABASE_URL;
  process.env.TEST_DB_PORT = env.TEST_DB_PORT;
  for (const [k, v] of Object.entries(env)) {
    if (k === 'FORCE_COLOR' || k === 'NODE_ENV') continue;
    if (typeof v === 'string') process.env[k] = v;
  }
};

const buildVitestArgs = (options: { watch: boolean; vitestArgs: readonly string[] }) => [
  'exec',
  'vitest',
  options.watch ? 'watch' : 'run',
  '--config',
  'vitest.integration.config.mts',
  ...options.vitestArgs,
];

const printReadyBlock = (params: {
  mode: 'default' | 'up';
  dbPort: number;
  dbFromEnv: boolean;
  env: BaseRunnerEnv;
  projectName: string;
  startedAt?: number;
}) =>
  printReady({
    runner: RUNNER,
    mode: params.mode,
    dbPort: params.dbPort,
    dbFromEnv: params.dbFromEnv,
    dbUrl: params.env.DATABASE_URL,
    projectName: params.projectName,
    startedAt: params.startedAt,
  });

/**
 * Builds a Commander program that drives the integration-test lifecycle:
 *
 * `preSetup` → docker up → migrate → reset → `postSetup` → vitest → `preTeardown` → docker down.
 *
 * Returns the program; the caller invokes `.parse()` to take over the process.
 */
export const createIntegrationRunner = (opts: IntegrationRunnerOptions) => {
  const composeFile = opts.composeFile ?? composeFilePath;
  const compose = { composeFile, extendCompose: opts.extendCompose };

  const runDefault = async (options: { watch: boolean; vitestArgs: readonly string[] }) => {
    const { port: dbPort, fromEnv: dbFromEnv } = await resolvePort('TEST_DB_PORT');
    const env = buildEnv(dbPort, opts.extraEnv);
    exportEnv(env);
    const projectName = await buildProjectName(RUNNER);

    printReadyBlock({ mode: 'default', dbPort, dbFromEnv, env, projectName });

    let testOutput = '';

    if (opts.preSetup) await opts.preSetup();

    const setupTasks = new Listr<ListrCtx>([
      {
        title: 'Setting up the test database',
        task: (_ctx, task) =>
          task.newListr(
            [dockerUpTask(env, dbPort, projectName, false, compose), migrateTask(env), resetTask(opts.resetTables)],
            { concurrent: false, rendererOptions: { collapseSubtasks: false } },
          ),
      },
      {
        title: 'Running integration tests',
        task: async () => {
          if (opts.postSetup) await opts.postSetup();
          const result = await execa('pnpm', buildVitestArgs(options), { env, reject: false });
          testOutput = result.stdout + (result.stderr ? `\n${result.stderr}` : '');
          if (typeof result.exitCode === 'number' && result.exitCode !== 0) process.exitCode = result.exitCode;
        },
      },
    ]);

    const cleanupTasks = new Listr<ListrCtx>([dockerDownTask(env, projectName, compose, true)]);

    try {
      await setupTasks.run();
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    } finally {
      if (opts.preTeardown) {
        try {
          await opts.preTeardown();
        } catch (err) {
          console.error(err);
        }
      }
      await cleanupTasks.run();

      if (testOutput) {
        // biome-ignore lint/suspicious/noConsole: CLI script needs to output test report
        console.log(testOutput);
      }

      process.exit();
    }
  };

  const runFreshUp = async () => {
    const { port: dbPort, fromEnv: dbFromEnv } = await resolvePort('TEST_DB_PORT');
    const env = buildEnv(dbPort, opts.extraEnv);
    exportEnv(env);
    const projectName = await buildProjectName(RUNNER);
    const startedAt = Date.now();

    await writeRunnerState(RUNNER, { projectName, dbPort, startedAt });

    if (opts.preSetup) await opts.preSetup();

    const tasks = new Listr<ListrCtx>(
      [
        {
          title: 'Setting up the test database',
          task: (_ctx, task) =>
            task.newListr([dockerUpTask(env, dbPort, projectName, false, compose), migrateTask(env)], {
              concurrent: false,
              rendererOptions: { collapseSubtasks: false },
            }),
        },
      ],
      { concurrent: false },
    );

    try {
      await tasks.run();
    } catch (err) {
      await clearRunnerState(RUNNER);
      throw err;
    }

    if (opts.postSetup) await opts.postSetup();

    printReadyBlock({ mode: 'up', dbPort, dbFromEnv, env, projectName, startedAt });
  };

  const runReuseUp = async (state: RunnerState) => {
    const env = buildEnv(state.dbPort, opts.extraEnv);
    exportEnv(env);
    const startedAt = Date.now();

    await writeRunnerState(RUNNER, { ...state, startedAt });

    if (opts.preSetup) await opts.preSetup();

    const tasks = new Listr<ListrCtx>(
      [
        {
          title: 'Reusing the test database',
          task: (_ctx, task) =>
            task.newListr([dockerUpTask(env, state.dbPort, state.projectName, true, compose), migrateTask(env)], {
              concurrent: false,
              rendererOptions: { collapseSubtasks: false },
            }),
        },
      ],
      { concurrent: false },
    );

    await tasks.run();

    if (opts.postSetup) await opts.postSetup();

    printReadyBlock({
      mode: 'up',
      dbPort: state.dbPort,
      dbFromEnv: false,
      env,
      projectName: state.projectName,
      startedAt,
    });
  };

  const runUp = async () => {
    try {
      const state = await readRunnerState(RUNNER);

      if (state) {
        if (state.pid && isPidAlive(state.pid)) {
          console.error(`integration-runner: another :up appears to be running (pid ${state.pid}). Run :down first.`);
          process.exit(1);
        }
        try {
          await runReuseUp(state);
          return;
        } catch (err) {
          console.error(err);
          // biome-ignore lint/suspicious/noConsole: notify on stale-state recovery
          console.log('integration-runner: stale state cleared, reallocating');
          await clearRunnerState(RUNNER);
        }
      }

      await runFreshUp();
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  const runRun = async (vitestArgs: readonly string[]) => {
    const state = await readRunnerState(RUNNER);
    if (!state) {
      console.error('integration-runner: no testbed up. run `pnpm test:integration:up` first.');
      process.exit(1);
    }

    const env = buildEnv(state.dbPort, opts.extraEnv);
    exportEnv(env);

    // biome-ignore lint/suspicious/noConsole: CLI hint to confirm which testbed is targeted
    console.log(`integration-runner: using db port ${state.dbPort}`);

    const setupTasks = new Listr<ListrCtx>([resetTask(opts.resetTables)]);

    try {
      await setupTasks.run();
      if (opts.postSetup) await opts.postSetup();
      const result = await execa('pnpm', buildVitestArgs({ watch: false, vitestArgs }), {
        env,
        reject: false,
        stdio: 'inherit',
      });
      if (typeof result.exitCode === 'number') process.exitCode = result.exitCode;
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  const runDown = async () => {
    const state = await readRunnerState(RUNNER);
    if (!state) {
      process.exit();
    }

    const env = buildEnv(state.dbPort, opts.extraEnv);
    const tasks = new Listr<ListrCtx>([dockerDownTask(env, state.projectName, compose, true)]);

    try {
      if (opts.preTeardown) await opts.preTeardown();
      await tasks.run();
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    } finally {
      await clearRunnerState(RUNNER);
      process.exit();
    }
  };

  const runStatus = async () => {
    const state = await readRunnerState(RUNNER);
    printStatus({ runner: RUNNER, state, pidAlive: true });
    process.exit();
  };

  const program = new Command()
    .name('integration-runner')
    .description('Run integration tests with a temporary database. Set TEST_DB_PORT to pin a specific db host port.')
    .enablePositionalOptions();

  program
    .command('default', { isDefault: true, hidden: true })
    .description('Full lifecycle: docker up + migrate + reset + vitest + docker down')
    .option('-w, --watch', 'Run tests in watch mode')
    .argument('[vitestArgs...]', 'Args forwarded to vitest')
    .allowUnknownOption()
    .action(async (vitestArgs, options) => {
      await runDefault({ watch: !!options.watch, vitestArgs });
    });

  program
    .command('up')
    .description('Bring the test database up on a dynamic port (or $TEST_DB_PORT) and apply migrations')
    .action(async () => {
      await runUp();
    });

  program
    .command('run')
    .description('Reset tables and run vitest against the running test database')
    .argument('[vitestArgs...]', 'Args forwarded to vitest')
    .allowUnknownOption()
    .action(async (vitestArgs) => {
      await runRun(vitestArgs);
    });

  program
    .command('down')
    .description('Stop and remove the test database container')
    .action(async () => {
      await runDown();
    });

  program
    .command('status')
    .description('Print the running testbed details (live / not running)')
    .action(async () => {
      await runStatus();
    });

  return program;
};
