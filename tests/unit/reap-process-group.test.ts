import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { killProcessGroupNow, reapProcessGroup } from '@/internal/reap-process-group';

type KillCall = [number, (string | number)?];

const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

let killSpy: MockInstance<typeof process.kill>;

const mockGroup = (behaviour: (pid: number, signal: string | number | undefined) => void) => {
  killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    behaviour(pid, signal);
    return true;
  });
};

const calls = (): KillCall[] => killSpy.mock.calls.map(([pid, signal]) => [pid, signal]);

const signalsSent = (): (string | number | undefined)[] => calls().map(([, signal]) => signal);

beforeEach(() => {
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reapProcessGroup', () => {
  it('signals the process group rather than the bare pid', async () => {
    mockGroup(() => {});

    await reapProcessGroup({ pgid: 4242, timeoutMs: 20, pollMs: 5 });

    expect(signalsSent(), 'a SIGTERM should be sent').toContain('SIGTERM');
    expect(
      calls().every(([pid]) => pid === -4242),
      'every signal must target the negative pid (the group), never the wrapper alone',
    ).toBe(true);
  });

  it('escalates to SIGKILL when the group outlives the grace period', async () => {
    mockGroup(() => {});

    await reapProcessGroup({ pgid: 4242, timeoutMs: 20, pollMs: 5 });

    expect(signalsSent(), 'a group that ignores SIGTERM must be SIGKILLed').toContain('SIGKILL');
  });

  it('keeps a process with nothing else to do alive until the group is reaped', () => {
    const reapModule = fileURLToPath(new URL('../../src/internal/reap-process-group.ts', import.meta.url));
    const script = `
      import { spawn } from 'node:child_process';
      import { reapProcessGroup } from ${JSON.stringify(reapModule)};
      const child = spawn('sh', ['-c', 'trap "" TERM; sleep 30'], { detached: true, stdio: 'ignore' });
      child.unref();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await reapProcessGroup({ pgid: child.pid, timeoutMs: 300, pollMs: 20 });
      console.log('reaped');
    `;

    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(run.stdout.trim(), `the teardown must not exit mid-wait\n${run.stderr}`).toBe('reaped');
  });

  it('does not escalate when the group exits during the grace period', async () => {
    mockGroup((_pid, signal) => {
      if (signal !== 'SIGTERM') throw esrch();
    });

    await reapProcessGroup({ pgid: 4242, timeoutMs: 500, pollMs: 5 });

    expect(signalsSent(), 'a group that shut down cleanly must not be SIGKILLed').not.toContain('SIGKILL');
  });

  it('is a no-op when no pgid was recorded', async () => {
    await reapProcessGroup({ pgid: undefined, timeoutMs: 20, pollMs: 5 });

    expect(killSpy, 'nothing to reap means nothing to signal').not.toHaveBeenCalled();
  });

  it('does not throw when the group is already gone', async () => {
    mockGroup(() => {
      throw esrch();
    });

    await expect(
      reapProcessGroup({ pgid: 4242, timeoutMs: 20, pollMs: 5 }),
      'reaping an already-dead group must not fail teardown',
    ).resolves.toBeUndefined();
  });
});

describe('killProcessGroupNow', () => {
  it('SIGKILLs the group without awaiting anything', () => {
    mockGroup(() => {});

    killProcessGroupNow(4242);

    expect(calls(), 'an exit handler cannot await, so the last resort must be a synchronous kill').toEqual([
      [-4242, 'SIGKILL'],
    ]);
  });

  it('is a no-op when no pgid was recorded', () => {
    killProcessGroupNow(undefined);

    expect(killSpy, 'nothing to reap means nothing to signal').not.toHaveBeenCalled();
  });

  it('does not throw when the group is already gone', () => {
    mockGroup(() => {
      throw esrch();
    });

    expect(() => killProcessGroupNow(4242), 'a last-resort reaper must never itself crash the exit').not.toThrow();
  });
});
