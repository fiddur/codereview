import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AbortedError,
  errText,
  hasModelFlag,
  isModelQuotaError,
  isSessionLimitError,
  isTransientApiFailure,
  parseResetClock,
  redispatchDelayMs,
  REDISPATCH_DELAYS_MS,
  sessionLimitResetAt,
  withModel,
} from './run.ts';

test('parseResetClock handles the observed limit-message formats', () => {
  assert.deepEqual(parseResetClock("You've hit your session limit · resets 5pm (Europe/Stockholm)"), {
    hour24: 17, minute: 0, tz: 'Europe/Stockholm',
  });
  assert.deepEqual(parseResetClock('resets 1:40pm (Europe/Stockholm)'), {
    hour24: 13, minute: 40, tz: 'Europe/Stockholm',
  });
  assert.deepEqual(parseResetClock('resets 12pm (Europe/Stockholm)'), {
    hour24: 12, minute: 0, tz: 'Europe/Stockholm',
  });
  assert.deepEqual(parseResetClock('resets 12am (Europe/Stockholm)'), {
    hour24: 0, minute: 0, tz: 'Europe/Stockholm',
  });
  assert.deepEqual(parseResetClock('resets 11:40pm'), { hour24: 23, minute: 40, tz: 'Europe/Stockholm' });
  assert.equal(parseResetClock('no reset phrase here'), null);
});

// July → Stockholm is CEST (UTC+2), so 10:00Z == 12:00 local.
const NOON_LOCAL = new Date('2026-07-02T10:00:00Z');
const min = (n: number): number => n * 60_000;

test('sessionLimitResetAt resolves a later-today reset (+2min buffer)', () => {
  const at = sessionLimitResetAt('resets 5pm (Europe/Stockholm)', NOON_LOCAL);
  // 12:00 → 17:00 is 5h; +2min buffer.
  assert.equal(at?.getTime(), NOON_LOCAL.getTime() + min(5 * 60 + 2));
});

test('sessionLimitResetAt handles minutes', () => {
  const at = sessionLimitResetAt('resets 1:40pm (Europe/Stockholm)', NOON_LOCAL);
  assert.equal(at?.getTime(), NOON_LOCAL.getTime() + min(100 + 2));
});

test('sessionLimitResetAt fires soon when reset just passed', () => {
  // 11:30 local is 30min before "now" (12:00) → graceful near-immediate fire.
  const at = sessionLimitResetAt('resets 11:30am (Europe/Stockholm)', NOON_LOCAL);
  assert.equal(at?.getTime(), NOON_LOCAL.getTime() + min(2));
});

test('sessionLimitResetAt wraps to next day for a clearly-earlier time', () => {
  // 5am local, now noon → 17h until tomorrow 05:00; +2min.
  const at = sessionLimitResetAt('resets 5am (Europe/Stockholm)', NOON_LOCAL);
  assert.equal(at?.getTime(), NOON_LOCAL.getTime() + min(17 * 60 + 2));
});

test('sessionLimitResetAt returns null without a reset phrase', () => {
  assert.equal(sessionLimitResetAt('claude exited with code 1', NOON_LOCAL), null);
});

test('isSessionLimitError / errText', () => {
  const err = Object.assign(new Error('claude exited with code 1'), {
    recent: "You've hit your session limit · resets 5pm (Europe/Stockholm)\n",
  });
  assert.equal(isSessionLimitError(err), true);
  assert.match(errText(err), /session limit/);
  assert.equal(isSessionLimitError(new Error('some other failure')), false);
});

// The exact sentence the CLI prints when the inherited model's own weekly quota
// is gone. The failure carries it on `recent` (the captured tail of the child's
// output), same as the session-limit case above.
const MODEL_QUOTA_MSG =
  "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const SESSION_LIMIT_MSG = "You've hit your session limit · resets 3pm (Europe/Stockholm)";

const failure = (recent: string): Error =>
  Object.assign(new Error('claude exited with code 1'), { recent });

test('isModelQuotaError recognises the per-model quota message', () => {
  assert.equal(isModelQuotaError(failure(`${MODEL_QUOTA_MSG}\n`)), true);
  for (const family of ['Mythos', 'Opus', 'Sonnet', 'Haiku']) {
    const msg = MODEL_QUOTA_MSG.replace('Fable', family);
    assert.equal(isModelQuotaError(failure(msg)), true, `should match ${family}`);
  }
});

test('isModelQuotaError ignores limits a model switch cannot fix', () => {
  // Session cap: carries a reset time, handled by the recovery scheduler.
  assert.equal(isModelQuotaError(failure(SESSION_LIMIT_MSG)), false);
  // Account-wide caps follow you to every model — a fallback would just burn a
  // second run.
  assert.equal(isModelQuotaError(failure("You've reached your weekly usage limit")), false);
  assert.equal(isModelQuotaError(failure("You're out of usage credits.")), false);
  // Transient overload: the retry ladder's job.
  assert.equal(isModelQuotaError(failure('API Error: 529 Overloaded')), false);
  // An abort is not a failure at all.
  assert.equal(isModelQuotaError(new AbortedError()), false);
});

test('the three failure classifiers stay disjoint on the real messages', () => {
  // This is the confusion that caused the bug: "Fable limit" is neither a
  // "session limit" nor a "Rate limit", so it used to fall through to `failed`.
  const quota = failure(`${MODEL_QUOTA_MSG}\n`);
  assert.equal(isModelQuotaError(quota), true);
  assert.equal(isSessionLimitError(quota), false);
  assert.equal(isTransientApiFailure(quota), false);

  const session = failure(`${SESSION_LIMIT_MSG}\n`);
  assert.equal(isSessionLimitError(session), true);
  assert.equal(isModelQuotaError(session), false);
  assert.equal(isTransientApiFailure(session), false);
});

test('withModel appends --model without mutating the step', () => {
  const args = ['-p', 'prompt', '--strict-mcp-config'];
  const step = { cmd: '/usr/bin/timeout', args, cwd: '/run/dir' };
  const next = withModel(step, 'claude-opus-5');

  assert.deepEqual(next.args, ['-p', 'prompt', '--strict-mcp-config', '--model', 'claude-opus-5']);
  assert.equal(next.cmd, '/usr/bin/timeout');
  assert.equal(next.cwd, '/run/dir');
  // The caller's step is reused across retries — it must come back untouched.
  assert.deepEqual(args, ['-p', 'prompt', '--strict-mcp-config']);
  assert.deepEqual(step.args, ['-p', 'prompt', '--strict-mcp-config']);
});

test('hasModelFlag is the fallback loop guard', () => {
  assert.equal(hasModelFlag({ cmd: 'claude', args: ['-p', 'prompt'] }), false);
  assert.equal(
    hasModelFlag(withModel({ cmd: 'claude', args: ['-p', 'prompt'] }, 'claude-opus-5')),
    true,
  );
});

test('redispatchDelayMs walks the schedule then gives up', () => {
  assert.equal(redispatchDelayMs(0), 5 * 60_000);
  assert.equal(redispatchDelayMs(1), 15 * 60_000);
  assert.equal(redispatchDelayMs(2), 45 * 60_000);
  // Exhausted — the caller must report the failure as terminal rather than
  // re-dispatching forever.
  assert.equal(redispatchDelayMs(REDISPATCH_DELAYS_MS.length), null);
  assert.equal(redispatchDelayMs(99), null);
});

test('redispatchDelayMs delays increase, so a long outage backs off', () => {
  const delays = REDISPATCH_DELAYS_MS;
  for (let i = 1; i < delays.length; i++) {
    assert.ok((delays[i] ?? 0) > (delays[i - 1] ?? 0), `delay ${i} should exceed ${i - 1}`);
  }
});
