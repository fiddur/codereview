import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { isPullRequestEvent, shouldReview, shouldTryout, verifySignature, type PullRequestEvent } from './webhook.ts';

function makeEvent(overrides: Partial<{
  action: string;
  draft: boolean;
  userType: string;
  merged: boolean;
  baseRef: string;
}> = {}): PullRequestEvent {
  return {
    action: overrides.action ?? 'opened',
    number: 42,
    pull_request: {
      html_url: 'https://github.com/x/y/pull/42',
      title: 'Test',
      body: 'Body',
      draft: overrides.draft ?? false,
      merged: overrides.merged ?? false,
      merge_commit_sha: overrides.merged ? 'mergesha' : null,
      head: { sha: 'abc', ref: 'feature' },
      base: { ref: overrides.baseRef ?? 'develop' },
      user: { login: 'alice', type: overrides.userType ?? 'User' },
    },
    repository: { full_name: 'x/y', clone_url: 'https://github.com/x/y.git' },
  };
}

test('verifySignature accepts valid sha256', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"hello":"world"}');
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifySignature(body, sig, secret), true);
});

test('verifySignature rejects bad sig', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, 'sha256=deadbeef', 'real'), false);
});

test('verifySignature skips when no secret configured', () => {
  assert.equal(verifySignature(Buffer.from(''), undefined, ''), true);
});

test('verifySignature requires header when secret configured', () => {
  assert.equal(verifySignature(Buffer.from(''), undefined, 'set'), false);
});

test('isPullRequestEvent rejects non-objects', () => {
  assert.equal(isPullRequestEvent(null), false);
  assert.equal(isPullRequestEvent('x'), false);
  assert.equal(isPullRequestEvent({}), false);
});

test('isPullRequestEvent accepts a well-formed event', () => {
  assert.equal(isPullRequestEvent(makeEvent()), true);
});

test('shouldReview true for opened by user', () => {
  assert.equal(shouldReview(makeEvent({ action: 'opened' })), true);
});

test('shouldReview true for synchronize', () => {
  assert.equal(shouldReview(makeEvent({ action: 'synchronize' })), true);
});

test('shouldReview false for closed', () => {
  assert.equal(shouldReview(makeEvent({ action: 'closed' })), false);
});

test('shouldReview false for draft on opened', () => {
  assert.equal(shouldReview(makeEvent({ action: 'opened', draft: true })), false);
});

test('shouldReview true for ready_for_review even if draft was true', () => {
  assert.equal(shouldReview(makeEvent({ action: 'ready_for_review', draft: false })), true);
});

test('shouldReview false for bots', () => {
  assert.equal(shouldReview(makeEvent({ userType: 'Bot' })), false);
});

test('shouldTryout true for closed+merged (regardless of base)', () => {
  assert.equal(shouldTryout(makeEvent({ action: 'closed', merged: true })), true);
  assert.equal(shouldTryout(makeEvent({ action: 'closed', merged: true, baseRef: 'main' })), true);
});

test('shouldTryout false for closed without merge', () => {
  assert.equal(shouldTryout(makeEvent({ action: 'closed', merged: false })), false);
});

test('shouldTryout false for opened', () => {
  assert.equal(shouldTryout(makeEvent({ action: 'opened' })), false);
});
