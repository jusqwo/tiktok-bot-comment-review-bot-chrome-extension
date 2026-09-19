#!/usr/bin/env node
// Bouncer service: the only place TYPESAFE_API_KEY lives. It never leaves this process except in
// the Authorization header to api.typesafe.ai. Run it locally (`npm start`) or on any Node host.
//   HOST=0.0.0.0 PORT=...                 listen publicly when hosted (default 127.0.0.1:8787)
//   ALLOWED_ORIGINS=chrome-extension://<id> only this extension may call it (default: any extension)
//   BOUNCER_MAX_COMMENTS_PER_HOUR=5000    per-IP limit so one user can't drain the Jev budget
//   TRUST_PROXY=1                         use X-Forwarded-For behind a reverse proxy
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, decide } from './judge.mjs';
import { mockJev } from './mock-jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
loadEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || process.env.BOUNCER_PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_PER_HOUR = Number(process.env.BOUNCER_MAX_COMMENTS_PER_HOUR || 5000);
const MOCK = process.env.BOUNCER_MOCK === '1';
const KEY = process.env.TYPESAFE_API_KEY || '';
const MODEL = process.env.JEV_MODEL || 'jev-latest';
const API = process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const BUDGET_USD = Number(process.env.BOUNCER_BUDGET_USD || 4);
const USD_PER_INPUT_TOKEN = 0.042 / 1e6; // jev-1.13: $0.042 per million input tokens, output free
const CONCURRENCY = 6;
const USAGE_FILE = process.env.BOUNCER_USAGE_FILE || join(HERE, 'usage.json');
const CACHE_FILE = process.env.BOUNCER_CACHE_FILE || join(HERE, 'cache.json');
const CACHE_MAX = 20000;

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const redact = (s) => (KEY ? String(s).split(KEY).join('[redacted]') : String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fallback) => {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
};

// ---- spend tracking (a small JSON file, not a database) ----
const usage = readJson(USAGE_FILE, { live_calls: 0, input_tokens: 0, cost_usd: 0, recent: [] });
function recordUsage(u) {
  Object.assign(usage, readJson(USAGE_FILE, usage)); // another process (e.g. npm run record) may have added spend
  usage.live_calls += 1;
  usage.input_tokens += u.input_tokens || 0;
  usage.cost_usd = usage.input_tokens * USD_PER_INPUT_TOKEN;
  usage.recent = [{ at: new Date().toISOString(), input_tokens: u.input_tokens || 0 }, ...usage.recent].slice(0, 50);
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}
const spend = () => (Object.assign(usage, readJson(USAGE_FILE, usage)), {
  mode: MOCK ? 'mock' : 'live',
  model: MOCK ? 'mock-jev' : MODEL,
  live_calls: usage.live_calls,
  input_tokens: usage.input_tokens,
  spent_usd: Number(usage.cost_usd.toFixed(5)),
  budget_usd: BUDGET_USD,
});

// ---- response cache so re-judging the same comment is free and stable ----
const cache = new Map(Object.entries(readJson(CACHE_FILE, {})));
let cacheDirty = false;
function saveCache() {
  if (!cacheDirty) return;
  const entries = [...cache.entries()].slice(-CACHE_MAX);
  writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
  cacheDirty = false;
}

class BudgetError extends Error {}
let reserved = 0; // worst-case cost of calls in flight, so parallel calls cannot overshoot the budget

async function askJev(body) {
  if (MOCK) return mockJev(body);
  if (!KEY) throw new Error('TYPESAFE_API_KEY is missing from .env');
  const payload = JSON.stringify(body);
  const estimate = Buffer.byteLength(payload) * USD_PER_INPUT_TOKEN; // upper bound: never more tokens than bytes
  if (usage.cost_usd + reserved + estimate > BUDGET_USD) {
    throw new BudgetError(`Budget reached: spent $${usage.cost_usd.toFixed(4)} of $${BUDGET_USD}. Raise BOUNCER_BUDGET_USD to continue.`);
  }
  reserved += estimate;
  try {
    return await postToJev(payload);
  } finally {
    reserved -= estimate;
  }
}

async function postToJev(payload) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      if (attempt >= 3) throw new Error(`Jev unreachable: ${e.message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      recordUsage(json.usage || {});
      return json;
    }
    const detail = redact((await res.text()).slice(0, 300));
    if (![429, 500, 502, 503, 504, 529].includes(res.status) || attempt >= 3) {
      throw new Error(`Jev HTTP ${res.status}: ${detail}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
  }
}

async function judgeOne(video, c) {
  if (c.author_is_creator) {
    return { id: c.id, bucket: 'keep', confidence: 1, reasons: ['Your own comment'], cached: false, skipped: true };
  }
  const body = buildRequest(video, c, MODEL);
  const key = createHash('sha256').update((MOCK ? 'mock:' : '') + JSON.stringify(body)).digest('hex');
  let answers = cache.get(key);
  const cached = !!answers;
  if (!answers) {
    const res = await askJev(body);
    answers = res.answers;
    if (!MOCK) {
      cache.set(key, answers);
      cacheDirty = true;
    }
  }
  return { id: c.id, ...decide(answers, c), cached };
}

// Judge a batch with bounded concurrency. A budget stop halts everything; other
// per-comment failures come back as errors so the rest of the batch still completes.
async function classify({ video, comments }) {
  if (!video?.creator?.handle) throw Object.assign(new Error('video.creator.handle is required'), { status: 400 });
  if (!Array.isArray(comments)) throw Object.assign(new Error('comments must be an array'), { status: 400 });
  const results = new Array(comments.length);
  let next = 0;
  let budgetHit = null;
  async function worker() {
    while (next < comments.length && !budgetHit) {
      const i = next++;
      const c = comments[i];
      try {
        results[i] = await judgeOne(video, c);
      } catch (e) {
        if (e instanceof BudgetError) budgetHit = e.message;
        results[i] = { id: c.id, bucket: 'uncertain', confidence: 0, reasons: [`Not judged: ${redact(e.message)}`], error: true };
        console.error(`[bouncer] ${redact(e.message)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, comments.length) }, worker));
  saveCache();
  return { results: results.filter(Boolean), budget_stop: budgetHit, usage: spend() };
}

const extensionOrigin = (o) => !!o && o.startsWith('chrome-extension://') && (!ALLOWED.length || ALLOWED.includes(o));

// Per-IP count of comments judged in the current hour.
const perIp = new Map();
function overLimit(req, n) {
  const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const hour = Math.floor(Date.now() / 3600e3);
  const e = perIp.get(ip);
  const used = e && e.hour === hour ? e.count : 0;
  if (used + n > MAX_PER_HOUR) return true;
  perIp.set(ip, { hour, count: used + n });
  if (perIp.size > 10000) perIp.clear();
  return false;
}

function send(res, status, obj, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (extensionOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'content-type, x-bouncer';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(obj === null ? '' : JSON.stringify(obj));
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  // Only the extension (or local tools like curl, which send no Origin) may use the key.
  if (origin && !extensionOrigin(origin)) return send(res, 403, { error: 'forbidden origin' });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ...spend() }, origin);
  if (req.method === 'POST' && url.pathname === '/classify') {
    if (req.headers['x-bouncer'] !== '1') return send(res, 403, { error: 'missing x-bouncer header' }, origin);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 5e6) return send(res, 413, { error: 'request too large' }, origin);
    }
    try {
      const body = JSON.parse(raw);
      if (overLimit(req, Array.isArray(body.comments) ? body.comments.length : 1)) {
        return send(res, 429, { error: `hourly limit of ${MAX_PER_HOUR} comments reached; try again later` }, origin);
      }
      const out = await classify(body);
      const live = out.results.filter((r) => !r.cached && !r.skipped && !r.error).length;
      console.log(`[bouncer] judged ${out.results.length} comments (${live} live, ${out.results.length - live} cached/skipped) — spent $${out.usage.spent_usd} of $${out.usage.budget_usd}`);
      return send(res, 200, out, origin);
    } catch (e) {
      return send(res, e.status || 500, { error: redact(e.message) }, origin);
    }
  }
  send(res, 404, { error: 'not found' }, origin);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    const s = spend();
    console.log(`[bouncer] listening on http://${HOST}:${PORT} — ${s.mode} mode (${s.model})`);
    if (!MOCK) console.log(`[bouncer] key ${KEY ? 'loaded from .env' : 'MISSING from .env'}; spent $${s.spent_usd} of $${s.budget_usd} budget over ${s.live_calls} live calls`);
  });
}

export { askJev, classify, spend };
