const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 100;

/**
 * Arguments accepted by `reapProcessGroup`.
 */
export interface ReapProcessGroupParams {
  /** Process-group id to reap. Equal to the pid of a process spawned with `detached: true`. */
  pgid: number | undefined;
  /** How long to let the group shut down cleanly before escalating to SIGKILL. */
  timeoutMs?: number;
  /** How often to re-check group liveness while waiting. */
  pollMs?: number;
}

const isReapableGroup = (pgid: number | undefined): pgid is number => pgid !== undefined && pgid > 0;

const signalGroup = (pgid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const waitForGroupExit = async (pgid: number, timeoutMs: number, pollMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalGroup(pgid, 0)) return;
    await delay(Math.min(pollMs, deadline - Date.now()));
  }
};

/**
 * Terminates a whole process group and does not return until it is gone or the grace period
 * has elapsed. Sends SIGTERM to the group, waits for every member to exit, then escalates to
 * SIGKILL for whatever ignored it.
 *
 * Liveness is read from the group itself rather than from a child handle, so a wrapper that
 * exits while its grandchild keeps running does not count as reaped.
 *
 * Safe to call with a stale, foreign, or absent pgid: an unreachable group is a no-op, never
 * a thrown error, so teardown cannot fail on an already-dead app.
 */
export const reapProcessGroup = async (params: ReapProcessGroupParams): Promise<void> => {
  const { pgid, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = params;
  if (!isReapableGroup(pgid)) return;

  if (!signalGroup(pgid, 'SIGTERM')) return;

  await waitForGroupExit(pgid, timeoutMs, pollMs);

  if (!signalGroup(pgid, 0)) return;
  signalGroup(pgid, 'SIGKILL');
};

/**
 * Last-resort synchronous reap, for contexts that cannot await — notably a `process.on('exit')`
 * handler, where the event loop is already closed and `reapProcessGroup` would never resume.
 * Skips the grace period and goes straight to SIGKILL.
 */
export const killProcessGroupNow = (pgid: number | undefined): void => {
  if (!isReapableGroup(pgid)) return;
  signalGroup(pgid, 'SIGKILL');
};
