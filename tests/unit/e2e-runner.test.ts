import type { EventEmitter } from 'node:events';

import { Listr } from 'listr2';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dockerDownCalls = vi.hoisted(() => [] as { removeVolumes: boolean }[]);
const dockerUpCalls = vi.hoisted(() => [] as { allowReuse: boolean }[]);

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('wait-on', () => ({
  default: vi.fn(async () => {}),
}));

vi.mock('@/internal/get-available-port', () => ({
  isPortInUse: vi.fn(async () => false),
  resolvePort: vi.fn(async () => ({ port: 65000, fromEnv: false })),
}));

vi.mock('@/internal/runner-state', () => ({
  buildProjectName: vi.fn(async () => 'test-project'),
  clearRunnerState: vi.fn(async () => {}),
  isPidAlive: vi.fn(() => false),
  readRunnerState: vi.fn(async () => null),
  updateRunnerStateAppPid: vi.fn(async () => {}),
  updateRunnerStatePid: vi.fn(async () => {}),
  writeRunnerState: vi.fn(async () => {}),
}));

vi.mock('@/internal/reap-process-group', () => ({
  killProcessGroupNow: vi.fn(),
  reapProcessGroup: vi.fn(async () => {}),
}));

vi.mock('@/internal/listr-tasks', () => {
  const noopTask = (title: string) => ({ title, task: async () => {} });
  return {
    dockerUpTask: (_env: unknown, _dbPort: number, _projectName: string, allowReuse: boolean) => ({
      title: 'docker up',
      task: async () => {
        dockerUpCalls.push({ allowReuse });
      },
    }),
    dockerDownTask: (_env: unknown, _projectName: string, _compose: unknown, removeVolumes: boolean) => {
      dockerDownCalls.push({ removeVolumes });
      return noopTask('docker down');
    },
    migrateTask: () => noopTask('migrate'),
    resetTask: () => noopTask('reset'),
    injectTaskStdout: (cb: () => unknown) => async () => {
      await cb();
    },
  };
});

vi.mock('@/internal/runner-print', () => ({
  printReady: vi.fn(),
  printStatus: vi.fn(),
  formatUptime: vi.fn(),
}));

vi.mock('@/compose-file', () => ({
  composeFilePath: '/fake/compose.yaml',
}));

import { execa } from 'execa';
import waitOn from 'wait-on';

import { isPortInUse, resolvePort } from '@/internal/get-available-port';
import { reapProcessGroup } from '@/internal/reap-process-group';
import {
  clearRunnerState,
  isPidAlive,
  readRunnerState,
  updateRunnerStateAppPid,
  writeRunnerState,
} from '@/internal/runner-state';

import { createE2eRunner } from '@/e2e-runner';

interface ListrRunEntry {
  start: number;
  end: number;
}

interface ExecaCallEntry {
  argv: readonly string[];
  options: Record<string, unknown>;
  tick: number;
}

const APP_PID = 90210;

let tickCounter = 0;
const nextTick = () => ++tickCounter;
let listrRuns: ListrRunEntry[];
let execaCalls: ExecaCallEntry[];
let hangingCommandArg: string | null;
let appChild: () => FakeExecaChild;
let exitCodeBefore: typeof process.exitCode;

type FakeExecaChild = Promise<unknown> & {
  kill?: () => void;
  pid?: number;
  stdout?: unknown;
  stderr?: unknown;
};

const asExecaChild = (promise: Promise<unknown>): FakeExecaChild => {
  const child: FakeExecaChild = promise;
  child.kill = () => {};
  child.pid = APP_PID;
  child.stdout = undefined;
  child.stderr = undefined;
  return child;
};

const makeExecaResult = () => asExecaChild(Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));

const makePendingExecaResult = () => asExecaChild(new Promise(() => {}));

const isStartCommand = (cmd: string, args: readonly string[] | undefined) =>
  [cmd, ...(args ?? [])].join(' ') === 'pnpm run start';

beforeEach(() => {
  tickCounter = 0;
  listrRuns = [];
  execaCalls = [];
  hangingCommandArg = null;
  appChild = makePendingExecaResult;
  exitCodeBefore = process.exitCode;
  dockerDownCalls.length = 0;
  dockerUpCalls.length = 0;

  const originalRun = Listr.prototype.run;
  vi.spyOn(Listr.prototype, 'run').mockImplementation(async function (
    this: Listr,
    ...args: Parameters<typeof originalRun>
  ) {
    const entry: ListrRunEntry = { start: nextTick(), end: 0 };
    listrRuns.push(entry);
    const result = await originalRun.apply(this, args);
    entry.end = nextTick();
    return result;
  });

  vi.mocked(execa).mockImplementation(((cmd: string, args?: readonly string[], options?: Record<string, unknown>) => {
    execaCalls.push({ argv: [cmd, ...(args ?? [])], options: options ?? {}, tick: nextTick() });
    if (isStartCommand(cmd, args)) return appChild();
    if (hangingCommandArg !== null && (args ?? []).includes(hangingCommandArg)) return makePendingExecaResult();
    return makeExecaResult();
  }) as unknown as typeof execa);

  vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__test_process_exit__');
  }) as unknown as typeof process.exit);

  snapshotLifecycleListeners();
});

afterEach(() => {
  restoreLifecycleListeners();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = exitCodeBefore;
});

const fakeMswServer = (): SetupServer =>
  ({
    listen: vi.fn(),
    close: vi.fn(),
  }) as unknown as SetupServer;

const makeRunner = () => createE2eRunner({ resetTables: async () => {}, mswServer: fakeMswServer() });

const swallowTestExit = (err: unknown) => {
  if (!(err instanceof Error) || err.message !== '__test_process_exit__') throw err;
};

const silenceProcessExit = () => {
  vi.mocked(process.exit).mockImplementation((() => undefined) as unknown as typeof process.exit);
};

const runDefault = async () => {
  await makeRunner().parseAsync([], { from: 'user' }).catch(swallowTestExit);
};

const startAppCall = () => execaCalls.find((c) => c.argv.join(' ') === 'pnpm run start');

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const LIFECYCLE_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit', 'uncaughtException'] as const;

type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const processEvents: EventEmitter = process;

type ProcessListener = (...args: unknown[]) => void;

const listenersOf = (event: LifecycleEvent): ProcessListener[] => processEvents.listeners(event) as ProcessListener[];

const listenerSnapshot = new Map<LifecycleEvent, Set<unknown>>();

const snapshotLifecycleListeners = () => {
  listenerSnapshot.clear();
  for (const event of LIFECYCLE_EVENTS) listenerSnapshot.set(event, new Set(listenersOf(event)));
};

const restoreLifecycleListeners = () => {
  for (const event of LIFECYCLE_EVENTS) {
    const known = listenerSnapshot.get(event);
    for (const listener of listenersOf(event)) {
      if (!known?.has(listener)) processEvents.removeListener(event, listener);
    }
  }
};

const addedListeners = (event: LifecycleEvent): number =>
  listenersOf(event).filter((listener) => !listenerSnapshot.get(event)?.has(listener)).length;

const runUp = async (until: () => boolean, label: string) => {
  const parsed = makeRunner().parseAsync(['up'], { from: 'user' }).catch(swallowTestExit);
  await Promise.race([parsed, waitFor(until, label)]);
};

const runDown = async () => {
  await makeRunner().parseAsync(['down'], { from: 'user' }).catch(swallowTestExit);
};

describe('e2e-runner runDefault', () => {
  it('invokes cypress after the setup Listr has resolved', async () => {
    await runDefault();

    const cypressCall = execaCalls.find((c) => c.argv.includes('cypress'));
    expect(cypressCall, 'cypress execa should have been invoked').toBeDefined();

    const setupListrRun = listrRuns[0];
    expect(setupListrRun, 'setup Listr.run should have been invoked').toBeDefined();
    expect(setupListrRun?.end, 'setup Listr.run should have resolved').toBeGreaterThan(0);

    expect(cypressCall?.tick, 'cypress execa should be invoked after setup Listr resolves').toBeGreaterThan(
      setupListrRun?.end ?? 0,
    );
  });

  it('removes the docker volume during teardown so testbed volumes do not accumulate', async () => {
    await runDefault();

    expect(dockerDownCalls.length, 'teardown should run a docker-down task').toBeGreaterThan(0);
    expect(
      dockerDownCalls.every((c) => c.removeVolumes),
      'every teardown must request volume removal (docker compose down -v)',
    ).toBe(true);
  });
});

describe('e2e-runner app process lifecycle', () => {
  it('spawns the web app in its own process group', async () => {
    await runDefault();

    expect(startAppCall(), 'the web app should have been spawned').toBeDefined();
    expect(
      startAppCall()?.options.detached,
      'without detached the runner holds no group to signal, only the pnpm wrapper',
    ).toBe(true);
  });

  it('records the app process group in the runner state', async () => {
    await runDefault();

    expect(
      vi.mocked(updateRunnerStateAppPid).mock.calls.map(([, pid]) => pid),
      'the app pgid must be persisted so a later :down can reap it',
    ).toContain(APP_PID);
  });

  it('reaps the whole app process group during teardown', async () => {
    await runDefault();

    expect(
      vi.mocked(reapProcessGroup).mock.calls.map(([params]) => params.pgid),
      'teardown must reap the group, not signal the pnpm wrapper that ignores SIGTERM',
    ).toContain(APP_PID);
  });
});

describe('e2e-runner runUp self-heal', () => {
  const deadRunnerState = () => ({
    projectName: 'test-project',
    dbPort: 65000,
    appPort: 65001,
    pid: 4242,
    appPid: APP_PID,
  });

  it('reaps the orphaned app before reusing a testbed whose runner died', async () => {
    vi.mocked(readRunnerState).mockResolvedValue(deadRunnerState());
    vi.mocked(isPidAlive).mockReturnValue(false);

    await runUp(() => vi.mocked(reapProcessGroup).mock.calls.length > 0, 'reap during takeover');

    expect(
      vi.mocked(reapProcessGroup).mock.calls.map(([params]) => params.pgid),
      'the orphan still holds the port the reused testbed is about to start on',
    ).toContain(APP_PID);
  });

  it('clears the previous run app pgid when taking over a testbed', async () => {
    vi.mocked(readRunnerState).mockResolvedValue(deadRunnerState());
    vi.mocked(isPidAlive).mockReturnValue(false);

    await runUp(() => vi.mocked(writeRunnerState).mock.calls.length > 0, 'state rewritten on takeover');

    const [, written] = vi.mocked(writeRunnerState).mock.calls[0] ?? [];
    expect(written, 'takeover should rewrite the state').toBeDefined();
    expect(
      written?.appPid,
      'keeping the dead pgid lets a crash mid-takeover leave :down holding a recycled pid',
    ).toBeUndefined();
  });

  it('refuses, without reaping, while another :up is still live', async () => {
    vi.mocked(readRunnerState).mockResolvedValue(deadRunnerState());
    vi.mocked(isPidAlive).mockReturnValue(true);

    await runUp(() => vi.mocked(process.exit).mock.calls.length > 0, 'refusal');

    expect(
      vi.mocked(reapProcessGroup),
      'a live testbed belongs to another runner; killing its app would be a surprise',
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(process.exit).mock.calls.map(([code]) => code),
      'refusal should exit non-zero',
    ).toContain(1);
  });
});

describe('e2e-runner blockUntilSignal', () => {
  const runUpUntilBlocked = async () => {
    silenceProcessExit();
    await runUp(() => addedListeners('SIGHUP') > 0, 'lifecycle handlers registered');
  };

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('reaps the app on %s', async (signal) => {
    await runUpUntilBlocked();

    process.emit(signal);
    await waitFor(() => vi.mocked(reapProcessGroup).mock.calls.length > 0, `teardown on ${signal}`);

    expect(
      vi.mocked(reapProcessGroup).mock.calls.map(([params]) => params.pgid),
      `${signal} must tear the app down; closing a terminal pane sends SIGHUP, not SIGINT`,
    ).toContain(APP_PID);
  });

  it('installs a last-resort net for a crashing or exiting runner', async () => {
    await runUpUntilBlocked();

    expect(addedListeners('exit'), 'a runner that exits without a signal still owns a live app').toBeGreaterThan(0);
    expect(addedListeners('uncaughtException'), 'a crashing runner still owns a live app').toBeGreaterThan(0);
  });
});

describe('e2e-runner runDefault interruption', () => {
  it('reaps the app when the run is interrupted mid-cypress', async () => {
    silenceProcessExit();
    hangingCommandArg = 'cypress';

    void makeRunner().parseAsync([], { from: 'user' }).catch(swallowTestExit);

    await waitFor(() => addedListeners('SIGHUP') > 0, 'lifecycle handlers registered for the default run');
    process.emit('SIGINT');
    await waitFor(() => vi.mocked(reapProcessGroup).mock.calls.length > 0, 'teardown on interrupt');

    expect(
      vi.mocked(reapProcessGroup).mock.calls.map(([params]) => params.pgid),
      'a default run writes no state file, so an interrupt here orphans a tree nothing can reap',
    ).toContain(APP_PID);
  });
});

describe('e2e-runner runDown', () => {
  const stateWithApp = () => ({
    projectName: 'test-project',
    dbPort: 65000,
    appPort: 65001,
    appPid: APP_PID,
  });

  it('removes the docker volume when tearing the testbed down', async () => {
    vi.mocked(readRunnerState).mockResolvedValueOnce({ projectName: 'test-project', dbPort: 65000, appPort: 65001 });

    await runDown();

    expect(dockerDownCalls.length, 'down should run a docker-down task').toBeGreaterThan(0);
    expect(
      dockerDownCalls.every((c) => c.removeVolumes),
      'down must request volume removal (docker compose down -v)',
    ).toBe(true);
  });

  it('reaps the app process group recorded by a previous :up', async () => {
    vi.mocked(readRunnerState).mockResolvedValueOnce(stateWithApp());

    await runDown();

    expect(
      vi.mocked(reapProcessGroup).mock.calls.map(([params]) => params.pgid),
      'down runs in a different process from :up, so the persisted pgid is its only handle on the app',
    ).toContain(APP_PID);
  });

  it('reaps the app before clearing the state file', async () => {
    vi.mocked(readRunnerState).mockResolvedValueOnce(stateWithApp());

    await runDown();

    const reapedAt = vi.mocked(reapProcessGroup).mock.invocationCallOrder[0];
    const clearedAt = vi.mocked(clearRunnerState).mock.invocationCallOrder[0];

    expect(reapedAt, 'the app should have been reaped').toBeDefined();
    expect(clearedAt, 'the state file should have been cleared').toBeDefined();
    expect(reapedAt ?? 0, 'clearing state first would discard the only handle on the app').toBeLessThan(clearedAt ?? 0);
  });

  it('tolerates state written before app pids were recorded', async () => {
    vi.mocked(readRunnerState).mockResolvedValueOnce({ projectName: 'test-project', dbPort: 65000, appPort: 65001 });

    await runDown();

    expect(dockerDownCalls.length, 'an absent appPid must not abort the rest of teardown').toBeGreaterThan(0);
  });
});

describe('e2e-runner app port', () => {
  const useRealPortResolution = async () => {
    const actual = await vi.importActual<typeof import('@/internal/get-available-port')>(
      '@/internal/get-available-port',
    );
    vi.mocked(resolvePort).mockImplementation(actual.resolvePort);
  };

  const cypressCall = () => execaCalls.find((c) => c.argv.includes('cypress'));

  const waitedResources = () => vi.mocked(waitOn).mock.calls.flatMap(([options]) => options.resources);

  it('pins the app port from E2E_APP_PORT', async () => {
    await useRealPortResolution();
    vi.stubEnv('E2E_APP_PORT', '4321');
    vi.stubEnv('PORT', undefined);

    await runDefault();

    expect(startAppCall()?.options.env, 'the app must listen on the pinned port').toHaveProperty('PORT', '4321');
    expect(waitedResources(), 'readiness must be awaited on the pinned port').toContain('tcp:4321');
    expect(cypressCall()?.options.env, 'cypress must target the pinned port').toHaveProperty(
      'CYPRESS_BASE_URL',
      'http://localhost:4321',
    );
  });

  it("does not put the app on the shell's PORT, which a wesven task gives its dev server", async () => {
    await useRealPortResolution();
    vi.stubEnv('E2E_APP_PORT', undefined);
    vi.stubEnv('PORT', '4100');

    await runDefault();

    expect(startAppCall()?.options.env, 'the app must get a port of its own').not.toHaveProperty('PORT', '4100');
    expect(waitedResources(), 'an open 4100 is the dev server, not the app').not.toContain('tcp:4100');
    expect(cypressCall()?.options.env, 'cypress must not test the dev server').not.toHaveProperty(
      'CYPRESS_BASE_URL',
      'http://localhost:4100',
    );
  });

  it('sets PORT for the app process only', async () => {
    await runDefault();

    expect(startAppCall()?.options.env, 'the app reads its port from PORT').toHaveProperty('PORT', '65000');
    for (const call of execaCalls.filter((c) => c !== startAppCall())) {
      expect(call.options.env, `${call.argv.join(' ')} must not be handed the app's PORT`).not.toHaveProperty('PORT');
    }
  });

  it("leaves the runner's own PORT as the shell set it", async () => {
    vi.stubEnv('PORT', '4100');

    await runDefault();

    expect(process.env.PORT, 'hooks and later children of the runner must not see the app port as PORT').toBe('4100');
  });
});

describe('e2e-runner app port already in use', () => {
  it('fails before building or starting anything on a default run', async () => {
    vi.mocked(isPortInUse).mockResolvedValue(true);

    await expect(makeRunner().parseAsync([], { from: 'user' }), 'the run must fail loudly').rejects.toThrow(
      /port 65000 is already in use/,
    );

    expect(startAppCall(), 'whatever answers on the port would be tested instead of the app').toBeUndefined();
    expect(execaCalls, 'nothing should be built for a run that cannot start').toEqual([]);
  });

  it('fails a fresh :up before writing state or starting the database', async () => {
    vi.mocked(isPortInUse).mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runUp(() => vi.mocked(process.exit).mock.calls.length > 0, ':up exit');

    expect(
      vi.mocked(writeRunnerState),
      'a state file would point :run at a testbed that never came up',
    ).not.toHaveBeenCalled();
    expect(dockerUpCalls, 'no database should be started for a testbed that cannot start').toEqual([]);
    expect(execaCalls, 'nothing should be built for a testbed that cannot start').toEqual([]);
    expect(process.exitCode, ':up must exit non-zero').toBe(1);
  });

  it('does not start the app of a reused testbed whose port is now taken', async () => {
    vi.mocked(readRunnerState).mockResolvedValue({
      projectName: 'test-project',
      dbPort: 65000,
      appPort: 65001,
      pid: 4242,
      appPid: APP_PID,
    });
    vi.mocked(isPidAlive).mockReturnValue(false);
    vi.mocked(isPortInUse).mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runUp(
      () => vi.mocked(process.exit).mock.calls.length > 0 || startAppCall() !== undefined,
      'refusal or app start',
    );

    expect(startAppCall(), 'the reused port answers already, so readiness would pass on it').toBeUndefined();
    expect(process.exitCode, ':up must exit non-zero').toBe(1);
  });

  describe('on a reused testbed', () => {
    const savedState = () => ({
      projectName: 'test-project',
      dbPort: 65000,
      appPort: 65001,
      pid: 4242,
      appPid: APP_PID,
    });

    const reportedMessages = () =>
      vi
        .mocked(console.error)
        .mock.calls.flat()
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)));

    let loggedLines: string[];

    const runUpUntilExit = async () => {
      vi.mocked(readRunnerState).mockResolvedValue(savedState());
      vi.mocked(isPidAlive).mockReturnValue(false);
      await runUp(() => vi.mocked(process.exit).mock.calls.length > 0, ':up exit');
    };

    beforeEach(() => {
      loggedLines = [];
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        loggedLines.push(args.map(String).join(' '));
      });
    });

    it('keeps the saved testbed instead of reading the taken port as stale state', async () => {
      vi.mocked(isPortInUse).mockResolvedValue(true);

      await runUpUntilExit();

      expect(
        vi.mocked(clearRunnerState),
        'the state is the only handle :down has on the testbed',
      ).not.toHaveBeenCalled();
      expect(vi.mocked(writeRunnerState), 'the saved state should stay as it was').not.toHaveBeenCalled();
      expect(dockerUpCalls, 'a fresh testbed would leave the saved one running with nothing to remove it').toEqual([]);
      expect(loggedLines.join('\n'), 'the testbed is not stale').not.toContain('stale state');
      expect(process.exitCode, ':up must exit non-zero').toBe(1);
    });

    it('says the taken port belongs to the saved testbed and how to get out', async () => {
      vi.mocked(isPortInUse).mockResolvedValue(true);

      await runUpUntilExit();

      const message = reportedMessages().find((text) => text.includes('port 65001 is already in use'));
      expect(message, 'the failure should name the saved app port').toBeDefined();
      expect(message, 'E2E_APP_PORT is not read when a testbed is reused').not.toContain('E2E_APP_PORT');
      expect(message, ':down is the way to drop the saved testbed').toContain(':down');
    });

    it('keeps the testbed when the port is taken while the reused testbed starts', async () => {
      vi.mocked(isPortInUse).mockResolvedValueOnce(false).mockResolvedValue(true);

      await runUpUntilExit();

      expect(startAppCall(), 'whatever took the port would be tested instead of the app').toBeUndefined();
      expect(
        vi.mocked(clearRunnerState),
        'the state is the only handle :down has on the testbed',
      ).not.toHaveBeenCalled();
      expect(
        dockerUpCalls.filter((call) => !call.allowReuse),
        'no fresh testbed should be started next to the saved one',
      ).toEqual([]);
      expect(process.exitCode, ':up must exit non-zero').toBe(1);
    });
  });
});

describe('e2e-runner app exiting before it is ready', () => {
  const failedStart = (stderr: string) =>
    asExecaChild(
      Promise.reject(
        Object.assign(new Error('Command failed with exit code 1: pnpm run start'), { exitCode: 1, stderr }),
      ),
    );

  const portAnswersLater = () => {
    vi.mocked(waitOn).mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  };

  const killedBy = (signal: NodeJS.Signals) =>
    Object.assign(new Error(`Command was killed with ${signal}: pnpm run start`), { signal, stderr: '' });

  const reportedErrors = () =>
    vi
      .mocked(console.error)
      .mock.calls.flat()
      .filter((arg): arg is Error => arg instanceof Error);

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('stops before cypress when the app dies while another server answers on its port', async () => {
    appChild = () => failedStart('Error: listen EADDRINUSE: address already in use :::65000');
    portAnswersLater();

    await runDefault();

    expect(
      execaCalls.find((c) => c.argv.includes('cypress')),
      'cypress would run against the server that holds the port',
    ).toBeUndefined();
    expect(process.exitCode, 'the run must fail').toBe(1);
  });

  it('treats an app that exits cleanly before it is ready as a failure', async () => {
    appChild = () => asExecaChild(Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }));
    portAnswersLater();

    await runDefault();

    expect(
      execaCalls.find((c) => c.argv.includes('cypress')),
      'no app is left to test',
    ).toBeUndefined();
    expect(process.exitCode, 'the run must fail').toBe(1);
  });

  it('reports the exit code and the end of the app stderr', async () => {
    const stderr = ['first-line-of-output', ...Array.from({ length: 30 }, (_, i) => `noise ${i}`), 'EADDRINUSE'];
    appChild = () => failedStart(stderr.join('\n'));
    portAnswersLater();

    await runDefault();

    const message = reportedErrors()
      .map((err) => err.message)
      .find((text) => text.includes('before port 65000 was ready'));
    expect(message, 'the failure should name the app and its port').toBeDefined();
    expect(message, 'the exit code says how it died').toContain('exited with code 1');
    expect(message, 'the last stderr lines say why').toContain('EADDRINUSE');
    expect(message, 'only the tail is kept').not.toContain('first-line-of-output');
  });

  it('reports an app that could not be spawned with its own error', async () => {
    appChild = () => asExecaChild(Promise.reject(new Error('Command failed with ENOENT: pnpm run start')));
    portAnswersLater();

    await runDefault();

    expect(
      execaCalls.find((c) => c.argv.includes('cypress')),
      'nothing of ours answers on the port',
    ).toBeUndefined();
    expect(
      reportedErrors().map((err) => err.message),
      'a spawn failure has no exit code to report, so its own message is kept',
    ).toContain('Command failed with ENOENT: pnpm run start');
  });

  it('reports the signal that killed the app', async () => {
    appChild = () => asExecaChild(Promise.reject(killedBy('SIGKILL')));
    portAnswersLater();

    await runDefault();

    const message = reportedErrors()
      .map((err) => err.message)
      .find((text) => text.includes('before port 65000 was ready'));
    expect(message, 'a killed app has a signal, not an exit code').toContain('was killed by SIGKILL');
    expect(message, 'there is no exit code to report').not.toContain('exited with code');
    expect(process.exitCode, 'the run must fail').toBe(1);
  });

  it('does not fail a run whose app is stopped by teardown after it was ready', async () => {
    let stopApp: (error: Error) => void = () => {};
    appChild = () =>
      asExecaChild(
        new Promise((_resolve, reject) => {
          stopApp = reject;
        }),
      );
    vi.mocked(reapProcessGroup).mockImplementation(async () => {
      stopApp(killedBy('SIGTERM'));
    });
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      await runDefault();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }

    expect(vi.mocked(reapProcessGroup), 'teardown should stop the app').toHaveBeenCalled();
    expect(
      execaCalls.find((c) => c.argv.includes('cypress')),
      'the app was ready, so cypress should run',
    ).toBeDefined();
    expect(reportedErrors(), 'an app stopped by teardown did not fail to start').toEqual([]);
    expect(unhandled, 'the exit watcher outlives the readiness race and must not reject unhandled').toEqual([]);
    expect(process.exitCode, 'the run must pass').toBe(exitCodeBefore);
  });
});
