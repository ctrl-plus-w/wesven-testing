import pc from 'picocolors';

import { type RunnerName, type RunnerState, stateFilePath } from '@/internal/runner-state';

type RunnerStatus = 'live' | 'stale' | 'idle';

const LABEL_WIDTH = 9;

export const formatUptime = (startedAt: number | undefined): string => {
  if (startedAt === undefined) return '?';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
};

const badge = (status: RunnerStatus): string => {
  switch (status) {
    case 'live':
      return pc.green('●');
    case 'stale':
      return pc.yellow('●');
    case 'idle':
      return pc.dim('○');
  }
};

const statusWord = (status: RunnerStatus): string => {
  switch (status) {
    case 'live':
      return pc.green('live');
    case 'stale':
      return pc.yellow('stale');
    case 'idle':
      return pc.dim('not running');
  }
};

const label = (text: string): string => pc.dim(text.padEnd(LABEL_WIDTH));

const renderUrl = (text: string): string => pc.cyan(pc.underline(text));

const portValue = (port: number, fromEnv: boolean, envName: string): string =>
  fromEnv ? `${port} ${pc.dim(`(from $${envName})`)}` : String(port);

interface Field {
  label: string;
  value: string;
}

const printHeader = (runner: RunnerName, status: RunnerStatus, suffix: string) => {
  const head = `${pc.bold(`${runner}-runner`)}  ${badge(status)} ${statusWord(status)}`;
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(suffix ? `${head}  ${pc.dim(suffix)}` : head);
};

const printFields = (fields: Field[]) => {
  for (const f of fields) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`  ${label(f.label)}${f.value}`);
  }
};

interface ReadyParams {
  runner: RunnerName;
  mode: 'default' | 'up';
  dbPort: number;
  dbFromEnv: boolean;
  dbUrl: string;
  appPort?: number;
  appFromEnv?: boolean;
  appUrl?: string;
  projectName: string;
  startedAt?: number;
}

/**
 * Prints the "ready" block once a runner has finished its setup phase.
 */
export const printReady = (params: ReadyParams) => {
  const suffix = params.mode === 'default' ? 'ready (default)' : `ready  up ${formatUptime(params.startedAt)}`;
  printHeader(params.runner, 'live', suffix);

  const fields: Field[] = [
    { label: 'db port', value: portValue(params.dbPort, params.dbFromEnv, 'TEST_DB_PORT') },
    { label: 'url', value: renderUrl(params.dbUrl) },
  ];
  if (params.appPort !== undefined) {
    fields.push({ label: 'app port', value: portValue(params.appPort, params.appFromEnv ?? false, 'PORT') });
    if (params.appUrl) fields.push({ label: 'url', value: renderUrl(params.appUrl) });
  }
  fields.push({ label: 'proj', value: params.projectName });
  if (params.mode === 'up') fields.push({ label: 'state', value: pc.dim(stateFilePath(params.runner)) });
  printFields(fields);
};

interface StatusParams {
  runner: RunnerName;
  state: RunnerState | null;
  pidAlive: boolean;
}

/**
 * Prints a runner's current status: idle / live / stale.
 */
export const printStatus = (params: StatusParams) => {
  if (!params.state) {
    printHeader(params.runner, 'idle', '');
    return;
  }

  const hasPid = params.state.pid !== undefined;
  const status: RunnerStatus = !hasPid || params.pidAlive ? 'live' : 'stale';
  const suffix =
    status === 'stale' ? '(last :up died, run :down to clean up)' : `up ${formatUptime(params.state.startedAt)}`;
  printHeader(params.runner, status, suffix);

  const fields: Field[] = [
    { label: 'db port', value: String(params.state.dbPort) },
    { label: 'url', value: renderUrl(`postgres://postgres:postgres@localhost:${params.state.dbPort}/main`) },
  ];
  if (params.state.appPort !== undefined) {
    fields.push({ label: 'app port', value: String(params.state.appPort) });
    fields.push({ label: 'url', value: renderUrl(`http://localhost:${params.state.appPort}`) });
  }
  fields.push({ label: 'proj', value: params.state.projectName });
  if (params.state.pid !== undefined) {
    const dead = params.pidAlive ? '' : ` ${pc.red('(dead)')}`;
    fields.push({ label: 'pid', value: `${params.state.pid}${dead}` });
  }
  fields.push({ label: 'state', value: pc.dim(stateFilePath(params.runner)) });
  printFields(fields);
};
