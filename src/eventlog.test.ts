import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrEvent } from './eventlog.ts';

test('formatPrEvent renders ts + url + action, drops millis, trailing newline', () => {
  const line = formatPrEvent(
    'https://github.com/fiddur/aurboda/pull/820',
    'updated',
    new Date('2026-07-01T06:49:15.123Z'),
  );
  assert.equal(line, '2026-07-01T06:49:15Z https://github.com/fiddur/aurboda/pull/820 updated\n');
});

test('formatPrEvent carries arbitrary action labels', () => {
  const line = formatPrEvent(
    'https://github.com/fiddur/aurboda/pull/1',
    'review started',
    new Date('2026-07-01T00:00:00.000Z'),
  );
  assert.equal(line, '2026-07-01T00:00:00Z https://github.com/fiddur/aurboda/pull/1 review started\n');
});
