import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { isIssueCommentEvent, isPullRequestEvent, isResumeComment, resumeSkipReason, shouldReview, shouldTryout, type PullRequestEvent, verifySignature } from './webhook.ts';

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

// --- resume comments ---------------------------------------------------------

function makeComment(over: {
  action?: string;
  body?: string;
  userType?: string;
  association?: string;
  isPr?: boolean;
} = {}) {
  const issue: { number: number; pull_request?: { url: string } } = { number: 651 };
  if (over.isPr !== false) issue.pull_request = { url: 'https://api.github.com/pulls/651' };
  return {
    action: over.action ?? 'created',
    issue,
    comment: {
      id: 1,
      body: over.body ?? 'Continue tryout',
      user: { login: 'fiddur', type: over.userType ?? 'User' },
      author_association: over.association ?? 'OWNER',
    },
    repository: { full_name: 'weloveblue/weloveblueai', clone_url: 'https://github.com/weloveblue/weloveblueai.git' },
  };
}

test('isIssueCommentEvent accepts a realistic payload', () => {
  assert.equal(isIssueCommentEvent(makeComment()), true);
});

test('isIssueCommentEvent accepts a plain issue (no pull_request)', () => {
  assert.equal(isIssueCommentEvent(makeComment({ isPr: false })), true);
});

test('isIssueCommentEvent rejects malformed payloads', () => {
  assert.equal(isIssueCommentEvent(null), false);
  assert.equal(isIssueCommentEvent({}), false);
  const noBody = makeComment();
  assert.equal(isIssueCommentEvent({ ...noBody, comment: { ...noBody.comment, body: 42 } }), false);
  assert.equal(isIssueCommentEvent({ ...noBody, issue: { number: 'x' } }), false);
  assert.equal(
    isIssueCommentEvent({ ...noBody, comment: { ...noBody.comment, author_association: null } }),
    false,
  );
});

test('isResumeComment accepts the phrase on a line of its own', () => {
  assert.equal(isResumeComment(makeComment({ body: 'Continue tryout' })), true);
  assert.equal(isResumeComment(makeComment({ body: 'continue TRYOUT' })), true);
  assert.equal(isResumeComment(makeComment({ body: '`Continue tryout`' })), true);
  assert.equal(isResumeComment(makeComment({ body: '**Continue tryout**' })), true);
  assert.equal(isResumeComment(makeComment({ body: '   Continue tryout   ' })), true);
  assert.equal(
    isResumeComment(makeComment({ body: 'Preview redeployed at abc123.\n\nContinue tryout\n' })),
    true,
  );
});

test('isResumeComment ignores the phrase mentioned inside a sentence', () => {
  // This is the sentence the interrupted-review note itself is written in — a
  // substring match would make the instructions fire the trigger.
  const mention = 'To resume, add a comment containing `Continue tryout` on a line by itself.';
  assert.equal(isResumeComment(makeComment({ body: mention })), false);
  assert.equal(resumeSkipReason(makeComment({ body: mention })), 'no resume phrase');
});

test('resumeSkipReason names why a comment is ignored', () => {
  assert.equal(resumeSkipReason(makeComment()), null);
  assert.equal(resumeSkipReason(makeComment({ action: 'edited' })), 'action=edited');
  assert.equal(resumeSkipReason(makeComment({ isPr: false })), 'not a pull request');
  assert.equal(resumeSkipReason(makeComment({ userType: 'Bot' })), 'bot author');
  assert.equal(
    resumeSkipReason(makeComment({ association: 'NONE' })),
    'author_association=NONE',
  );
  assert.equal(
    resumeSkipReason(makeComment({ association: 'CONTRIBUTOR' })),
    'author_association=CONTRIBUTOR',
  );
});

test('isResumeComment accepts the associations that can actually trigger it', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(isResumeComment(makeComment({ association })), true, association);
  }
});
