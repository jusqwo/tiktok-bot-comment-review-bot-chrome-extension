import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { annotate, extractFacts, flagScamAccounts, resemblesCreator } from '../extension/lib/patterns.js';
import { buildState, decide } from '../service/judge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------- patterns ----------------
test('extractFacts finds links, mentions, phones and emails', () => {
  const f = extractFacts('WhatsApp +1 (415) 555-0199 or t.me/fastcash, mail me at a.b@gmail.com cc @Kate_Trades');
  assert.ok(f.has_phone);
  assert.ok(f.has_email);
  assert.ok(f.links.some((l) => l.includes('t.me/fastcash')));
  assert.ok(f.mentions.includes('@kate_trades'));
  const g = extractFacts('lol this is so true 😂 2024 was wild');
  assert.deepEqual([g.has_phone, g.has_email, g.links.length, g.mentions.length], [false, false, 0, 0]);
});

test('resemblesCreator catches look-alike accounts but not the creator or strangers', () => {
  const creator = { handle: 'maya.money', name: 'Maya | Money Tips' };
  assert.ok(resemblesCreator({ handle: 'maya.money.official', name: 'Maya | Money Tips' }, creator));
  assert.ok(resemblesCreator({ handle: 'maya_moneytips_backup', name: 'Maya Money Tips' }, creator));
  assert.ok(resemblesCreator({ handle: 'maya.m0ney', name: 'x' }, creator));
  assert.ok(!resemblesCreator({ handle: 'maya.money', name: 'Maya | Money Tips' }, creator));
  assert.ok(!resemblesCreator({ handle: 'sam_k', name: 'Sam' }, creator));
  assert.ok(resemblesCreator({ handle: 'nomi.cooks.official', name: 'Nomi Cooks' }, { handle: 'chefnomi', name: 'Nomi Cooks' }));
  // Very short names are ignored rather than matched everywhere.
  assert.ok(!resemblesCreator({ handle: 'jo_smith', name: 'j' }, { handle: 'jusqwo', name: 'j' }));
});

test('annotate counts copy-pasted text across accounts, ignores short repeats, marks the creator', () => {
  const cs = [
    { author_handle: 'jess.earns', text: "Anyone want to make $300/day from their phone? Text me 'INFO' 📲" },
    { author_handle: 'kayla.earns', text: "anyone want to make $500/day from their phone?? text me 'INFO'" },
    { author_handle: 'a', text: 'lol' },
    { author_handle: 'b', text: 'lol' },
    { author_handle: 'maya.money', text: 'thanks all!' },
  ];
  annotate(cs, { handle: 'maya.money', name: 'Maya' });
  assert.equal(cs[0].patterns.same_text_other_accounts, 1);
  assert.equal(cs[1].patterns.same_text_other_accounts, 1);
  assert.equal(cs[2].patterns.same_text_other_accounts, 0);
  assert.equal(cs[4].author_is_creator, true);
  assert.equal(cs[0].author_is_creator, false);
});

// ---------------- state building: never invent context ----------------
test('buildState lists missing caption/transcript instead of inventing them', () => {
  const s = buildState({ creator: { handle: 'chefnomi', name: 'Nomi Cooks' } }, { author_name: 'Raj', author_handle: 'raj', text: 'hi' });
  assert.deepEqual(s.video.not_available, ['caption', 'transcript']);
  assert.equal(s.video.caption, undefined);
  assert.equal(s.video.transcript, undefined);
  assert.equal(s.repeated_patterns, undefined);
  assert.deepEqual(Object.keys(s.comment).sort(), ['author_display_name', 'author_handle', 'text']);
});

test('buildState prefers the manual transcript and labels its source', () => {
  const s = buildState(
    { creator: { handle: 'x' }, caption: 'cap', transcript: 'auto subs', manual_transcript: 'typed by me' },
    { author_handle: 'y', text: 't', parent: { author_handle: 'z', author_name: 'Z', text: 'parent' }, patterns: { same_text_other_accounts: 2, author_comment_count: 3 } },
  );
  assert.equal(s.video.transcript, 'typed by me');
  assert.equal(s.video.transcript_source, 'typed in by the creator');
  assert.equal(s.video.not_available, undefined);
  assert.equal(s.comment.in_reply_to.text, 'parent');
  assert.deepEqual(s.repeated_patterns, { same_text_posted_by_other_accounts: 2, comments_by_this_author_on_this_video: 3 });
});

// ---------------- decision rules ----------------
const ans = (probs, nouls) => ({
  verdict: { type: 'choice', probabilities: probs },
  ...Object.fromEntries(Object.entries({ impersonation: 0, dm_to_learn: 0, off_platform: 0, third_party_shill: 0, self_promotion: 0, generic_thought_leadership: 0, on_topic: 0.9, ...nouls }).map(([k, v]) => [k, { type: 'noul', noul: v }])),
});

test('decide: promotion that is on-topic stays uncertain even if Jev leans remove', () => {
  const d = decide(ans({ remove: 0.85, review: 0.1, keep: 0.05 }, { self_promotion: 0.95, on_topic: 0.9 }), {});
  assert.equal(d.bucket, 'uncertain');
});

test('decide: likely scam needs both the verdict and a named signal', () => {
  assert.equal(decide(ans({ remove: 0.95, review: 0.04, keep: 0.01 }, { dm_to_learn: 0.97 }), {}).bucket, 'scam');
  assert.equal(decide(ans({ remove: 0.95, review: 0.04, keep: 0.01 }, {}), {}).bucket, 'uncertain');
  assert.equal(decide(ans({ remove: 0.5, review: 0.3, keep: 0.2 }, { dm_to_learn: 0.97 }), {}).bucket, 'uncertain');
});

test('decide: a pitch the same account keeps pasting is a likely scam even when each copy looks borderline', () => {
  const borderline = ans({ remove: 0.45, review: 0.33, keep: 0.22 }, { third_party_shill: 0.88 });
  assert.equal(decide(borderline, { patterns: { same_text_by_this_author: 1, author_comment_count: 1 } }).bucket, 'uncertain');
  const flood = decide(borderline, { patterns: { same_text_by_this_author: 41, author_comment_count: 41 } });
  assert.equal(flood.bucket, 'scam');
  assert.ok(flood.reasons.some((r) => r.includes('Posted the same comment 41 times')), flood.reasons.join(' | '));
  // An account with many different comments counts as flooding when the comment is off-topic…
  const offTopicPitch = ans({ remove: 0.45, review: 0.33, keep: 0.22 }, { third_party_shill: 0.88, on_topic: 0.2 });
  assert.equal(decide(offTopicPitch, { patterns: { same_text_by_this_author: 1, author_comment_count: 86 } }).bucket, 'scam');
  // …but not when it answers the video: an engaged viewer can leave several different replies.
  assert.equal(decide(borderline, { patterns: { same_text_by_this_author: 1, author_comment_count: 5 } }).bucket, 'uncertain');
  // Jev being confident the comment is genuine still wins.
  assert.equal(decide(ans({ remove: 0.1, review: 0.2, keep: 0.7 }, { third_party_shill: 0.85 }), { patterns: { same_text_by_this_author: 5 } }).bucket, 'uncertain');
});

test('decide: a flood without any scam signal is never auto-kept', () => {
  const genuineLooking = ans({ remove: 0.05, review: 0.1, keep: 0.85 }, {});
  assert.equal(decide(genuineLooking, { patterns: { same_text_by_this_author: 1 } }).bucket, 'keep');
  const d = decide(genuineLooking, { patterns: { same_text_by_this_author: 11, author_comment_count: 11 } });
  assert.equal(d.bucket, 'uncertain');
  assert.ok(d.reasons.some((r) => r.includes('11 times')), d.reasons.join(' | '));
});

test('annotate counts how often one author repeats the same text', () => {
  const cs = [
    { author_handle: 'frank', text: 'learn from @Marrion Jaime 🥰' },
    { author_handle: 'frank', text: 'learn from @Marrion Jaime 🥰🥰' },
    { author_handle: 'frank', text: 'Ask @Marrion Jaime' },
    { author_handle: 'amy', text: 'learn from @Marrion Jaime' },
  ];
  annotate(cs, { handle: 'orangie' });
  assert.equal(cs[0].patterns.same_text_by_this_author, 2);
  assert.equal(cs[2].patterns.same_text_by_this_author, 1);
  assert.equal(cs[0].patterns.author_comment_count, 3);
  assert.equal(cs[3].patterns.same_text_by_this_author, 1);
});

test('decide: incomplete answers are never treated as keep or scam', () => {
  const d = decide({ verdict: { probabilities: { remove: 1, review: 0, keep: 0 } } }, {});
  assert.equal(d.bucket, 'uncertain');
});

// ---------------- the local service (real process, fake upstream) ----------------
const FAKE_KEY = 'tsk-test-SECRET-should-never-appear-0123456789';

// tokens: fixed count per call, or 'realistic' (about 4 bytes per token, like real tokenizers).
function startFakeJev({ tokens = 1000, echoAuthOnError = false } = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer(async (req, res) => {
      let body = '';
      for await (const ch of req) body += ch;
      calls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      if (echoAuthOnError) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `bad request for ${req.headers.authorization}` }));
      }
      const q = JSON.parse(body).questions;
      const answers = {};
      for (const [k, v] of Object.entries(q)) {
        answers[k] = v.type === 'choice' ? { type: 'choice', choice: 'keep', probabilities: { remove: 0.02, review: 0.03, keep: 0.95 }, confidence: 0.9 } : { type: 'noul', noul: k === 'on_topic' ? 0.9 : 0.02 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const input_tokens = tokens === 'realistic' ? Math.ceil(Buffer.byteLength(body) / 4) : tokens;
      res.end(JSON.stringify({ model: 'jev-fake', answers, usage: { input_tokens, output_tokens: 10 } }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/v1/systemone` }));
  });
}

async function startService(env) {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['service/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TYPESAFE_API_KEY: FAKE_KEY, BOUNCER_PORT: String(port), BOUNCER_USAGE_FILE: join(dir, 'usage.json'), BOUNCER_CACHE_FILE: join(dir, 'cache.json'), ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${port}`;
  return { child, base, dir, output: () => out, stop: () => child.kill() };
}

const classifyBody = (n = 2) => ({
  video: { creator: { handle: 'maya.money', name: 'Maya' }, caption: 'budget tips' },
  comments: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, author_handle: `user${i}`, author_name: `User ${i}`, text: `great video number ${i}` })).concat([{ id: 'own', author_handle: 'maya.money', text: 'thanks!', author_is_creator: true }]),
});
const post = (base, body, headers = { 'content-type': 'application/json', 'x-bouncer': '1' }) =>
  fetch(`${base}/classify`, { method: 'POST', headers, body: JSON.stringify(body) });

test('service: judges via Jev, skips the creator, caches repeats, tracks spend, hides the key', async () => {
  const fake = await startFakeJev({ tokens: 1000 });
  const svc = await startService({ JEV_URL: fake.url });
  try {
    const r = await (await post(svc.base, classifyBody(2))).json();
    assert.deepEqual(r.results.map((x) => x.bucket), ['keep', 'keep', 'keep']);
    assert.equal(r.results[2].skipped, true);
    assert.equal(fake.calls.length, 2, 'creator comment must not be sent to Jev');
    assert.equal(fake.calls[0].auth, `Bearer ${FAKE_KEY}`);
    assert.equal(r.usage.live_calls, 2);
    assert.equal(r.usage.spent_usd, Number((2000 * 0.042e-6).toFixed(5)));
    const again = await (await post(svc.base, classifyBody(2))).json();
    assert.equal(fake.calls.length, 2, 'repeat judgement should come from cache');
    assert.ok(again.results.slice(0, 2).every((x) => x.cached));
    const usageFile = JSON.parse(readFileSync(join(svc.dir, 'usage.json'), 'utf8'));
    assert.equal(usageFile.live_calls, 2);
    assert.ok(!svc.output().includes(FAKE_KEY));
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  } finally {
    svc.stop();
    fake.srv.close();
  }
});

test('service: rejects web pages and requests without the extension header', async () => {
  const svc = await startService({ BOUNCER_MOCK: '1' });
  try {
    const web = await fetch(`${svc.base}/classify`, { method: 'POST', headers: { origin: 'https://evil.example', 'x-bouncer': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(web.status, 403);
    const noHeader = await post(svc.base, classifyBody(1), { 'content-type': 'application/json' });
    assert.equal(noHeader.status, 403);
    const ext = await fetch(`${svc.base}/health`, { headers: { origin: 'chrome-extension://abc' } });
    assert.equal(ext.status, 200);
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    assert.equal((await ext.json()).mode, 'mock');
  } finally {
    svc.stop();
  }
});

test('service: stops at the budget instead of overspending, even with parallel calls', async () => {
  const fake = await startFakeJev({ tokens: 'realistic' });
  const BUDGET = 0.0006; // room for only a handful of calls
  const svc = await startService({ JEV_URL: fake.url, BOUNCER_BUDGET_USD: String(BUDGET) });
  try {
    const r = await (await post(svc.base, classifyBody(40))).json();
    assert.ok(r.budget_stop && /Budget reached/.test(r.budget_stop), JSON.stringify(r.usage));
    assert.ok(r.usage.spent_usd <= BUDGET, `spent ${r.usage.spent_usd} > budget ${BUDGET}`);
    assert.ok(fake.calls.length > 0 && fake.calls.length < 40, `made ${fake.calls.length} calls`);
    assert.ok(r.results.some((x) => x.error && /Budget/.test(x.reasons[0])));
    const callsBefore = fake.calls.length;
    const r2 = await (await post(svc.base, { ...classifyBody(3), video: { creator: { handle: 'other' }, caption: 'new' } })).json();
    assert.ok(fake.calls.length - callsBefore <= 3);
    assert.ok(r2.usage.spent_usd <= BUDGET, `spent ${r2.usage.spent_usd} > budget ${BUDGET}`);
  } finally {
    svc.stop();
    fake.srv.close();
  }
});

test('service: upstream errors are reported with the key redacted', async () => {
  const fake = await startFakeJev({ echoAuthOnError: true });
  const svc = await startService({ JEV_URL: fake.url });
  try {
    const r = await (await post(svc.base, classifyBody(1))).json();
    assert.ok(r.results[0].error);
    assert.ok(r.results[0].reasons[0].includes('[redacted]'), r.results[0].reasons[0]);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
    assert.ok(!svc.output().includes(FAKE_KEY));
  } finally {
    svc.stop();
    fake.srv.close();
  }
});

test('service (hosted mode): only the allowed extension may call it, and each IP has an hourly cap', async () => {
  const svc = await startService({ BOUNCER_MOCK: '1', ALLOWED_ORIGINS: 'chrome-extension://good', BOUNCER_MAX_COMMENTS_PER_HOUR: '5' });
  try {
    const ok = { 'content-type': 'application/json', 'x-bouncer': '1', origin: 'chrome-extension://good' };
    assert.equal((await post(svc.base, classifyBody(1), { ...ok, origin: 'chrome-extension://other' })).status, 403);
    assert.equal((await post(svc.base, classifyBody(2), ok)).status, 200); // 3 comments incl. the creator's
    const over = await post(svc.base, classifyBody(2), ok); // 3 more -> 6 > 5
    assert.equal(over.status, 429);
    assert.match((await over.json()).error, /hourly limit/);
  } finally {
    svc.stop();
  }
});

test('annotate counts comments pushing the same @account (display-name mentions, "Tips@name" too)', () => {
  const cs = [
    { author_handle: 'a', text: 'Ask @Marrion Jaime' },
    { author_handle: 'a', text: 'Best teacher @Marrion Jaime 🥰' },
    { author_handle: 'b', text: 'Tips@Marrion Jaime' },
    { author_handle: 'c', text: '@orangie nice video' },
    { author_handle: 'd', text: '@EvanH look' },
  ];
  annotate(cs, { handle: 'orangie' });
  assert.deepEqual(cs.map((c) => c.patterns.same_mention_in_comments), [3, 3, 3, 0, 1]);
});

test('flagScamAccounts: filler from a scam account is not kept, and its signalled comments become scams', () => {
  const cs = [
    { key: '1', author_handle: 'spammer' },
    { key: '2', author_handle: 'spammer' },
    { key: '3', author_handle: 'spammer' },
    { key: '4', author_handle: 'fan' },
  ];
  const r = new Map([
    ['1', { bucket: 'scam', reasons: ['DM pitch'], signals: { dm_to_learn: 0.9 } }],
    ['2', { bucket: 'keep', reasons: ['Genuine comment'], signals: { dm_to_learn: 0.1 } }],
    ['3', { bucket: 'uncertain', reasons: ['Jev is not sure this is a scam'], signals: { self_promotion: 0.7 } }],
    ['4', { bucket: 'keep', reasons: ['Genuine comment'], signals: {} }],
  ]);
  flagScamAccounts(cs, r);
  assert.deepEqual(['1', '2', '3', '4'].map((k) => r.get(k).bucket), ['scam', 'uncertain', 'scam', 'keep']);
  assert.match(r.get('2').reasons[0], /also posted a likely scam/);
});

test('Vercel entry points: /api paths, a body already parsed by the host, CORS preflight', async () => {
  // Imitates Vercel's Node runtime: the host reads the JSON body into req.body before calling the function.
  const script = `
    import http from 'node:http';
    const { default: fn } = await import('./api/classify.js');
    const srv = http.createServer(async (req, res) => {
      if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; req.body = JSON.parse(raw); }
      fn(req, res);
    });
    srv.listen(0, '127.0.0.1', () => console.log('PORT=' + srv.address().port));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env, VERCEL: '1', BOUNCER_MOCK: '1' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('PORT='); i++) await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${out.match(/PORT=(\d+)/)[1]}`;
  try {
    const ext = { origin: 'chrome-extension://abc' };
    const pre = await fetch(`${base}/api/classify`, { method: 'OPTIONS', headers: ext });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    assert.equal((await (await fetch(`${base}/api/health`, { headers: ext })).json()).mode, 'mock');
    const r = await fetch(`${base}/api/classify`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json', 'x-bouncer': '1' }, body: JSON.stringify(classifyBody(2)) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).results.length, 3);
  } finally {
    child.kill();
  }
});
