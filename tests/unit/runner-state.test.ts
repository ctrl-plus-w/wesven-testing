import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCachedBase,
  buildProjectName,
  clearRunnerState,
  isPidAlive,
  readRunnerState,
  sanitizeProjectBase,
  stateFilePath,
  updateRunnerStatePid,
  writeRunnerState,
} from '@/internal/runner-state';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'runner-state-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
  await writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test-project' }), 'utf8');
  __resetCachedBase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetCachedBase();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('runner state file lifecycle', () => {
  it('round-trips state through write → read', async () => {
    const state = { projectName: 'p1', dbPort: 5439, appPort: 3001, pid: 1234, startedAt: 1700000000000 };
    await writeRunnerState('integration', state);
    const got = await readRunnerState('integration');
    expect(got).toEqual(state);
  });

  it('returns null when no state file exists', async () => {
    const got = await readRunnerState('e2e');
    expect(got).toBeNull();
  });

  it('clears state', async () => {
    await writeRunnerState('integration', { projectName: 'p1', dbPort: 5439 });
    await clearRunnerState('integration');
    expect(await readRunnerState('integration')).toBeNull();
  });

  it('clearRunnerState is a no-op when state is missing', async () => {
    await expect(clearRunnerState('integration')).resolves.toBeUndefined();
  });

  it('writes the state file under cwd/node_modules/.cache/test-runner', async () => {
    await writeRunnerState('e2e', { projectName: 'p1', dbPort: 5439 });
    const expected = path.join(tmpRoot, 'node_modules', '.cache', 'test-runner', 'e2e.json');
    expect(stateFilePath('e2e')).toBe(expected);
    const onDisk = JSON.parse(await readFile(expected, 'utf8'));
    expect(onDisk).toEqual({ projectName: 'p1', dbPort: 5439 });
  });
});

describe('updateRunnerStatePid', () => {
  it('sets a pid on existing state', async () => {
    await writeRunnerState('integration', { projectName: 'p1', dbPort: 5439 });
    await updateRunnerStatePid('integration', 4242);
    expect(await readRunnerState('integration')).toEqual({ projectName: 'p1', dbPort: 5439, pid: 4242 });
  });

  it('removes the pid when passed null', async () => {
    await writeRunnerState('integration', { projectName: 'p1', dbPort: 5439, pid: 4242 });
    await updateRunnerStatePid('integration', null);
    expect(await readRunnerState('integration')).toEqual({ projectName: 'p1', dbPort: 5439 });
  });

  it('is a no-op when state is missing', async () => {
    await expect(updateRunnerStatePid('integration', 4242)).resolves.toBeUndefined();
    expect(await readRunnerState('integration')).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for an unused PID', () => {
    // 2^31 - 1 is well above any plausible PID; process.kill(huge, 0) returns ESRCH.
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });
});

describe('sanitizeProjectBase', () => {
  it('lowercases and strips disallowed characters', () => {
    expect(sanitizeProjectBase('My Project!')).toBe('myproject');
  });

  it('keeps alphanumerics, underscore, and hyphen', () => {
    expect(sanitizeProjectBase('my-project_v2')).toBe('my-project_v2');
  });

  it('falls back to "app" when nothing remains', () => {
    expect(sanitizeProjectBase('!!!')).toBe('app');
  });
});

describe('buildProjectName', () => {
  it('produces unique values across calls so concurrent runners do not collide', async () => {
    const names = await Promise.all(Array.from({ length: 8 }, () => buildProjectName('integration')));
    expect(new Set(names).size).toBe(names.length);
  });

  it('embeds the runner kind and the sanitized package name', async () => {
    const name = await buildProjectName('e2e');
    expect(name).toMatch(/^test-project-test-e2e-[0-9a-f]{8}$/);
  });
});
