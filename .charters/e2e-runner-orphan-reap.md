# e2e-runner: reap orphaned app process trees — 2026-09-08

> Lightweight charter for `maintenance`-shape projects. Not a PRD — no user stories, no
> architecture, no testing-strategy section. Just enough to keep `/tdd` scope-honest.

## Goal
`e2e-runner` must never leave a running web-app process tree behind. Today every
`test:e2e:up` / `test:e2e` cycle can orphan a `pnpm run start` → pnpm shim → `next-server`
tree (reparented to `ppid 1`), each holding a resident server and a bound port, and nothing —
not teardown, not `:down`, not the next `:up` — ever reaps them. They accumulate until the
machine notices (20 trees / 60 processes observed on one consumer project).

## Acceptance Criteria

Runner behaviour (unit-testable through `createE2eRunner`'s command surface):

- [ ] The app is spawned in its own process group (`detached: true`), so a single signal can
      reach the whole tree rather than only the outermost `pnpm` node.
- [ ] The app's pid — which is also its pgid — is persisted to the runner state file at spawn
      time, so a *different* process can reap it later.
- [ ] Stopping the app signals the **group** (negative pid), awaits the child's exit with a
      bounded timeout, then escalates to `SIGKILL`. It does not fire-and-forget, and it does not
      signal only the wrapper.
- [ ] `:up`'s blocking wait tears down on `SIGHUP` in addition to `SIGINT` / `SIGTERM`, and has a
      last-resort net on process `exit` and `uncaughtException`.
- [ ] The default `test:e2e` run gets the same signal net as `:up`. It writes no state file, so
      an interrupt there orphans a tree nothing can ever reap — the goal names this mode too.
- [ ] `:down` reaps the persisted app group before clearing the state file — so it works even
      when run from a fresh shell, in a different process from the `:up` that spawned the app.
- [ ] `:up` self-heals: when state exists but the recorded runner pid is dead, it reaps the
      recorded app group before reusing that testbed — otherwise the orphan is still bound to
      the port the reused testbed is about to start on. It keeps the state (the docker project
      name and ports are what make reuse possible; clearing them would leak the container) and
      only falls back to clearing when reuse itself fails. When the runner pid is genuinely
      alive it still refuses — but the "run `:down` first" message now points at a command that
      actually recovers.
- [ ] Taking over a testbed clears the *previous* run's app pgid from the state before starting
      a new app, so a crash mid-takeover cannot leave `:down` holding a recycled pid belonging
      to an unrelated process.
- [ ] Reaping is idempotent and never throws: an already-dead pid, a missing pid, or an `ESRCH`
      is a no-op, not a teardown failure.

Host-level verification (manual, run once against a consumer project before release):

- [ ] `up` → `down` leaves no `next-server` and no `pnpm run start` surviving.
- [ ] `up` → `kill -HUP` the runner (or close its pane) leaves nothing surviving.
- [ ] `up` → `kill -9` the runner → a later `:down` from a fresh shell still reaps the server.
- [ ] Ten sequential `up`/`down` cycles leave zero residue:
      `ps -axo pid=,ppid=,command= | awk '$2 == 1 && (/pnpm run start/ || /next-server/)'` is empty.

## Out of Scope
- `integration-runner` — it spawns no long-lived app process, so it cannot leak one. Its
  signal handling is untouched.
- Docker volume leakage. Already fixed in `f79abb6` (`down -v` on teardown); the 31 dangling
  `*_test_data` volumes reported alongside the orphans were that bug, not this one.
- Reaping orphans left by *older* published versions. This fix stops new leaks; it does not
  hunt down trees that predate it.
- Any change to the port-allocation strategy, the Listr task graph, or the docker lifecycle.
- Reworking `blockUntilSignal` into a general-purpose process supervisor.

## Notes

Three decisions taken at scoping time, ahead of implementation:

1. **Keep the `pnpm run start` indirection; do not hardcode `next start`.** The reported
   "minimal fix" (`execa('next', ['start', '-p', port], { preferLocal: true })`) does not
   actually collapse the tree — Next 15's `next start` still forks a `next-server` child, so it
   trades a three-level tree for a two-level one while coupling this generic runner to Next and
   breaking any consumer whose `start` script does extra work. Detached-group kill is needed
   either way, and it subsumes the minimal fix.
2. **`:up` auto-reaps stale state, refuses live state.** No interactive prompt — the runner must
   stay usable in non-TTY / CI contexts. Unconditional auto-reap was rejected because a second
   concurrent `:up` would silently kill the first.
3. **Persisted app pid is treated as a pgid.** `detached: true` guarantees pid == pgid, which is
   what lets `:down` reap from an unrelated process.

Consequence to keep in mind while implementing: with `detached: true` the app is no longer in
the runner's foreground process group, so a terminal `Ctrl-C` (which signals the foreground
group) will not reach the app implicitly. Teardown *must* signal it explicitly — that is the
point of the change, but it means the SIGINT path is now load-bearing rather than incidental.

Source: issue report against `@wesven/testing v0.1.7`, consumed as
`github:ctrl-plus-w/wesven-testing#v0.1.7`. Line refs in that report are from the published
`dist/e2e-runner.js`; the source of truth is `src/e2e-runner.ts` and
`src/internal/runner-state.ts`.
