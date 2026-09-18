// Replays recorded Jev answers (test/fixtures/jev-recorded.json) through the decision code.
// No API calls: run `npm run record` after changing questions or state to refresh recordings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decide } from '../service/judge.mjs';
import { fixtureRequests } from './fixture-requests.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/jev-recorded.json', import.meta.url), 'utf8'));
const reqs = fixtureRequests();

function bucketFor({ c, hash }) {
  if (c.author_is_creator) return 'keep';
  const r = recorded[c.id];
  assert.ok(r, `no recording for ${c.id}; run npm run record`);
  assert.equal(r.hash, hash, `recording for ${c.id} is stale (questions or state changed); run npm run record`);
  return decide(r.answers, c).bucket;
}

test('recordings exist and match the current questions/state', () => {
  for (const r of reqs) bucketFor(r);
});

test('no genuine comment is flagged as likely scam (false deletions)', () => {
  const bad = reqs.filter((r) => r.c.expect === 'keep' && bucketFor(r) === 'scam').map((r) => r.c.id);
  assert.deepEqual(bad, []);
});

test('no scam lands in keep (missed scams)', () => {
  const bad = reqs.filter((r) => r.c.expect === 'scam' && bucketFor(r) === 'keep').map((r) => r.c.id);
  assert.deepEqual(bad, []);
});

test('ambiguous promotion is never kept blindly or auto-scammed unless allowed', () => {
  for (const r of reqs.filter((x) => x.c.expect === 'uncertain')) {
    const b = bucketFor(r);
    assert.ok(b === 'uncertain' || (r.c.allow || []).includes(b), `${r.c.id} -> ${b}`);
  }
});

test('at least 90% of fixtures land in an expected bucket', () => {
  const ok = reqs.filter((r) => {
    const b = bucketFor(r);
    return b === r.c.expect || (r.c.allow || []).includes(b);
  }).length;
  assert.ok(ok / reqs.length >= 0.9, `${ok}/${reqs.length}`);
});

test('every flagged comment carries a reason and a confidence', () => {
  for (const r of reqs) {
    if (r.c.author_is_creator) continue;
    const d = decide(recorded[r.c.id].answers, r.c);
    assert.ok(d.reasons.length > 0 && d.reasons.every((x) => typeof x === 'string' && x.length < 120), r.c.id);
    assert.ok(d.confidence >= 0 && d.confidence <= 1, r.c.id);
  }
});
