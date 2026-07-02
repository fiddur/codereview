import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChecklistToBody, parseChecklistFromBody } from './release.ts';

const SAMPLE = `# Release

Some preamble.

## Try-it checklist

- [ ] Signed out, visit \`/\` → bounced to \`/beta\`
- [x] \`/beta\` form submits → row appears
- [ ] As an admin: nav drawer shows "Admin · Beta requests"
* [ ] decline a request → declined, no invite

## Notes

- This is just a bullet, not a checkbox.
- Plain text without brackets.

  - [ ] An indented checkbox should also count.
`;

test('parseChecklistFromBody extracts task items in order', () => {
  const items = parseChecklistFromBody(SAMPLE);
  assert.equal(items.length, 5);
  assert.equal(items[0]?.index, 0);
  assert.match(items[0]?.text ?? '', /Signed out, visit/);
  assert.match(items[1]?.text ?? '', /\/beta\` form submits/);
  assert.match(items[2]?.text ?? '', /Admin · Beta requests/);
  assert.match(items[3]?.text ?? '', /decline a request/);
  assert.match(items[4]?.text ?? '', /indented checkbox/);
});

test('applyChecklistToBody toggles only the indexed items', () => {
  const updated = applyChecklistToBody(SAMPLE, [
    { index: 0, checked: true, evidence: '...' },
    { index: 1, checked: false, evidence: '...' },
    { index: 2, checked: true, evidence: '...' },
    { index: 3, checked: false, evidence: '...' },
    { index: 4, checked: true, evidence: '...' },
  ]);
  const after = parseChecklistFromBody(updated);
  assert.equal(after.length, 5);
  assert.ok(updated.includes('- [x] Signed out'));
  assert.ok(updated.includes('- [ ] `/beta`'));
  assert.ok(updated.includes('- [x] As an admin'));
  assert.ok(updated.includes('* [ ] decline'));
  assert.ok(updated.includes('- [x] An indented checkbox'));
});

test('applyChecklistToBody leaves unrelated content alone', () => {
  const updated = applyChecklistToBody(SAMPLE, [
    { index: 0, checked: true, evidence: '...' },
  ]);
  assert.ok(updated.includes('## Try-it checklist'));
  assert.ok(updated.includes('## Notes'));
  assert.ok(updated.includes('This is just a bullet, not a checkbox.'));
});

test('applyChecklistToBody ignores indices it does not know about', () => {
  const updated = applyChecklistToBody(SAMPLE, [
    { index: 99, checked: true, evidence: '...' },
  ]);
  assert.equal(updated, SAMPLE);
});
