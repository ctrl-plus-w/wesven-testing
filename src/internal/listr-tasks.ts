import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { type ExecaChildProcess, execa } from 'execa';
import type { DefaultRenderer, ListrTaskWrapper, SimpleRenderer } from 'listr2';

const promisifiedExec = promisify(exec);

export type ListrCtx = Record<string, unknown>;
export type AnyTask = ListrTaskWrapper<ListrCtx, typeof DefaultRenderer, typeof SimpleRenderer>;

export interface BaseRunnerEnv extends NodeJS.ProcessEnv {
  FORCE_COLOR: 'true';
  NODE_ENV: 'test';
  DATABASE_URL: string;
  TEST_DB_PORT: string;
}

/**
 * Pipes a child process's stdout/stderr into the surrounding Listr task's output stream.
 * `ignoreError` swallows non-zero exits when callers want to keep the lifecycle running.
 */
export const injectTaskStdout = <Ctx extends ListrCtx>(
  commandCb: (ctx: Ctx, task: AnyTask) => ExecaChildProcess,
  ignoreError?: boolean,
) => {
  return async (ctx: Ctx, task: AnyTask) => {
    const child = commandCb(ctx, task);
    child.stdout?.pipe(task.stdout());
    child.stderr?.pipe(task.stdout());

    if (ignoreError) {
      try {
        await child;
      } catch (_error) {}
    } else {
      await child;
    }
  };
};

/**
 * Returns the spawn-env block to use with `docker compose` so it picks up our project name
 * and port overrides regardless of the caller's existing env.
 */
const composeEnv = (env: BaseRunnerEnv, projectName: string) => ({
  ...process.env,
  ...env,
  COMPOSE_PROJECT_NAME: projectName,
});

const composeFileFlags = (composeFile: string, extendCompose: string | undefined): string => {
  const base = `-f ${JSON.stringify(composeFile)}`;
  return extendCompose ? `${base} -f ${JSON.stringify(extendCompose)}` : base;
};

export interface ComposeOpts {
  composeFile: string;
  extendCompose?: string;
}

export const dockerUpTask = (
  env: BaseRunnerEnv,
  dbPort: number,
  projectName: string,
  allowReuse: boolean,
  compose: ComposeOpts,
) => ({
  title: `Starting the database container (host port ${dbPort})`,
  task: () => {
    const flag = allowReuse ? ' --no-recreate' : '';
    const files = composeFileFlags(compose.composeFile, compose.extendCompose);
    return promisifiedExec(`docker compose ${files} up --detach --wait${flag}`, {
      env: composeEnv(env, projectName),
    });
  },
});

export const dockerDownTask = (
  env: BaseRunnerEnv,
  projectName: string,
  compose: ComposeOpts,
  removeVolumes: boolean,
) => ({
  title: 'Stopping the database container',
  task: () => {
    const files = composeFileFlags(compose.composeFile, compose.extendCompose);
    const v = removeVolumes ? ' -v' : '';
    return promisifiedExec(`docker compose ${files} down${v}`, {
      env: composeEnv(env, projectName),
    });
  },
});

export const migrateTask = (env: BaseRunnerEnv) => ({
  title: 'Running the migrations',
  task: injectTaskStdout(() => execa('pnpm', ['run', 'db:migrate'], { env })),
});

export const resetTask = (resetTables: () => Promise<void>) => ({
  title: 'Resetting the database',
  task: async () => {
    await resetTables();
  },
});
