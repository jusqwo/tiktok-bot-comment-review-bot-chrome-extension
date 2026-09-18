// One live Jev pass over the fixtures; answers are saved so tests replay them for free.
// Only re-asks fixtures whose request changed (or all with --force). Spend is recorded
// in service/usage.json through the same budget guard the service uses.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { askJev, spend } from '../service/server.mjs';
import { decide } from '../service/judge.mjs';
import { fixtureRequests } from './fixture-requests.mjs';

const OUT = new URL('./fixtures/jev-recorded.json', import.meta.url);
const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const force = process.argv.includes('--force');
const reqs = fixtureRequests();
const todo = reqs.filter(({ c, hash }) => !c.author_is_creator && (force || rec[c.id]?.hash !== hash));
const before = spend();
console.log(`${todo.length} live calls needed (${reqs.length - todo.length} reused). Spent so far $${before.spent_usd}.`);

let i = 0;
async function worker() {
  while (i < todo.length) {
    const { c, body, hash } = todo[i++];
    const res = await askJev(body);
    rec[c.id] = { hash, model: res.model, input_tokens: res.usage?.input_tokens, answers: res.answers };
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
writeFileSync(OUT, JSON.stringify(rec, null, 1));
const after = spend();
console.log(`Recorded. This run: ${after.live_calls - before.live_calls} calls, ${after.input_tokens - before.input_tokens} input tokens, $${(after.spent_usd - before.spent_usd).toFixed(5)}. Total $${after.spent_usd} of $${after.budget_usd}.\n`);

let ok = 0;
for (const { c } of reqs) {
  const d = c.author_is_creator ? { bucket: 'keep', probabilities: {}, signals: {}, reasons: ['creator'] } : decide(rec[c.id].answers, c);
  const pass = d.bucket === c.expect || (c.allow || []).includes(d.bucket);
  ok += pass;
  const p = d.probabilities;
  const sig = Object.entries(d.signals || {}).filter(([, v]) => v >= 0.5).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${pass ? 'ok  ' : 'MISS'} ${c.id.padEnd(4)} expect=${c.expect.padEnd(9)} got=${d.bucket.padEnd(9)} rm=${p.remove ?? '-'} rv=${p.review ?? '-'} kp=${p.keep ?? '-'} | ${sig} | ${c.text.slice(0, 60)}`);
}
console.log(`\n${ok}/${reqs.length} within expected buckets`);
