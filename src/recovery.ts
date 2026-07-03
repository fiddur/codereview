// Auto-recovery for usage-limit ("session limit") failures.
//
// When a spawned review/tryout dies on the account's hard usage cap, the caller
// records the failed work here along with the reset instant. The scheduler keeps
// a single coalesced timer to the earliest reset; when it fires it re-dispatches
// every due item through its `redispatch` closure (which re-enters the normal
// scheduling path — so release tryouts resume from their partial `.review.json`,
// docker tryouts re-run, reviews re-review). A real webhook for the same PR
// before the timer fires should `cancel()` its pending recovery so a stale SHA
// is never re-fired.

export type RecoveryScheduler = {
  // Record (or replace) a pending recovery for `key`, to fire at `resetAt`.
  record(key: string, resetAt: Date, label: string, redispatch: () => void): void;
  // Drop a pending recovery (e.g. the PR was handled by a fresh webhook).
  cancel(key: string): void;
  // Number of pending recoveries — for tests/introspection.
  pending(): number;
};

type Entry = { resetAt: number; redispatch: () => void; label: string };

export type RecoveryDeps = {
  log?: (msg: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function createRecoveryScheduler(deps: RecoveryDeps = {}): RecoveryScheduler {
  const now = deps.now ?? ((): number => Date.now());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms);
      // Don't keep the process alive solely for a pending recovery.
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));
  const log = deps.log ?? ((): void => {});

  const entries = new Map<string, Entry>();
  let timer: unknown = null;
  let timerFireAt = Infinity;

  function arm(): void {
    let earliest = Infinity;
    for (const e of entries.values()) earliest = Math.min(earliest, e.resetAt);
    if (earliest === Infinity) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
        timerFireAt = Infinity;
      }
      return;
    }
    // An existing timer that already fires at or before `earliest` is fine.
    if (timer !== null && timerFireAt <= earliest) return;
    if (timer !== null) clearTimer(timer);
    timerFireAt = earliest;
    timer = setTimer(fire, Math.max(0, earliest - now()));
  }

  function fire(): void {
    timer = null;
    timerFireAt = Infinity;
    // Small fudge absorbs timer jitter without sweeping in genuinely-later
    // entries (reset times are minutes apart in practice).
    const t = now() + 100;
    const due: Entry[] = [];
    for (const [key, e] of entries) {
      if (e.resetAt <= t) {
        due.push(e);
        entries.delete(key);
      }
    }
    for (const e of due) {
      log(`♻️  auto-recovering: ${e.label}`);
      try {
        e.redispatch();
      } catch (err: unknown) {
        log(`⚠️  recovery redispatch failed for ${e.label}: ${String(err)}`);
      }
    }
    arm(); // re-arm for any entries not yet due
  }

  return {
    record(key, resetAt, label, redispatch): void {
      entries.set(key, { resetAt: resetAt.getTime(), redispatch, label });
      log(`♻️  recovery scheduled: ${label} at ${resetAt.toISOString()} (${entries.size} pending)`);
      arm();
    },
    cancel(key): void {
      if (entries.delete(key)) arm();
    },
    pending: (): number => entries.size,
  };
}
