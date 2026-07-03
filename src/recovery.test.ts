import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryScheduler } from './recovery.ts';

// Deterministic fake clock + timer queue so the scheduler can be driven without
// real time.
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: (): number => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const handle = ++id;
      timers.set(handle, { fireAt: t + ms, fn });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    advance: (ms: number): void => {
      const end = t + ms;
      for (;;) {
        let nextHandle: number | null = null;
        let nextAt = Infinity;
        for (const [h, timer] of timers) {
          if (timer.fireAt <= end && timer.fireAt < nextAt) {
            nextAt = timer.fireAt;
            nextHandle = h;
          }
        }
        if (nextHandle === null) break;
        const timer = timers.get(nextHandle);
        timers.delete(nextHandle);
        if (timer) {
          t = timer.fireAt;
          timer.fn();
        }
      }
      t = end;
    },
  };
}

function make(clock: ReturnType<typeof fakeClock>) {
  return createRecoveryScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
}

test('fires entries at their reset time, earliest first', () => {
  const clock = fakeClock();
  const fired: string[] = [];
  const rec = make(clock);
  rec.record('b', new Date(2000), 'B', () => fired.push('B'));
  rec.record('a', new Date(1000), 'A', () => fired.push('A'));
  assert.equal(rec.pending(), 2);

  clock.advance(999);
  assert.deepEqual(fired, []);
  clock.advance(2); // t=1001, A due (resetAt 1000, within +1000 fudge)
  assert.deepEqual(fired, ['A']);
  assert.equal(rec.pending(), 1);
  clock.advance(1000); // t=2001, B due
  assert.deepEqual(fired, ['A', 'B']);
  assert.equal(rec.pending(), 0);
});

test('cancel drops a pending recovery', () => {
  const clock = fakeClock();
  const fired: string[] = [];
  const rec = make(clock);
  rec.record('a', new Date(1000), 'A', () => fired.push('A'));
  rec.cancel('a');
  assert.equal(rec.pending(), 0);
  clock.advance(5000);
  assert.deepEqual(fired, []);
});

test('re-recording the same key replaces the entry', () => {
  const clock = fakeClock();
  const fired: string[] = [];
  const rec = make(clock);
  rec.record('a', new Date(1000), 'A-old', () => fired.push('old'));
  rec.record('a', new Date(3000), 'A-new', () => fired.push('new'));
  assert.equal(rec.pending(), 1);
  clock.advance(1500); // old time passed, but entry was replaced
  assert.deepEqual(fired, []);
  clock.advance(2000); // t=3500
  assert.deepEqual(fired, ['new']);
});

test('a redispatch that throws does not stop siblings', () => {
  const clock = fakeClock();
  const fired: string[] = [];
  const rec = make(clock);
  rec.record('a', new Date(1000), 'A', () => {
    throw new Error('boom');
  });
  rec.record('b', new Date(1000), 'B', () => fired.push('B'));
  clock.advance(1500);
  assert.deepEqual(fired, ['B']);
  assert.equal(rec.pending(), 0);
});
