import type { EventEmitter } from 'node:events';

import { Listr } from 'listr2';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dockerDownCalls = vi.hoisted(() => [] as { removeVolumes: boolean }[]);

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('wait-on', () => ({
  default: vi.fn(async () => {}),
}));

vi.mock('@/internal/get-available-port', () => ({
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
    dockerUpTask: () => noopTask('docker up'),
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

beforeEach(() => {
  tickCounter = 0;
  listrRuns = [];
  execaCalls = [];
  hangingCommandArg = null;
  dockerDownCalls.length = 0;

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
