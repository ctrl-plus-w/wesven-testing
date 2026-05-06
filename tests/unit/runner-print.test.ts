import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatUptime, printReady, printStatus } from '@/internal/runner-print';

let logSpy: ReturnType<typeof vi.spyOn>;

const captured = (): string => {
  return logSpy.mock.calls.map((args) => (args as unknown[]).join(' ')).join('\n');
};

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatUptime', () => {
  it.each([
    [undefined, '?'],
    [0, '0s'],
    [1_000, '1s'],
    [60_000, '1m'],
    [60 * 60_000, '1h'],
    [(60 + 30) * 60_000, '1h 30m'],
    [24 * 60 * 60_000, '1d'],
    [(24 + 5) * 60 * 60_000, '1d 5h'],
  ])('formats elapsed %s as %s', (elapsedMs, expected) => {
    const startedAt = elapsedMs === undefined ? undefined : Date.now() - (elapsedMs as number);
    expect(formatUptime(startedAt)).toBe(expected);
  });
});

describe('printReady', () => {
  it('default mode (integration runner, db only)', () => {
    printReady({
      runner: 'integration',
      mode: 'default',
      dbPort: 5439,
      dbFromEnv: false,
      dbUrl: 'postgres://postgres:postgres@localhost:5439/main',
      projectName: 'demo-test-integration-deadbeef',
    });
    expect(captured()).toMatchInlineSnapshot(`
      "integration-runner  ● live  ready (default)
        db port  5439
        url      postgres://postgres:postgres@localhost:5439/main
        proj     demo-test-integration-deadbeef"
    `);
  });

  it('up mode (e2e runner, with appPort and pinned-from-env db)', () => {
    printReady({
      runner: 'e2e',
      mode: 'up',
      dbPort: 5439,
      dbFromEnv: true,
      dbUrl: 'postgres://postgres:postgres@localhost:5439/main',
      appPort: 3001,
      appFromEnv: false,
      appUrl: 'http://localhost:3001',
      projectName: 'demo-test-e2e-deadbeef',
      startedAt: Date.now() - 5_000,
    });
    const out = captured();
    expect(out).toContain('e2e-runner');
    expect(out).toContain('● live');
    expect(out).toContain('ready  up 5s');
    expect(out).toContain('db port  5439 (from $TEST_DB_PORT)');
    expect(out).toContain('app port 3001');
    expect(out).toContain('proj     demo-test-e2e-deadbeef');
    expect(out).toContain(path.join('node_modules', '.cache', 'test-runner', 'e2e.json'));
  });
});

describe('printStatus', () => {
  it('idle when no state file exists', () => {
    printStatus({ runner: 'integration', state: null, pidAlive: false });
    expect(captured()).toMatchInlineSnapshot(`"integration-runner  ○ not running"`);
  });

  it('live when state has no pid (default-mode runner finished)', () => {
    printStatus({
      runner: 'integration',
      state: { projectName: 'demo-test-integration-deadbeef', dbPort: 5439, startedAt: Date.now() - 5_000 },
      pidAlive: false,
    });
    const out = captured();
    expect(out).toContain('● live');
    expect(out).toContain('up 5s');
  });

  it('stale when pid is recorded but the process is dead', () => {
    printStatus({
      runner: 'e2e',
      state: { projectName: 'demo-test-e2e-deadbeef', dbPort: 5439, appPort: 3001, pid: 999_999 },
      pidAlive: false,
    });
    const out = captured();
    expect(out).toContain('● stale');
    expect(out).toContain('(last :up died, run :down to clean up)');
    expect(out).toContain('999999 (dead)');
  });
});
