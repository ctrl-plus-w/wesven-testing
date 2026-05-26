import { Listr } from 'listr2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('@/internal/get-available-port', () => ({
  resolvePort: vi.fn(async () => ({ port: 65000, fromEnv: false })),
}));

vi.mock('@/internal/runner-state', () => ({
  buildProjectName: vi.fn(async () => 'test-project'),
  clearRunnerState: vi.fn(async () => {}),
  isPidAlive: vi.fn(() => false),
  readRunnerState: vi.fn(async () => null),
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

import { createIntegrationRunner } from '@/integration-runner';

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
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }) as unknown as typeof execa);

  vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
    throw new Error('__test_process_exit__');
  }) as unknown as typeof process.exit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runDefault = async () => {
  const runner = createIntegrationRunner({ resetTables: async () => {} });
  try {
    await runner.parseAsync([], { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__test_process_exit__') throw err;
  }
};

describe('integration-runner runDefault', () => {
  it('invokes vitest after the setup Listr has resolved', async () => {
    await runDefault();

    const vitestCall = execaCalls.find((c) => c.argv.includes('vitest'));
    expect(vitestCall, 'vitest execa should have been invoked').toBeDefined();

    const setupListrRun = listrRuns[0];
    expect(setupListrRun, 'setup Listr.run should have been invoked').toBeDefined();
    expect(setupListrRun?.end, 'setup Listr.run should have resolved').toBeGreaterThan(0);

    expect(vitestCall?.tick, 'vitest execa should be invoked after setup Listr resolves').toBeGreaterThan(
      setupListrRun?.end ?? 0,
    );
  });
});
