#!/usr/bin/env node
// Bouncer local service. The only place TYPESAFE_API_KEY is read; it never leaves this process
// except in the Authorization header to api.typesafe.ai. Start with `npm start`.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, decide } from './judge.mjs';
import { mockJev } from './mock-jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
loadEnv(join(ROOT, '.env'));

const PORT = Number(process.env.BOUNCER_PORT || 8787);
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
  usage.live_calls += 1;
  usage.input_tokens += u.input_tokens || 0;
  usage.cost_usd = usage.input_tokens * USD_PER_INPUT_TOKEN;
  usage.recent = [{ at: new Date().toISOString(), input_tokens: u.input_tokens || 0 }, ...usage.recent].slice(0, 50);
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}
const spend = () => ({
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

// ---- on-device transcription (macOS 26+: Apple SpeechAnalyzer via a tiny Swift helper) ----
const TRANSCRIPTS_FILE = process.env.BOUNCER_TRANSCRIPTS_FILE || join(HERE, 'transcripts.json');
const transcripts = readJson(TRANSCRIPTS_FILE, {});
const HELPER_SRC = join(HERE, 'transcribe.swift');
const HELPER_BIN = join(HERE, '.bin', 'transcribe');
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 20e6, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code })) : resolve(stdout),
    ),
  );
let helperReady = null;
function ensureHelper() {
  if (process.platform !== 'darwin') return Promise.reject(Object.assign(new Error('on-device transcription needs macOS 26 or newer'), { status: 501 }));
  const fresh = existsSync(HELPER_BIN) && statSync(HELPER_BIN).mtimeMs >= statSync(HELPER_SRC).mtimeMs;
  if (fresh) return Promise.resolve(HELPER_BIN);
  helperReady ??= (async () => {
    mkdirSync(dirname(HELPER_BIN), { recursive: true });
    console.log('[bouncer] building the on-device transcriber (one time)…');
    await run('swiftc', ['-O', '-parse-as-library', HELPER_SRC, '-o', HELPER_BIN], { timeout: 300000 }).catch((e) => {
      throw Object.assign(new Error(`could not build the transcriber (needs macOS 26 + Xcode command line tools): ${e.message.slice(0, 200)}`), { status: 501 });
    });
    return HELPER_BIN;
  })().finally(() => (helperReady = null));
  return helperReady;
}

async function transcribe(audio, { video, lang }) {
  const key = `${video || createHash('sha256').update(audio).digest('hex').slice(0, 16)}:${lang}`;
  if (transcripts[key]) return { ...transcripts[key], cached: true };
  const bin = await ensureHelper();
  const file = join(tmpdir(), `bouncer-${randomUUID()}.audio`);
  writeFileSync(file, audio);
  try {
    const out = JSON.parse(await run(bin, [file, lang || 'en'], { timeout: 600000 }));
    transcripts[key] = { text: out.text, locale: out.locale, seconds: out.seconds };
    writeFileSync(TRANSCRIPTS_FILE, JSON.stringify(transcripts));
    return { ...transcripts[key], cached: false };
  } catch (e) {
    throw Object.assign(new Error(e.code === 2 ? `the video's language (${lang}) is not supported by on-device transcription` : `transcription failed: ${e.message.slice(0, 200)}`), { status: e.code === 2 ? 422 : 500 });
  } finally {
    rmSync(file, { force: true });
  }
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

function send(res, status, obj, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin?.startsWith('chrome-extension://')) {
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
  if (origin && !origin.startsWith('chrome-extension://')) return send(res, 403, { error: 'forbidden origin' });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ...spend(), transcription: process.platform === 'darwin' }, origin);
  if (req.method === 'POST' && url.pathname === '/transcribe') {
    if (req.headers['x-bouncer'] !== '1') return send(res, 403, { error: 'missing x-bouncer header' }, origin);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 80e6) return send(res, 413, { error: 'audio too large' }, origin);
      chunks.push(chunk);
    }
    try {
      const out = await transcribe(Buffer.concat(chunks), { video: url.searchParams.get('video'), lang: url.searchParams.get('lang') || 'en' });
      console.log(`[bouncer] transcript for video ${url.searchParams.get('video')}: ${out.text.length} chars (${out.locale}, ${Math.round(out.seconds)} s${out.cached ? ', cached' : ''}) — on-device, no cost`);
      return send(res, 200, out, origin);
    } catch (e) {
      return send(res, e.status || 500, { error: e.message }, origin);
    }
  }
  if (req.method === 'POST' && url.pathname === '/classify') {
    if (req.headers['x-bouncer'] !== '1') return send(res, 403, { error: 'missing x-bouncer header' }, origin);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 5e6) return send(res, 413, { error: 'request too large' }, origin);
    }
    try {
      const out = await classify(JSON.parse(raw));
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
  server.listen(PORT, '127.0.0.1', () => {
    const s = spend();
    console.log(`[bouncer] listening on http://127.0.0.1:${PORT} — ${s.mode} mode (${s.model})`);
    if (!MOCK) console.log(`[bouncer] key ${KEY ? 'loaded from .env' : 'MISSING from .env'}; spent $${s.spent_usd} of $${s.budget_usd} budget over ${s.live_calls} live calls`);
  });
}

export { askJev, classify, spend };
