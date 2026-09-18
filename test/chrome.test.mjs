// Chrome smoke test of the real extension against TikTok-like fixture pages (no TikTok, no Jev spend).
// Pages are served on real https://www.tiktok.com URLs via DevTools request interception, so the
// extension's content script injects exactly as it would on TikTok. The panel runs against the
// local service in mock mode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { fixtures } from './fixture-requests.mjs';
import { renderFixture } from './fixtures/tiktok-page.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = join(ROOT, 'extension');
const DRAWER_ID = '7000000000000000001';
const BROWSE_ID = '7000000000000000002';
const SUBS = 'https://www.tiktok.com/__fixture/subs.vtt';
const MEDIA = 'https://www.tiktok.com/__fixture/video.m4a';
const SPOKEN = 'Three budgeting mistakes I made in my twenties. Track your small purchases and build an emergency fund.';
const VTT = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nOkay, three budgeting mistakes I made in my twenties.\n\n2\n00:00:02.000 --> 00:00:04.000\nNumber one, I did not track small purchases.\n';

// Dataset: the finance fixtures (with replies), genuine filler, and a same-author duplicate pair.
function dataset() {
  const fin = fixtures.comments.filter((c) => c.video === 'finance');
  const cs = fin.map((c, i) => ({ cid: String(7100000000000000000n + BigInt(i)), fid: c.id, handle: c.author_handle, name: c.author_name, text: c.text, parentFid: c.parent }));
  for (const c of cs) c.parent = c.parentFid ? cs.find((p) => p.fid === c.parentFid).cid : undefined;
  cs.find((c) => c.handle === 'chloe.w').friend = true;
  for (let i = 0; i < 14; i++) cs.push({ cid: String(7200000000000000000n + BigInt(i)), handle: `fan_${i}`, name: `Fan ${i}`, text: `Tip ${i + 1} is so useful, saving this for payday` });
  cs.push({ cid: '7300000000000000001', handle: 'spam.bot', name: 'Signals', text: 'Follow me for daily crypto signals 🚀 DM me to learn' });
  cs.push({ cid: '7300000000000000002', handle: 'spam.bot', name: 'Signals', text: 'Follow me for daily crypto signals 🚀 DM me to learn' });
  return cs;
}

async function startMockService() {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-chrome-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['service/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, BOUNCER_MOCK: '1', BOUNCER_PORT: String(port), BOUNCER_USAGE_FILE: join(dir, 'u.json'), BOUNCER_CACHE_FILE: join(dir, 'c.json'), BOUNCER_TRANSCRIPTS_FILE: join(dir, 't.json') },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await sleep(100);
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test('extension end to end on TikTok-like pages: scan, judge, delete safely', { timeout: 180000 }, async (t) => {
  const svc = await startMockService();
  const browser = await launch({ headless: process.env.HEADFUL !== '1', extensionDir: EXT });
  t.after(async () => {
    await browser.close();
    svc.stop();
  });
  const comments = dataset();
  // A spoken clip to stand in for the video's sound (macOS text-to-speech).
  const audioFile = join(mkdtempSync(join(tmpdir(), 'bouncer-audio-')), 'video.m4a');
  execFileSync('say', ['-o', audioFile, '--file-format=m4af', SPOKEN]);
  const media = readFileSync(audioFile);
  const creator = { handle: 'maya.money', name: 'Maya | Money Tips', bio: fixtures.videos.finance.creator.bio };
  const caption = fixtures.videos.finance.caption;
  const pages = {
    [DRAWER_ID]: renderFixture({ videoId: DRAWER_ID, layout: 'drawer', creator, viewer: 'maya.money', caption, comments, total: comments.length + 5, pages: 10, subtitleUrl: SUBS }),
    [BROWSE_ID]: renderFixture({ videoId: BROWSE_ID, layout: 'browse', creator, viewer: 'maya.money', caption, comments, total: comments.length, pages: 10 }),
    // The same video loaded as its own page (what "Open video page" leads to).
    [BROWSE_ID + ':page']: renderFixture({ videoId: BROWSE_ID, layout: 'drawer', creator, viewer: 'maya.money', caption, comments, total: comments.length, pages: 10, mediaUrl: MEDIA }),
  };

  // ---- TikTok page tab with interception ----
  const page = await browser.page();
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.tiktok.com/*' }] });
  browser.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== page.sessionId) return;
    const url = m.params.request.url;
    const id = (url.match(/\/video\/(\d+)/) || [])[1];
    let body = '';
    let type = 'text/html';
    let code = 404;
    if (url.startsWith(SUBS)) (body = VTT), (type = 'text/vtt'), (code = 200);
    else if (url.startsWith(MEDIA)) (body = media), (type = 'audio/mp4'), (code = 200);
    else if (id === BROWSE_ID && !url.includes('from=grid')) (body = pages[BROWSE_ID + ':page']), (code = 200);
    else if (id && pages[id]) (body = pages[id]), (code = 200);
    await page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(body).toString('base64') });
  });
  await page.goto(`https://www.tiktok.com/@maya.money/video/${DRAWER_ID}`);

  // ---- extension id + tab id ----
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const sw = (await browser.targets()).find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://') && x.url.endsWith('/background.js'));
    extId = sw && new URL(sw.url).host;
    if (!extId) await sleep(100);
  }
  assert.ok(extId, 'extension service worker not found');
  // Separate window, like the real side panel: the TikTok tab must stay visible or Chrome stops
  // rendering it and TikTok's scroll-triggered loading never fires.
  const panel = await browser.page(`chrome-extension://${extId}/panel.html?svc=${encodeURIComponent(svc.url)}`, { newWindow: true });
  await panel.waitFor('document.readyState === "complete"');
  const tabId = await panel.eval(`chrome.tabs.query({ url: 'https://www.tiktok.com/*' }).then((t) => t[0].id)`);
  const openPanel = async () => {
    await panel.goto(`chrome-extension://${extId}/panel.html?tab=${tabId}&svc=${encodeURIComponent(svc.url)}`);
  };
  const panelText = (sel) => panel.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
  const itemsIn = (view) =>
    panel.eval(`(async () => { document.querySelector('.tab[data-view="${view}"]').click(); await new Promise(r => setTimeout(r, 50));
      return [...document.querySelectorAll('.item')].map(li => ({ key: li.dataset.key, text: li.querySelector('.text').innerText, status: li.querySelector('.status')?.innerText || '', why: li.querySelector('.why').innerText })); })()`);
  const clickDeleteFor = async (view, textPart) =>
    panel.eval(`(async () => { document.querySelector('.tab[data-view="${view}"]').click(); await new Promise(r => setTimeout(r, 50));
      const li = [...document.querySelectorAll('.item')].find(li => li.querySelector('.text').innerText.includes(${JSON.stringify(textPart)}));
      li.querySelector('.del').click(); await new Promise(r => setTimeout(r, 50)); document.getElementById('okDel').click(); return true; })()`);
  const pageDeleted = () => page.eval('[...window.__deleted]');
  // On failure, show what the panel and page looked like.
  const dump = async () => {
    const p = await panel.eval(`({ coverage: document.getElementById('coverage').innerText, judging: document.getElementById('judging').innerText, banner: document.getElementById('banner').innerText, scanBtn: document.getElementById('scan').textContent })`).catch((e) => e.message);
    const g = await page.eval(`({ url: location.href, texts: document.querySelectorAll('[data-e2e^="comment-level-"]').length, drawerHidden: document.getElementById('drawer')?.hidden, viewBtns: [...document.querySelectorAll('[data-thread]')].length })`).catch((e) => e.message);
    console.log('PANEL', JSON.stringify(p), '\nPAGE', JSON.stringify(g), '\nPAGE LOGS', page.logs.slice(-10), '\nPANEL LOGS', panel.logs.slice(-10));
  };
  const until = async (expr, ms) => {
    try { await panel.waitFor(expr, ms); } catch (e) { await dump(); throw e; }
  };

  await t.test('panel reads video context, owner status and TikTok subtitles', async () => {
    await openPanel();
    await until(`document.getElementById('video').innerText.includes('@maya.money')`, 10000);
    const video = await panelText('#video');
    assert.match(video, /your video/);
    assert.match(video, /3 budgeting mistakes/);
    await until(`document.getElementById('transcriptStatus').innerText.includes('subtitles')`, 5000);
    assert.match(await panelText('#transcriptStatus'), /Using TikTok subtitles \(eng-US, \d+ characters\)/);
    assert.match(await panel.eval(`document.getElementById('transcript').value`), /three budgeting mistakes/i);
    assert.match(await panelText('#svc'), /Mock Jev/);
  });

  await t.test('scan loads every page and reply, dedupes, reports partial coverage honestly', async () => {
    await panel.eval(`document.getElementById('scan').click()`);
    await until(`/Judged \\d+ of \\d+/.test(document.getElementById('judging').innerText)`, 60000);
    const cov = await panelText('#coverage');
    const [scanned, shown] = cov.match(/\d+/g).map(Number);
    assert.equal(scanned, comments.length, cov); // every comment incl. replies, duplicate pair counted twice
    assert.equal(shown, comments.length + 5, cov);
    assert.match(cov, /Partial/);
    assert.match(cov, /TikTok stopped loading more comments/);
    assert.match(await panelText('#judging'), new RegExp(`Judged ${comments.length} of ${comments.length}`));
  });

  await t.test('results are split into scam / uncertain / keep with reasons and confidence', async () => {
    const scam = await itemsIn('scam');
    const keep = await itemsIn('keep');
    assert.ok(scam.some((i) => i.text.startsWith('DM me to learn')), 'DM pitch should be flagged');
    assert.ok(scam.some((i) => i.text.includes('WhatsApp +1')), 'recovery scam should be flagged');
    assert.ok(keep.some((i) => i.text.includes('Mistake #2')), 'genuine comment should be kept');
    const names = await panel.eval(`(async () => { const out = []; for (const v of ['scam', 'uncertain', 'keep']) { document.querySelector('.tab[data-view="' + v + '"]').click(); await new Promise(r => setTimeout(r, 50)); out.push(...[...document.querySelectorAll('.who')].map(e => e.firstChild.textContent.trim())); } return out; })()`);
    assert.ok(names.includes('Chloe') && names.includes('Maya | Money Tips'), JSON.stringify(names));
    assert.ok(names.every((n) => !n.includes('·')), 'TikTok labels must not leak into author names: ' + JSON.stringify(names));
    assert.equal(await panel.eval(`getComputedStyle(document.getElementById('confirm')).display`), 'none');
    assert.ok(scam.every((i) => /\d+% sure/.test(i.why) && i.why.length > 12));
    const replyShown = await panel.eval(`(async () => { const out = []; for (const v of ['scam', 'uncertain', 'keep']) { document.querySelector('.tab[data-view="' + v + '"]').click(); await new Promise(r => setTimeout(r, 50)); out.push(...[...document.querySelectorAll('.replyto')].map(e => e.innerText)); } return out.join(' | '); })()`);
    assert.match(replyShown, /reply to @lindacarter221/);
  });

  await t.test('deleting selected comments uses the confirm dialog and verifies each is gone', async () => {
    await panel.eval(`(async () => {
      document.querySelector('.tab[data-view="scam"]').click(); await new Promise(r => setTimeout(r, 50));
      for (const want of ['DM me to learn how', 'WhatsApp +1']) {
        // Each click re-renders the list, so look the row up again every time.
        const li = [...document.querySelectorAll('.item')].find((x) => x.querySelector('.text').innerText.includes(want));
        li.querySelector('.pick').click();
      }
      document.getElementById('deleteSelected').click(); await new Promise(r => setTimeout(r, 50));
      document.getElementById('okDel').click();
    })()`);
    await until(`document.getElementById('banner').innerText.startsWith('Deleted 2')`, 30000);
    const del = await pageDeleted();
    const byText = (s) => comments.find((c) => c.text.includes(s)).cid;
    assert.deepEqual(del.sort(), [byText('DM me to learn how I turned'), byText('WhatsApp +1')].sort());
    const scam = await itemsIn('scam');
    assert.equal(scam.filter((i) => i.status.includes('Deleted')).length, 2);
    assert.match(await page.eval(`document.querySelector('.js-count').innerText`), new RegExp(`${comments.length + 5 - 2} comments`));
  });

  await t.test('an ambiguous match (two identical comments by one author) is refused', async () => {
    await clickDeleteFor('scam', 'Follow me for daily crypto signals');
    await until(`document.getElementById('banner').innerText.includes('identical')`, 20000);
    assert.equal((await pageDeleted()).length, 2, 'nothing else may be deleted');
  });

  await t.test('a changed page stops deletion before anything is clicked', async () => {
    await page.eval(`history.pushState({}, '', '/@maya.money/video/7000000000000000009')`);
    await clickDeleteFor('scam', 'selected for a giveaway');
    await until(`document.getElementById('banner').innerText.includes('no longer shows the scanned video')`, 5000);
    // The content script refuses on its own too.
    const direct = await panel.eval(`chrome.tabs.sendMessage(${tabId}, { type: 'delete', videoId: '${DRAWER_ID}', target: { author_handle: 'maya.money.official', text: 'x', level: 1 } })`);
    assert.equal(direct.code, 'page_changed');
    assert.equal((await pageDeleted()).length, 2);
    await page.eval(`history.pushState({}, '', '/@maya.money/video/${DRAWER_ID}')`);
  });

  await t.test('a comment that is no longer on the page is not guessed at', async () => {
    const res = await panel.eval(`chrome.tabs.sendMessage(${tabId}, { type: 'delete', videoId: '${DRAWER_ID}', target: { author_handle: 'dan_brooks_fx', text: 'DM me to learn how I turned $500 into $8,000 in 3 weeks with forex 📈 no experience needed', level: 1, parent: null } })`);
    assert.equal(res.code, 'not_found');
    assert.equal((await pageDeleted()).length, 2);
  });

  await t.test('profile pop-up layout: scans a virtualized list fully, blocks delete, "Open video page" then delete works', async () => {
    await page.goto(`https://www.tiktok.com/@maya.money/video/${BROWSE_ID}?from=grid`);
    await openPanel();
    await until(`document.getElementById('video').innerText.includes('your video')`, 10000);
    assert.match(await panelText('#video'), /Opened from a profile grid/);
    // No subtitles and no embedded data for this video: Bouncer fetches the video's page data,
    // downloads its sound and transcribes it on this Mac.
    await until(`/transcribed the audio on this Mac|didn't work/.test(document.getElementById('transcriptStatus').innerText)`, 120000);
    assert.match(await panelText('#transcriptStatus'), /transcribed the audio on this Mac \(en_US, \d+ s\)/);
    const heard = await panel.eval(`document.getElementById('transcript').value`);
    assert.match(heard, /budgeting mistakes/i, heard);
    assert.match(heard, /emergency fund/i, heard);
    await panel.eval(`document.getElementById('scan').click()`);
    await until(`/Judged \\d+ of \\d+/.test(document.getElementById('judging').innerText)`, 90000);
    const cov = await panelText('#coverage');
    const [scanned, shown] = cov.match(/\d+/g).map(Number);
    assert.equal(scanned, comments.length, cov); // every comment, although the list only renders a window at a time
    assert.equal(shown, comments.length, cov);
    assert.match(cov, /Complete/);
    assert.equal(await page.eval(`!!document.getElementById('${comments[0].cid}')`), false, 'first comment should be virtualized away');
    const delButtons = await panel.eval(`(async () => { document.querySelector('.tab[data-view="scam"]').click(); await new Promise(r => setTimeout(r, 50)); return [...document.querySelectorAll('.del')].map(b => b.disabled); })()`);
    assert.ok(delButtons.length > 0 && delButtons.every(Boolean), 'delete must be disabled in the pop-up');
    const direct = await panel.eval(`chrome.tabs.sendMessage(${tabId}, { type: 'delete', videoId: '${BROWSE_ID}', target: { author_handle: 'maya.money.official', text: ${JSON.stringify(comments[0].text)}, level: 1, parent: null } })`);
    assert.equal(direct.code, 'use_video_page');
    assert.equal((await pageDeleted()).length, 0);

    await panel.eval(`document.getElementById('openPage').click()`);
    await page.waitFor(`location.search === '' && document.readyState === 'complete' && !!document.querySelector('[data-e2e="recommend-list-item-container"]')`, 15000);
    await until(`document.getElementById('video').innerText.includes('your video') && !document.getElementById('video').innerText.includes('profile grid')`, 10000);
    await panel.eval(`document.getElementById('scan').click()`);
    await until(`/Judged \\d+ of \\d+/.test(document.getElementById('judging').innerText) && !document.getElementById('scan').disabled`, 90000);
    await clickDeleteFor('scam', 'selected for a giveaway');
    await until(`document.getElementById('banner').innerText.startsWith('Deleted 1')`, 30000);
    assert.deepEqual(await pageDeleted(), [comments[0].cid]);
    const unsure = await itemsIn('uncertain');
    assert.ok(unsure.length > 0, 'expected at least one uncertain comment');
    await clickDeleteFor('uncertain', unsure[0].text.slice(0, 30));
    try { await page.waitFor('window.__deleted.size === 2', 30000); } catch (e) {
      await dump();
      throw e;
    }
    const del = await pageDeleted();
    assert.ok(del.includes(comments.find((c) => c.text === unsure[0].text).cid));
  });
});
