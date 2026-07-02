import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewFile } from './review.ts';

test('parseReviewFile accepts minimal approved', () => {
  const r = parseReviewFile(JSON.stringify({ verdict: 'approved', summary: 'looks good' }));
  assert.equal(r.verdict, 'approved');
  assert.equal(r.summary, 'looks good');
  assert.equal(r.comments, undefined);
});

test('parseReviewFile accepts changes_required with inline comments', () => {
  const r = parseReviewFile(JSON.stringify({
    verdict: 'changes_required',
    summary: 'see inline',
    comments: [
      { path: 'src/a.ts', line: 10, body: 'oops' },
      { path: 'src/b.ts', line: 20, side: 'LEFT', start_line: 18, start_side: 'LEFT', body: 'multi' },
    ],
  }));
  assert.equal(r.verdict, 'changes_required');
  assert.equal(r.comments?.length, 2);
  assert.equal(r.comments?.[1]?.start_line, 18);
});

test('parseReviewFile rejects bad verdict', () => {
  assert.throws(() => parseReviewFile(JSON.stringify({ verdict: 'lgtm', summary: '' })));
});

test('parseReviewFile rejects non-integer line', () => {
  assert.throws(() => parseReviewFile(JSON.stringify({
    verdict: 'approved', summary: '',
    comments: [{ path: 'a', line: 1.5, body: 'x' }],
  })));
});

test('parseReviewFile rejects bad side', () => {
  assert.throws(() => parseReviewFile(JSON.stringify({
    verdict: 'approved', summary: '',
    comments: [{ path: 'a', line: 1, side: 'TOP', body: 'x' }],
  })));
});

test('parseReviewFile rejects non-object', () => {
  assert.throws(() => parseReviewFile('null'));
  assert.throws(() => parseReviewFile('"hi"'));
});
