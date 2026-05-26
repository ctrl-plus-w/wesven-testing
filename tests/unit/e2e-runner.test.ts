import { Listr } from 'listr2';
import type { SetupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  updateRunnerStatePid: vi.fn(async () => {}),
  writeRunnerState: vi.fn(async () => {}),
}));

vi.mock('@/internal/listr-tasks', () => {
  const noopTask = (title: string) => ({ title, task: async () => {} });
  return {
    dockerUpTask: () => noopTask('docker up'),
    dockerDownTask: () => noopTask('docker down'),
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

import { createE2eRunner } from '@/e2e-runner';

interface ListrRunEntry {
  start: number;
  end: number;
}

interface ExecaCallEntry {
  argv: readonly string[];
  tick: number;
}

let tickCounter = 0;
const nextTick = () => ++tickCounter;
let listrRuns: ListrRunEntry[];
let execaCalls: ExecaCallEntry[];

const makeExecaResult = () => {
  const result: Record<string, unknown> = { exitCode: 0, stdout: '', stderr: '' };
  const promise: Promise<unknown> & { kill?: () => void; stdout?: unknown; stderr?: unknown } = Promise.resolve(result);
  promise.kill = () => {};
  promise.stdout = undefined;
  promise.stderr = undefined;
  return promise;
};

beforeEach(() => {
  tickCounter = 0;
  listrRuns = [];
  execaCalls = [];

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

  vi.mocked(execa).mockImplementation(((cmd: string, args?: readonly string[]) => {
    execaCalls.push({ argv: [cmd, ...(args ?? [])], tick: nextTick() });
    return makeExecaResult();
  }) as unknown as typeof execa);

  vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__test_process_exit__');
  }) as unknown as typeof process.exit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeMswServer = (): SetupServer =>
  ({
    listen: vi.fn(),
    close: vi.fn(),
  }) as unknown as SetupServer;

const runDefault = async () => {
  const runner = createE2eRunner({
    resetTables: async () => {},
    mswServer: fakeMswServer(),
  });
  try {
    await runner.parseAsync([], { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__test_process_exit__') throw err;
  }
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
});
