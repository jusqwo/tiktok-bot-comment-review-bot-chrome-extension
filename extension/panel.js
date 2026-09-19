import { SERVICE_URL } from './config.js';
import { annotate, flagScamAccounts } from './lib/patterns.js';
import { transcribe as speechToText } from './lib/transcribe.js';

const params = new URLSearchParams(location.search);
const SVC = params.get('svc') || SERVICE_URL;
const PINNED_TAB = params.get('tab') ? Number(params.get('tab')) : null; // used by tests
const CHUNK = 25;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

const S = {
  tabId: null,
  ctx: null,
  scan: null, // { videoId, running, scanned, visibleTotal, complete, reason, comments }
  results: new Map(), // key -> judgement
  status: new Map(), // key -> 'deleting' | 'deleted' | { error }
  selected: new Set(),
  view: 'scam',
  judgedTranscript: null,
  tx: { videoId: null, text: '', source: '', status: '', busy: false, promise: null }, // transcript for the current video
  busy: false,
  port: null,
};

// ---------------- service ----------------
async function health() {
  const el = $('svc');
  try {
    const h = await (await fetch(`${SVC}/health`)).json();
    el.className = 'svc ok';
    el.textContent = h.mode === 'mock' ? 'Mock Jev (no spend)' : `Jev live · $${h.spent_usd.toFixed(4)} of $${h.budget_usd}`;
    return h;
  } catch {
    el.className = 'svc bad';
    el.innerHTML = /127\.0\.0\.1|localhost/.test(SVC) ? 'Service offline — run <code>npm start</code>' : 'Bouncer service unreachable — try again shortly';
    return null;
  }
}

// ---------------- tab + content script ----------------
async function currentTab() {
  if (PINNED_TAB) return chrome.tabs.get(PINNED_TAB);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (r?.ok) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}
const isVideoUrl = (u) => /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+/.test(u || '');

async function refreshContext() {
  const tab = await currentTab();
  S.tabId = tab?.id ?? null;
  if (!tab || !isVideoUrl(tab.url)) {
    S.ctx = null;
    render();
    return;
  }
  try {
    await ensureContent(tab.id);
    S.ctx = await chrome.tabs.sendMessage(tab.id, { type: 'context' });
  } catch (e) {
    S.ctx = null;
    banner(`Could not read this page: ${e.message}. Reload the TikTok tab and try again.`, 'error');
  }
  render();
  ensureTranscript();
}

// ---------------- transcript ----------------
// Order of preference: TikTok's own subtitles, then the video's audio transcribed by Chrome's built-in
// speech recognition, then what you type. The box always shows exactly what Jev will get.
function ensureTranscript(force = false) {
  const c = S.ctx;
  if (!c?.videoId || (!force && S.tx.videoId === c.videoId)) return;
  const box = $('transcript');
  if (S.tx.videoId !== c.videoId) {
    box.value = '';
    $('lang').value = [...$('lang').options].some((o) => o.value === c.lang) ? c.lang : 'en';
  }
  const tx = (S.tx = { videoId: c.videoId, text: '', source: '', status: '', busy: false, promise: null, needsClick: false });
  const fill = (text, source, status) => {
    Object.assign(tx, { text, source, status });
    if (!box.value.trim() || force) box.value = text;
    render();
  };
  if (c.transcript && !force) return fill(c.transcript, 'TikTok subtitles', `${c.transcriptStatus} Fix anything wrong below.`);
  if (!c.hasMedia) {
    tx.status = `${c.transcriptStatus} Type what's said below.`;
    return render();
  }
  tx.busy = true;
  tx.status = `${c.transcript ? '' : c.transcriptStatus + ' '}Transcribing the audio with Chrome's speech recognition…`;
  render();
  tx.promise = (async () => {
    try {
      const a = await chrome.tabs.sendMessage(S.tabId, { type: 'audio' });
      if (!a?.ok) throw new Error(a?.message || 'could not read the audio');
      const bytes = Uint8Array.from(atob(a.wavBase64), (ch) => ch.charCodeAt(0));
      const out = await speechToText(bytes, $('lang').value, (done, total) => {
        if (S.tx === tx) (tx.status = `Transcribing the audio with Chrome's speech recognition… ${done}/${total}`), render();
      });
      if (S.tx !== tx) return;
      if (out.text) fill(out.text, "Chrome speech recognition of the video's audio", `Transcribed the audio with Chrome's speech recognition (${Math.round(out.seconds)} s, ${out.locale}). Fix anything wrong below.`);
      else tx.status = "No speech found in the audio. Type what's said below, if anything.";
    } catch (e) {
      if (S.tx !== tx) return;
      tx.needsClick = !!e.needsGesture;
      tx.status = e.needsGesture ? 'Click "Transcribe the audio" to let Chrome play it to its speech recognizer.' : `Couldn't transcribe the audio (${e.message}). Type what's said below.`;
    } finally {
      tx.busy = false;
      render();
    }
  })();
}

// ---------------- scan ----------------
function startScan() {
  if (!S.ctx || S.busy) return;
  const videoId = S.ctx.videoId;
  S.results.clear();
  S.status.clear();
  S.selected.clear();
  S.scan = { videoId, running: true, scanned: 0, visibleTotal: S.ctx.visibleTotal, complete: false, reason: '', comments: [] };
  banner('');
  S.busy = true;
  render();
  const port = chrome.tabs.connect(S.tabId, { name: 'bouncer-scan' });
  S.port = port;
  port.onMessage.addListener(async (m) => {
    if (m.type === 'progress') {
      Object.assign(S.scan, { scanned: m.scanned, visibleTotal: m.visibleTotal ?? S.scan.visibleTotal });
      render();
    } else if (m.type === 'done') {
      Object.assign(S.scan, { running: false, scanned: m.scanned, visibleTotal: m.visibleTotal ?? S.scan.visibleTotal, complete: m.complete, reason: m.reason, comments: m.comments });
      port.disconnect();
      S.port = null;
      await judge();
    } else if (m.type === 'error') {
      S.scan.running = false;
      S.busy = false;
      banner(m.error, 'error');
      render();
    }
  });
  port.onDisconnect.addListener(() => {
    if (S.scan?.running) {
      S.scan.running = false;
      S.busy = false;
      banner('Lost connection to the TikTok tab (was it reloaded?). Scan again.', 'error');
      render();
    }
  });
  port.postMessage({ type: 'start', replies: $('replies').checked });
}

// ---------------- judge ----------------
function payloadFor(comments) {
  const byThread = new Map();
  for (const c of comments) {
    if (!c.parent) continue;
    const k = c.parent.author_handle + '|' + c.parent.text;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push({ author_handle: c.author_handle, text: c.text });
  }
  return comments.map((c) => ({
    id: c.key,
    author_name: c.author_name,
    author_handle: c.author_handle,
    text: c.text,
    parent: c.parent ? { author_name: c.parent.author_name, author_handle: c.parent.author_handle, text: c.parent.text } : null,
    replies: byThread.get(c.author_handle + '|' + c.text) || [],
    facts: c.facts,
    patterns: c.patterns,
    author_is_creator: c.author_is_creator || c.badge === 'creator',
  }));
}

async function judge() {
  const comments = S.scan?.comments || [];
  S.busy = true;
  if (!comments.length) {
    S.busy = false;
    render();
    return;
  }
  const ctx = S.ctx;
  annotate(comments, { handle: ctx.creator.handle, name: ctx.creator.name });
  const el = $('judging');
  el.hidden = false;
  if (S.tx.busy && S.tx.promise) {
    el.textContent = 'Waiting for the transcript…';
    await S.tx.promise;
  }
  const transcript = $('transcript').value.trim();
  const video = {
    creator: ctx.creator,
    caption: ctx.caption || '',
    transcript,
    transcript_source: !transcript ? '' : transcript === S.tx.text.trim() ? S.tx.source : 'typed by the creator',
  };
  S.judgedTranscript = transcript;
  const items = payloadFor(comments);
  for (let i = 0; i < items.length; i += CHUNK) {
    el.textContent = `Jev is judging… ${i} of ${items.length}`;
    let out;
    try {
      const r = await fetch(`${SVC}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bouncer': '1' },
        body: JSON.stringify({ video, comments: items.slice(i, i + CHUNK) }),
      });
      out = await r.json();
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    } catch (e) {
      banner(`Judging stopped: ${e.message}. Is the service running (npm start)?`, 'error');
      break;
    }
    for (const r of out.results) S.results.set(r.id, r);
    render();
    if (out.budget_stop) {
      banner(out.budget_stop, 'error');
      break;
    }
  }
  flagScamAccounts(comments, S.results);
  el.textContent = `Judged ${S.results.size} of ${items.length} comments.`;
  S.busy = false;
  await health();
  render();
}

// ---------------- delete ----------------
function commentByKey(key) {
  return S.scan?.comments.find((c) => c.key === key);
}

async function deleteKeys(keys) {
  if (S.busy) return;
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  if (!tab || !tab.url.includes(`/video/${S.scan.videoId}`)) {
    banner('This tab no longer shows the scanned video. Nothing was deleted — rescan first.', 'error');
    return;
  }
  S.busy = true;
  let done = 0;
  for (const key of keys) {
    const c = commentByKey(key);
    if (!c || S.status.get(key) === 'deleted') continue;
    S.status.set(key, 'deleting');
    render();
    let res;
    try {
      res = await chrome.tabs.sendMessage(S.tabId, {
        type: 'delete',
        videoId: S.scan.videoId,
        target: { id: c.id, author_handle: c.author_handle, text: c.text, level: c.level, parent: c.parent },
      });
    } catch (e) {
      res = { ok: false, message: e.message };
    }
    if (res?.ok) {
      S.status.set(key, 'deleted');
      S.selected.delete(key);
      done++;
    } else {
      S.status.set(key, { error: res?.message || 'Unknown error' });
      const left = keys.length - keys.indexOf(key) - 1;
      banner(`Stopped: ${res?.message || 'unknown error'}${left ? ` ${left} remaining comment(s) were not touched.` : ''}`, 'error');
      break;
    }
    render();
  }
  S.busy = false;
  if (done && !$('banner').classList.contains('error')) banner(`Deleted ${done} comment${done > 1 ? 's' : ''} and verified ${done > 1 ? 'they are' : 'it is'} gone.`, 'ok');
  render();
}

function askConfirm(keys) {
  const box = $('confirm');
  const n = keys.length;
  box.hidden = false;
  box.innerHTML = `<span>Delete <b>${n}</b> comment${n > 1 ? 's' : ''} from TikTok? This can't be undone.</span><span class="spacer"></span><button id="cancelDel">Cancel</button><button id="okDel" class="danger">Delete ${n}</button>`;
  $('cancelDel').onclick = () => (box.hidden = true);
  $('okDel').onclick = () => {
    box.hidden = true;
    deleteKeys(keys);
  };
}

// ---------------- render ----------------
function banner(msg, kind = '') {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg;
  b.className = `banner ${kind}`;
}

function renderVideo() {
  const v = $('video');
  const c = S.ctx;
  if (!c) {
    v.innerHTML = '<div class="muted">Open one of your TikTok videos (tiktok.com/@you/video/…) to start.</div>';
    return;
  }
  const owner = c.isOwner === true
    ? '<span class="pill ok">your video</span>'
    : c.isOwner === false
      ? `<span class="pill warn">not your video — logged in as @${esc(c.viewerHandle)}</span>`
      : '<span class="pill warn">not logged in?</span>';
  const modal = c.layout === 'modal'
    ? `<div class="popup-note">Opened from a profile grid. Bouncer can scan here, but TikTok ignores its Delete clicks in this pop-up. <button id="openPage" class="link">Open video page</button></div>`
    : '';
  v.innerHTML = `
    <div class="video-title">${esc(c.creator.name || '@' + c.creator.handle)} <span class="muted">@${esc(c.creator.handle)}</span> ${owner}</div>
    <div class="caption">${c.caption ? esc(c.caption) : '<span class="muted">No caption</span>'}</div>${modal}`;
  const btn = $('openPage');
  if (btn) btn.onclick = () => chrome.tabs.update(S.tabId, { url: `https://www.tiktok.com/@${encodeURIComponent(c.creator.handle)}/video/${c.videoId}` });
  $('transcriptStatus').textContent = S.tx.videoId === c.videoId ? S.tx.status : '';
  $('transcribeBtn').hidden = !(S.tx.videoId === c.videoId && !S.tx.busy && c.hasMedia && S.tx.source !== 'TikTok subtitles' && (S.tx.needsClick || !S.tx.text));
}

function renderCoverage() {
  const box = $('coverage');
  const s = S.scan;
  if (!s) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const total = s.visibleTotal ?? '?';
  const state = s.running ? 'Scanning…' : s.complete ? 'Complete' : 'Partial';
  const cls = s.running ? '' : s.complete ? 'state-complete' : 'state-partial';
  const note = s.running
    ? 'Scrolling the comment list and loading replies… keep the TikTok tab visible.'
    : s.complete
      ? `Scanned every comment TikTok reports for this video.`
      : `Only ${s.scanned} of ${total} scanned — ${s.reason}. Comments TikTok did not load were not checked.`;
  box.innerHTML = `
    <div><b>${s.scanned}</b><span>scanned</span></div>
    <div><b>${total}</b><span>TikTok shows${S.ctx?.visibleTotalApprox ? ' (approx.)' : ''}</span></div>
    <div class="${cls}"><b>${state}</b><span>coverage</span></div>
    <div class="note">${esc(note)}</div>`;
}

function bucketOf(key) {
  return S.results.get(key)?.bucket;
}

function renderList() {
  const has = S.results.size > 0;
  $('tabs').hidden = !has;
  $('bulk').hidden = !has;
  const counts = { scam: 0, uncertain: 0, keep: 0 };
  for (const r of S.results.values()) counts[r.bucket]++;
  for (const k of Object.keys(counts)) $(`n-${k}`).textContent = counts[k];
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === S.view);

  const list = $('list');
  if (!has) {
    list.innerHTML = S.scan && !S.scan.running && !S.busy && !S.scan.comments.length ? '<li class="empty">No comments found.</li>' : '';
    return;
  }
  const rows = (S.scan?.comments || [])
    .filter((c) => bucketOf(c.key) === S.view)
    .map((c) => ({ c, r: S.results.get(c.key) }))
    .sort((a, b) => (S.view === 'keep' ? 0 : (b.r.probabilities?.remove ?? 0) - (a.r.probabilities?.remove ?? 0)));

  const canDelete = S.ctx?.isOwner !== false && S.ctx?.layout !== 'modal' && !S.busy && S.ctx?.videoId === S.scan?.videoId;
  const sel = rows.filter(({ c }) => S.selected.has(c.key) && S.status.get(c.key) !== 'deleted');
  $('deleteSelected').disabled = !canDelete || !sel.length;
  $('deleteSelected').textContent = `Delete selected (${sel.length})`;
  const selectable = rows.filter(({ c }) => S.status.get(c.key) !== 'deleted');
  $('selectAll').checked = selectable.length > 0 && selectable.every(({ c }) => S.selected.has(c.key));

  if (!rows.length) {
    list.innerHTML = `<li class="empty">Nothing in this group.</li>`;
    return;
  }
  list.innerHTML = rows
    .map(({ c, r }) => {
      const st = S.status.get(c.key);
      const deleted = st === 'deleted';
      const conf = r.bucket === 'uncertain'
        ? `scam ${pct(r.probabilities?.remove)} · keep ${pct(r.probabilities?.keep)}`
        : `${pct(r.confidence)} sure`;
      const status = deleted
        ? '<span class="status deleted">Deleted ✓</span>'
        : st === 'deleting'
          ? '<span class="status working">Deleting…</span>'
          : st?.error
            ? `<span class="status failed">Not deleted: ${esc(st.error)}</span>`
            : '';
      return `<li class="item ${r.bucket}${deleted ? ' is-deleted' : ''}" data-key="${esc(c.key)}">
        <input type="checkbox" class="pick" ${S.selected.has(c.key) ? 'checked' : ''} ${deleted ? 'disabled' : ''} aria-label="Select comment">
        <div>
          <div class="who">${esc(c.author_name || c.author_handle)} <span class="handle">@${esc(c.author_handle)}</span></div>
          ${c.parent ? `<div class="replyto">↳ reply to @${esc(c.parent.author_handle)}: “${esc(c.parent.text.slice(0, 80))}”</div>` : ''}
          <div class="text">${esc(c.text)}</div>
          <div class="why"><span class="conf">${conf}</span><span>${esc(r.reasons.join(' · '))}</span></div>
          <div class="actions">${deleted ? '' : `<button class="del" ${canDelete ? '' : 'disabled'}>Delete</button>`}${status}</div>
        </div>
      </li>`;
    })
    .join('');
}

function render() {
  renderVideo();
  renderCoverage();
  renderList();
  $('scan').disabled = !S.ctx || S.busy;
  $('scan').textContent = S.scan && !S.scan.running ? 'Rescan' : 'Scan comments';
  $('stop').hidden = !S.scan?.running;
  const tChanged = S.judgedTranscript !== null && $('transcript').value.trim() !== S.judgedTranscript && S.results.size > 0;
  $('rejudge').hidden = !tChanged || S.busy;
  if (S.scan && S.ctx && S.ctx.videoId !== S.scan.videoId) {
    banner('This tab shows a different video than the one scanned. Deleting is disabled — rescan this video.', 'error');
  }
}

// ---------------- events ----------------
$('scan').onclick = startScan;
$('transcribeBtn').onclick = () => ensureTranscript(true);
$('lang').onchange = () => {
  if (S.tx.source !== 'TikTok subtitles') ensureTranscript(true);
};
$('stop').onclick = () => S.port?.postMessage({ type: 'stop' });
$('rejudge').onclick = () => {
  S.results.clear();
  judge();
};
$('transcript').oninput = () => render();
$('tabs').onclick = (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  S.view = t.dataset.view;
  $('confirm').hidden = true;
  render();
};
$('selectAll').onchange = (e) => {
  for (const c of S.scan?.comments || []) {
    if (bucketOf(c.key) !== S.view || S.status.get(c.key) === 'deleted') continue;
    e.target.checked ? S.selected.add(c.key) : S.selected.delete(c.key);
  }
  render();
};
$('deleteSelected').onclick = () => {
  const keys = (S.scan?.comments || []).filter((c) => bucketOf(c.key) === S.view && S.selected.has(c.key) && S.status.get(c.key) !== 'deleted').map((c) => c.key);
  if (keys.length) askConfirm(keys);
};
$('list').onclick = (e) => {
  const li = e.target.closest('.item');
  if (!li) return;
  const key = li.dataset.key;
  if (e.target.classList.contains('pick')) {
    e.target.checked ? S.selected.add(key) : S.selected.delete(key);
    render();
  } else if (e.target.classList.contains('del')) {
    askConfirm([key]);
  }
};

if (!PINNED_TAB) chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === S.tabId && (info.url || info.status === 'complete')) refreshContext();
});
health();
refreshContext();
