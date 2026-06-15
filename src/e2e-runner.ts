import { Command } from '@commander-js/extra-typings';
import { type ExecaChildProcess, execa } from 'execa';
import { Listr } from 'listr2';
import type { SetupServer } from 'msw/node';
import waitOn from 'wait-on';

import { resolvePort } from '@/internal/get-available-port';
import {
  type AnyTask,
  type BaseRunnerEnv,
  dockerDownTask,
  dockerUpTask,
  injectTaskStdout,
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
  updateRunnerStatePid,
  writeRunnerState,
} from '@/internal/runner-state';

import { composeFilePath } from '@/compose-file';

const RUNNER = 'e2e' as const;

/**
 * Options accepted by `createE2eRunner`.
 */
export interface E2eRunnerOptions {
  /**
   * Project's `resetTables` function. Called between every test run to truncate
   * all tables in dependency-safe order.
   */
  resetTables: () => Promise<void>;
  /**
   * Project's MSW server (the `node` setup). The runner calls `.listen()` before
   * Cypress starts and `.close()` during teardown.
   */
  mswServer: SetupServer;
  composeFile?: string;
  extendCompose?: string;
  preSetup?: () => Promise<void>;
  postSetup?: () => Promise<void>;
  preTeardown?: () => Promise<void>;
  extraEnv?: Record<string, string>;
}

interface E2eContext extends ListrCtx {
  webAppProcess?: ExecaChildProcess;
}

interface E2eRunnerEnv extends BaseRunnerEnv {
  PORT: string;
  BETTER_AUTH_URL: string;
  NEXT_PUBLIC_APP_URL: string;
}

const buildEnv = (dbPort: number, appPort: number, extraEnv: Record<string, string> | undefined): E2eRunnerEnv => {
  const appUrl = `http://localhost:${appPort}`;
  return {
    FORCE_COLOR: 'true',
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://postgres:postgres@localhost:${dbPort}/main`,
    TEST_DB_PORT: String(dbPort),
    PORT: String(appPort),
    BETTER_AUTH_URL: appUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
    ...extraEnv,
  };
};

const exportEnv = (env: E2eRunnerEnv) => {
  for (const [k, v] of Object.entries(env)) {
    if (k === 'FORCE_COLOR' || k === 'NODE_ENV') continue;
    if (typeof v === 'string') process.env[k] = v;
  }
};

const buildAppTask = (env: E2eRunnerEnv, enabled: boolean) => ({
  title: 'Building the web application',
  task: injectTaskStdout(() => execa('pnpm', ['run', 'build'], { env })),
  rendererOptions: { outputBar: Number.POSITIVE_INFINITY, persistentOutput: true },
  enabled: () => enabled,
});

const startAppTask = (env: E2eRunnerEnv, appPort: number) => ({
  title: `Starting the application (port ${appPort})`,
  task: async (ctx: E2eContext, task: AnyTask) => {
    const webProcess = execa('pnpm', ['run', 'start'], { env });
    webProcess.stdout?.pipe(task.stdout());
    webProcess.stderr?.pipe(task.stdout());
    ctx.webAppProcess = webProcess;

    await waitOn({ resources: [`tcp:${appPort}`], timeout: 60 * 1000 });
  },
  rendererOptions: { outputBar: Number.POSITIVE_INFINITY, persistentOutput: true },
});

const startMockTask = (server: SetupServer) => ({
  title: 'Starting the external api mock',
  task: () => server.listen(),
});

const stopAppTask = () => ({
  title: 'Stopping the web application',
  task: (ctx: E2eContext) => {
    if (ctx.webAppProcess) ctx.webAppProcess.kill();
  },
});

const stopMockTask = (server: SetupServer) => ({
  title: 'Stopping the external api mock',
  task: () => server.close(),
});

const buildCypressArgs = (options: { open: boolean; cypressArgs: readonly string[] }) => [
  'exec',
  'cypress',
  options.open ? 'open' : 'run',
  ...options.cypressArgs,
];

const printReadyBlock = (params: {
  mode: 'default' | 'up';
  dbPort: number;
  dbFromEnv: boolean;
  appPort: number;
  appFromEnv: boolean;
  env: E2eRunnerEnv;
  projectName: string;
  startedAt?: number;
}) =>
  printReady({
    runner: RUNNER,
    mode: params.mode,
    dbPort: params.dbPort,
    dbFromEnv: params.dbFromEnv,
    dbUrl: params.env.DATABASE_URL,
    appPort: params.appPort,
    appFromEnv: params.appFromEnv,
    appUrl: params.env.NEXT_PUBLIC_APP_URL,
    projectName: params.projectName,
    startedAt: params.startedAt,
  });

/**
 * Builds a Commander program that drives the end-to-end lifecycle:
 *
 * `preSetup` → docker up || (build + app start) || mock start → migrate → reset → `postSetup` →
 * cypress → `preTeardown` → stop app → docker down → stop mock.
 *
 * The `:up` subcommand blocks on SIGINT/SIGTERM so the testbed can be reused by `:run`.
 */
export const createE2eRunner = (opts: E2eRunnerOptions) => {
  const composeFile = opts.composeFile ?? composeFilePath;
  const compose = { composeFile, extendCompose: opts.extendCompose };
  const server = opts.mswServer;

  const runDefault = async (options: { open: boolean; skipBuild: boolean; cypressArgs: readonly string[] }) => {
    const { port: dbPort, fromEnv: dbFromEnv } = await resolvePort('TEST_DB_PORT');
    const { port: appPort, fromEnv: appFromEnv } = await resolvePort('PORT');
    const env = buildEnv(dbPort, appPort, opts.extraEnv);
    exportEnv(env);
    const projectName = await buildProjectName(RUNNER);

    printReadyBlock({ mode: 'default', dbPort, dbFromEnv, appPort, appFromEnv, env, projectName });

    if (opts.preSetup) await opts.preSetup();

    const tasks = new Listr<E2eContext>([
      {
        title: 'Setup the environment',
        task: (_ctx, task) =>
          task.newListr(
            [
              {
                title: 'Starting the testbed database environment',
                task: (_dbCtx, dbTask) =>
                  dbTask.newListr(
                    [
                      dockerUpTask(env, dbPort, projectName, false, compose),
                      migrateTask(env),
                      resetTask(opts.resetTables),
                    ],
                    { concurrent: false, rendererOptions: { collapseSubtasks: false } },
                  ),
              },
              {
                title: 'Starting the application environment',
                task: (_appCtx, appTask) =>
                  appTask.newListr([buildAppTask(env, !options.skipBuild), startAppTask(env, appPort)], {
                    concurrent: false,
                    rendererOptions: { collapseSubtasks: false },
                  }),
              },
              startMockTask(server),
            ],
            { concurrent: true, rendererOptions: { collapseSubtasks: false } },
          ),
      },
    ]);

    const cleanupTasks = new Listr<E2eContext>([
      stopAppTask(),
      dockerDownTask(env, projectName, compose, true),
      stopMockTask(server),
    ]);

    try {
      await tasks.run();
      if (opts.postSetup) await opts.postSetup();
      const result = await execa('pnpm', buildCypressArgs(options), {
        env: { ...env, CYPRESS_BASE_URL: env.NEXT_PUBLIC_APP_URL },
        reject: false,
        stdio: 'inherit',
      });
      if (typeof result.exitCode === 'number' && result.exitCode !== 0) process.exitCode = result.exitCode;
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
      await cleanupTasks.run(tasks.ctx);

      process.exit();
    }
  };

  const blockUntilSignal = async (params: { webContext: E2eContext }): Promise<never> => {
    const cleanupTasks = new Listr<E2eContext>([stopAppTask(), stopMockTask(server)]);

    let cleanupRan = false;
    const teardown = async () => {
      if (cleanupRan) return;
      cleanupRan = true;
      try {
        await cleanupTasks.run(params.webContext);
      } catch (err) {
        console.error(err);
      }
      try {
        await updateRunnerStatePid(RUNNER, null);
      } catch (err) {
        console.error(err);
      }
      process.exit();
    };

    process.once('SIGINT', teardown);
    process.once('SIGTERM', teardown);

    await new Promise<void>(() => {});
    throw new Error('blockUntilSignal: unreachable');
  };

  const runFreshUp = async (options: { skipBuild: boolean }) => {
    const { port: dbPort, fromEnv: dbFromEnv } = await resolvePort('TEST_DB_PORT');
    const { port: appPort, fromEnv: appFromEnv } = await resolvePort('PORT');
    const env = buildEnv(dbPort, appPort, opts.extraEnv);
    exportEnv(env);
    const projectName = await buildProjectName(RUNNER);
    const startedAt = Date.now();

    await writeRunnerState(RUNNER, { projectName, dbPort, appPort, pid: process.pid, startedAt });

    if (opts.preSetup) await opts.preSetup();

    const tasks = new Listr<E2eContext>([
      {
        title: 'Setup the environment',
        task: (_ctx, task) =>
          task.newListr(
            [
              {
                title: 'Starting the testbed database environment',
                task: (_dbCtx, dbTask) =>
                  dbTask.newListr([dockerUpTask(env, dbPort, projectName, false, compose), migrateTask(env)], {
                    concurrent: false,
                    rendererOptions: { collapseSubtasks: false },
                  }),
              },
              {
                title: 'Starting the application environment',
                task: (_appCtx, appTask) =>
                  appTask.newListr([buildAppTask(env, !options.skipBuild), startAppTask(env, appPort)], {
                    concurrent: false,
                    rendererOptions: { collapseSubtasks: false },
                  }),
              },
              startMockTask(server),
            ],
            { concurrent: true, rendererOptions: { collapseSubtasks: false } },
          ),
      },
    ]);

    try {
      await tasks.run();
    } catch (err) {
      await clearRunnerState(RUNNER);
      throw err;
    }

    if (opts.postSetup) await opts.postSetup();

    printReadyBlock({ mode: 'up', dbPort, dbFromEnv, appPort, appFromEnv, env, projectName, startedAt });

    await blockUntilSignal({ webContext: tasks.ctx });
  };

  const runReuseUp = async (state: RunnerState) => {
    if (!state.appPort) throw new Error('state missing appPort');
    const appPort = state.appPort;
    const env = buildEnv(state.dbPort, appPort, opts.extraEnv);
    exportEnv(env);
    const startedAt = Date.now();

    await writeRunnerState(RUNNER, { ...state, pid: process.pid, startedAt });

    if (opts.preSetup) await opts.preSetup();

    const tasks = new Listr<E2eContext>([
      {
        title: 'Reusing the testbed environment',
        task: (_ctx, task) =>
          task.newListr(
            [
              {
                title: 'Reusing the testbed database environment',
                task: (_dbCtx, dbTask) =>
                  dbTask.newListr(
                    [dockerUpTask(env, state.dbPort, state.projectName, true, compose), migrateTask(env)],
                    {
                      concurrent: false,
                      rendererOptions: { collapseSubtasks: false },
                    },
                  ),
              },
              {
                title: 'Starting the application environment',
                task: (_appCtx, appTask) =>
                  appTask.newListr([startAppTask(env, appPort)], {
                    concurrent: false,
                    rendererOptions: { collapseSubtasks: false },
                  }),
              },
              startMockTask(server),
            ],
            { concurrent: true, rendererOptions: { collapseSubtasks: false } },
          ),
      },
    ]);

    await tasks.run();

    if (opts.postSetup) await opts.postSetup();

    printReadyBlock({
      mode: 'up',
      dbPort: state.dbPort,
      dbFromEnv: false,
      appPort,
      appFromEnv: false,
      env,
      projectName: state.projectName,
      startedAt,
    });

    await blockUntilSignal({ webContext: tasks.ctx });
  };

  const runUp = async (options: { skipBuild: boolean }) => {
    try {
      const state = await readRunnerState(RUNNER);

      if (state) {
        if (state.pid && isPidAlive(state.pid)) {
          console.error(`e2e-runner: another :up appears to be running (pid ${state.pid}). Run :down first.`);
          process.exit(1);
        }
        try {
          await runReuseUp(state);
          return;
        } catch (err) {
          console.error(err);
          // biome-ignore lint/suspicious/noConsole: notify on stale-state recovery
          console.log('e2e-runner: stale state cleared, reallocating');
          await clearRunnerState(RUNNER);
        }
      }

      await runFreshUp(options);
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
      process.exit();
    }
  };

  const runRun = async (options: { open: boolean; cypressArgs: readonly string[] }) => {
    const state = await readRunnerState(RUNNER);
    if (!state || !state.appPort) {
      console.error('e2e-runner: no testbed up. run `pnpm test:e2e:up` first.');
      process.exit(1);
    }

    const env = buildEnv(state.dbPort, state.appPort, opts.extraEnv);
    exportEnv(env);

    // biome-ignore lint/suspicious/noConsole: CLI hint to confirm which testbed is targeted
    console.log(`e2e-runner: using db port ${state.dbPort} / app port ${state.appPort}`);

    const setupTasks = new Listr<E2eContext>([resetTask(opts.resetTables)]);

    try {
      await setupTasks.run();
      if (opts.postSetup) await opts.postSetup();
      const result = await execa('pnpm', buildCypressArgs(options), {
        env: { ...env, CYPRESS_BASE_URL: env.NEXT_PUBLIC_APP_URL },
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

    const env = buildEnv(state.dbPort, state.appPort ?? 0, opts.extraEnv);
    const tasks = new Listr<E2eContext>([dockerDownTask(env, state.projectName, compose, true)]);

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
    const pidAlive = state?.pid !== undefined ? isPidAlive(state.pid) : false;
    printStatus({ runner: RUNNER, state, pidAlive });
    process.exit();
  };

  const program = new Command()
    .name('e2e-runner')
    .description('Run the end-to-end tests. Set TEST_DB_PORT or PORT to pin specific host ports.')
    .enablePositionalOptions();

  program
    .command('default', { isDefault: true, hidden: true })
    .description('Full lifecycle: docker up + build + app + mock + cypress + cleanup')
    .option('-o, --open', 'Open the test runner UI')
    .option('--skip-build', 'Skip the build step')
    .argument('[cypressArgs...]', 'Args forwarded to cypress')
    .allowUnknownOption()
    .action(async (cypressArgs, options) => {
      await runDefault({ open: !!options.open, skipBuild: !!options.skipBuild, cypressArgs });
    });

  program
    .command('up')
    .description('Bring the testbed up on dynamic ports (or $TEST_DB_PORT / $PORT) and block until killed')
    .option('--skip-build', 'Skip the build step')
    .action(async (options) => {
      await runUp({ skipBuild: !!options.skipBuild });
    });

  program
    .command('run')
    .description('Reset tables and run cypress against the running testbed')
    .option('-o, --open', 'Open the test runner UI')
    .argument('[cypressArgs...]', 'Args forwarded to cypress')
    .allowUnknownOption()
    .action(async (cypressArgs, options) => {
      await runRun({ open: !!options.open, cypressArgs });
    });

  program
    .command('down')
    .description('Stop and remove the testbed database container')
    .action(async () => {
      await runDown();
    });

  program
    .command('status')
    .description('Print the running testbed details (live / stale / not running)')
    .action(async () => {
      await runStatus();
    });

  return program;
};
