import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Discriminator for which runner owns a given on-disk state file.
 */
export type RunnerName = 'integration' | 'e2e';

/**
 * Persisted state of a running testbed. Written on `:up` and consumed by `:run`,
 * `:down`, and `:status`.
 */
export interface RunnerState {
  projectName: string;
  dbPort: number;
  appPort?: number;
  pid?: number;
  /**
   * Process-group id of the web application spawned by `:up`. Persisted so a later `:down` —
   * a different process entirely — can still reap the tree.
   */
  appPid?: number;
  startedAt?: number;
}

const stateDir = () => path.join(process.cwd(), 'node_modules', '.cache', 'test-runner');

export const stateFilePath = (runner: RunnerName) => path.join(stateDir(), `${runner}.json`);

export const readRunnerState = async (runner: RunnerName): Promise<RunnerState | null> => {
  try {
    const raw = await readFile(stateFilePath(runner), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const writeRunnerState = async (runner: RunnerName, state: RunnerState): Promise<void> => {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(stateFilePath(runner), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

export const clearRunnerState = async (runner: RunnerName): Promise<void> => {
  await rm(stateFilePath(runner), { force: true });
};

type RunnerStatePidKey = 'pid' | 'appPid';

const patchRunnerStatePid = async (
  runner: RunnerName,
  key: RunnerStatePidKey,
  value: number | undefined,
): Promise<void> => {
  const current = await readRunnerState(runner);
  if (!current) return;
  const { [key]: _omit, ...rest } = current;
  await writeRunnerState(runner, value === undefined ? rest : { ...rest, [key]: value });
};

/**
 * Records (or clears, with `null`) the pid of the runner process itself.
 */
export const updateRunnerStatePid = (runner: RunnerName, pid: number | null): Promise<void> =>
  patchRunnerStatePid(runner, 'pid', pid ?? undefined);

/**
 * Records (or clears, with `undefined`) the process-group id of the spawned web application.
 */
export const updateRunnerStateAppPid = (runner: RunnerName, appPid: number | undefined): Promise<void> =>
  patchRunnerStatePid(runner, 'appPid', appPid);

/**
 * Returns true when a process with the given PID is alive (or owned by another user).
 * EPERM means the PID exists but we cannot signal it.
 */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

interface PackageJson {
  name?: string;
}

export const sanitizeProjectBase = (raw: string): string => {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return lowered.length > 0 ? lowered : 'app';
};

let cachedBase: string | null = null;

const readPackageBase = async (): Promise<string> => {
  if (cachedBase) return cachedBase;
  const pkgRaw = await readFile(path.join(process.cwd(), 'package.json'), 'utf8');
  const pkg: PackageJson = JSON.parse(pkgRaw);
  cachedBase = sanitizeProjectBase(pkg.name ?? 'app');
  return cachedBase;
};

/**
 * Builds a unique-per-run docker COMPOSE_PROJECT_NAME so concurrent runners
 * cannot collide on docker resources.
 */
export const buildProjectName = async (runner: RunnerName): Promise<string> => {
  const base = await readPackageBase();
  const suffix = randomBytes(4).toString('hex');
  return `${base}-test-${runner}-${suffix}`;
};

/**
 * Test-only hook to reset the cached package-name base between unit tests.
 * @internal
 */
export const __resetCachedBase = (): void => {
  cachedBase = null;
};
