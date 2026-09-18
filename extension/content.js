// Bouncer content script: reads the TikTok page (video context + comments) and performs
// verified, one-at-a-time deletions through TikTok's own visible Delete control.
(() => {
  if (globalThis.__bouncer?.alive()) return;
  globalThis.__bouncer = { alive: () => !!chrome.runtime?.id };

  const SEL = {
    text: '[data-e2e^="comment-level-"]',
    username: '[data-e2e^="comment-username-"]',
    // Standalone video page uses DivCommentItemWrapper; the profile "browse" modal uses DivCommentContentContainer.
    root: '[class*="DivCommentContentContainer"], [class*="DivCommentItemWrapper"]',
    thread: '[class*="DivCommentItemContainer"], [class*="DivCommentObjectWrapper"]',
    more: '[aria-label="more"][role="button"], [aria-haspopup="dialog"], [data-e2e="comment-more-icon"]',
    deleteBtn: '[data-e2e="comment-delete"]',
  };
  const REPLY_BTN_RE = /^(view|show)\s+(\d[\d.,]*[km]?\s+)?(more\s+)?(repl(y|ies)|comments?)\b/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const videoIdFromUrl = () => (location.pathname.match(/\/video\/(\d+)/) || [])[1] || null;
  // Video opened as a pop-up over a profile grid. TikTok ignores scripted clicks on ⋯ there.
  const isModal = () => !!document.querySelector('[data-e2e="browse-close"], [data-e2e="browse-video"]');
  const handleFromHref = (href) => {
    const m = (href || '').match(/\/@([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  async function waitFor(fn, timeout = 3000, step = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }
  // TikTok's menus react to a real pointer sequence, not a bare .click().
  function press(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }
  function hover(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, composed: true, view: window, clientX: r.x + 10, clientY: r.y + 10 };
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    }
  }

  // ---------- video context ----------
  function rehydration() {
    try {
      const s = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      return s ? JSON.parse(s.textContent).__DEFAULT_SCOPE__ || {} : {};
    } catch {
      return {};
    }
  }
  function parseCount(s) {
    const m = clean(s).match(/(\d[\d.,]*)\s*([KkMm])?/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return { n: Math.round(n), approx: !!m[2] };
  }
  // In the standalone feed layout several videos are rendered; use the one most in view.
  function activeFeedItem() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('[data-e2e="recommend-list-item-container"]')) {
      const r = el.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (h > bestArea) (bestArea = h), (best = el);
    }
    return best;
  }
  function visibleTotal() {
    const found = [];
    for (const el of document.querySelectorAll('[class*="DivTabItem"]')) {
      const m = clean(el.textContent).match(/^Comments\s*\(([^)]+)\)/i);
      if (m) found.push({ ...parseCount(m[1]), src: 'comments tab' });
    }
    const header = document.querySelector('[class*="DivCommentCountContainer"]');
    if (header && /comment/i.test(header.textContent)) found.push({ ...parseCount(header.textContent), src: 'comments header' });
    const icon = document.querySelector('[data-e2e="browse-comment-count"]') || activeFeedItem()?.querySelector('[data-e2e="comment-count"]');
    if (icon) found.push({ ...parseCount(icon.textContent), src: 'comment icon' });
    const valid = found.filter((f) => Number.isFinite(f.n));
    if (!valid.length) return null;
    // Report the largest number TikTok shows so coverage is never overstated.
    return valid.sort((a, b) => b.n - a.n)[0];
  }

  function pickSubtitle(item) {
    const v = item?.video || {};
    const list = [
      ...(v.subtitleInfos || []).map((s) => ({ url: s.Url || s.url, lang: s.LanguageCodeName || s.language || '', format: s.Format || s.format || '' })),
      ...((v.claInfo && v.claInfo.captionInfos) || []).map((s) => ({ url: s.url || (s.urlList || [])[0], lang: s.language || s.languageCode || '', format: s.captionFormat || '' })),
    ].filter((s) => s.url);
    return list.find((s) => /^en/i.test(s.lang)) || list[0] || null;
  }
  function vttToText(vtt) {
    const out = [];
    for (const line of vtt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || /^WEBVTT/.test(t) || /^\d+$/.test(t) || t.includes('-->') || /^(NOTE|STYLE|REGION|Kind:|Language:)/.test(t)) continue;
      const txt = clean(t.replace(/<[^>]+>/g, ''));
      if (txt && out[out.length - 1] !== txt) out.push(txt);
    }
    return out.join(' ');
  }
  async function fetchText(url) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (r.ok) return await r.text();
    } catch {}
    // Fall back to the extension background (host permissions avoid page CORS).
    const res = await chrome.runtime.sendMessage({ type: 'fetchText', url });
    if (res?.ok) return res.text;
    throw new Error(res?.error || 'fetch failed');
  }

  // TikTok's data for one video (caption, author, subtitles, media URL). The copy embedded in the page is
  // only trusted when it is for the URL's video; otherwise (profile pop-up, in-app navigation) fetch the
  // video's own page, the same request TikTok itself makes when the page is loaded.
  const itemCache = new Map();
  async function loadItem(videoId) {
    const embedded = rehydration()['webapp.video-detail']?.itemInfo?.itemStruct;
    if (embedded?.id === videoId) return embedded;
    if (itemCache.has(videoId)) return itemCache.get(videoId);
    try {
      const handle = handleFromHref(location.pathname) || 'user';
      const html = await (await fetch(`/@${encodeURIComponent(handle)}/video/${videoId}`, { credentials: 'include' })).text();
      const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
      const item = m && JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (item?.id === videoId) {
        itemCache.set(videoId, item);
        return item;
      }
    } catch {}
    return null;
  }

  // Download the video and turn its sound into 16 kHz mono WAV (small, and all the transcriber needs).
  async function audioWav(videoId) {
    const item = await loadItem(videoId);
    const url = item?.video?.playAddr || item?.video?.downloadAddr;
    if (!url) throw new Error("TikTok didn't provide this video's media");
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`video download failed (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const audio = await ctx.decodeAudioData(bytes); // resampled to 16 kHz
    const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    const n = audio.length;
    const wav = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, t) => [...t].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); wav.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
    wav.setUint32(24, 16000, true); wav.setUint32(28, 32000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
    str(36, 'data'); wav.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const c of chans) v += c[i];
      v = Math.max(-1, Math.min(1, v / chans.length));
      wav.setInt16(44 + i * 2, v * 0x7fff, true);
    }
    const u8 = new Uint8Array(wav.buffer);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { ok: true, wavBase64: btoa(bin), seconds: audio.duration };
  }

  async function getContext() {
    const videoId = videoIdFromUrl();
    const d = rehydration();
    const fresh = videoId ? await loadItem(videoId) : null;
    const viewer = d['webapp.app-context']?.user?.uniqueId || null;
    const creatorHandle = handleFromHref(location.pathname) || fresh?.author?.uniqueId?.toLowerCase() || '';

    let caption = fresh?.desc || '';
    if (!caption) {
      const el = document.querySelector('[data-e2e="browse-video-desc"]') || activeFeedItem()?.querySelector('[data-e2e="video-desc"]');
      caption = clean(el?.innerText);
    }
    let name = fresh?.author?.nickname || '';
    if (!name) name = clean(document.querySelector('[data-e2e="browse-username"]')?.innerText);

    let transcript = '';
    let transcriptStatus = 'TikTok has no subtitles for this video.';
    const sub = pickSubtitle(fresh);
    if (sub) {
      try {
        transcript = vttToText(await fetchText(sub.url)).slice(0, 20000);
        transcriptStatus = transcript
          ? `Using TikTok subtitles (${sub.lang || 'unknown language'}, ${transcript.length} characters).`
          : "TikTok's subtitles for this video are empty.";
      } catch (e) {
        transcriptStatus = `TikTok has subtitles but they could not be loaded (${e.message}).`;
      }
    } else if (!fresh && videoId) {
      transcriptStatus = "Couldn't load this video's details from TikTok.";
    }

    const total = visibleTotal();
    const rehydratedTotal = fresh?.stats?.commentCount;
    return {
      videoId,
      url: location.href.split('?')[0],
      creator: { handle: creatorHandle, name, bio: fresh?.author?.signature || '' },
      caption,
      transcript,
      transcriptStatus,
      visibleTotal: total ? total.n : Number.isFinite(rehydratedTotal) ? rehydratedTotal : null,
      visibleTotalApprox: total ? total.approx : false,
      viewerHandle: viewer ? viewer.toLowerCase() : null,
      isOwner: viewer ? viewer.toLowerCase() === creatorHandle : null,
      layout: isModal() ? 'modal' : 'page',
      hasMedia: !!(fresh?.video?.playAddr || fresh?.video?.downloadAddr),
      lang: fresh?.textLanguage && fresh.textLanguage !== 'un' ? fresh.textLanguage : '',
      commentsOpen: !!document.querySelector(SEL.text),
    };
  }

  // ---------- comment parsing ----------
  function rootOf(textEl) {
    const r = textEl.closest(SEL.root);
    if (r) return r;
    // Fallback: highest ancestor that still contains only this one comment text.
    let el = textEl;
    for (let i = 0; i < 8 && el.parentElement && el.parentElement.querySelectorAll(SEL.text).length === 1; i++) el = el.parentElement;
    return el;
  }
  // TikTok puts labels like "· Creator" / "· Friend" next to (sometimes inside) the name element.
  const LABEL_RE = /\s*·\s*(Creator|Author|Friend|Following|Follows you|Pinned|Liked by creator)\b.*$/i;
  function readOne(textEl) {
    const level = Number((textEl.getAttribute('data-e2e').match(/(\d+)$/) || [0, 1])[1]);
    const root = rootOf(textEl);
    const u = root.querySelector(SEL.username);
    const link = u?.closest('a[href*="/@"]') || u?.querySelector('a[href*="/@"]') || root.querySelector('a[href*="/@"]');
    const header = clean((u?.closest('a') || u)?.textContent);
    const nameEl = u?.querySelector('a[href*="/@"]') || u;
    return {
      root,
      level,
      id: /^\d{6,}$/.test(root.id) ? root.id : null,
      author_handle: handleFromHref(link?.getAttribute('href')),
      author_name: clean(nameEl?.innerText).replace(LABEL_RE, ''),
      badge: root.querySelector('[data-e2e^="comment-creator-"]') || /·\s*Creator\b/.test(header) ? 'creator' : null,
      text: clean(textEl.innerText),
    };
  }
  function parentOf(one) {
    if (one.level < 2) return null;
    const thread = one.root.parentElement?.closest(SEL.thread);
    const pText = thread?.querySelector('[data-e2e="comment-level-1"]');
    if (!pText) return null;
    const p = readOne(pText);
    return { id: p.id, author_handle: p.author_handle, author_name: p.author_name, text: p.text };
  }
  const baseKey = (c) => c.id || [c.author_handle, c.level, c.parent ? c.parent.author_handle + ':' + c.parent.text : '', c.text].join('|');

  // Every comment currently rendered, with a stable key (TikTok's comment id when present).
  function readAll() {
    const seen = new Map();
    const out = [];
    for (const textEl of document.querySelectorAll(SEL.text)) {
      const one = readOne(textEl);
      if (!one.author_handle || !one.text) continue;
      one.parent = parentOf(one);
      const b = baseKey(one);
      const n = (seen.get(b) || 0) + 1;
      seen.set(b, n);
      one.key = n > 1 ? `${b}#${n}` : b;
      out.push(one);
    }
    return out;
  }
  const serial = ({ root, ...c }) => c;

  function scroller() {
    let el = document.querySelector(SEL.text);
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (/(auto|scroll)/.test(oy) && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function ensureCommentsOpen() {
    if (document.querySelector(SEL.text)) return true;
    const tab = [...document.querySelectorAll('[class*="DivTabItem"]')].find((e) => /^Comments/i.test(clean(e.textContent)));
    if (tab) press(tab);
    else {
      const icon = activeFeedItem()?.querySelector('[data-e2e="comment-icon"]') || document.querySelector('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]');
      if (icon) press(icon.closest('button') || icon);
    }
    return !!(await waitFor(() => document.querySelector(SEL.text), 6000));
  }

  // Click "View N replies" / "View more" controls that we have not clicked in their current state.
  function expandReplies(budget) {
    let clicked = 0;
    const list = document.querySelector(SEL.text)?.closest('[class*="CommentListContainer"], [class*="DivCommentMain"]') || document.body;
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
    const targets = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = clean(n.textContent);
      if (!REPLY_BTN_RE.test(t)) continue;
      const el = n.parentElement.closest('[role="button"], button') || n.parentElement;
      if (el.closest(SEL.text)) continue; // never click inside comment text
      if (el.dataset.bouncerClicked === t) continue;
      targets.push([el, t]);
    }
    for (const [el, t] of targets.slice(0, budget)) {
      el.dataset.bouncerClicked = t;
      press(el);
      clicked++;
    }
    return clicked;
  }

  async function scan(port, opts) {
    let stopped = false;
    port.onMessage.addListener((m) => m.type === 'stop' && (stopped = true));
    const videoId = videoIdFromUrl();
    const post = (m) => {
      try { port.postMessage(m); } catch { stopped = true; }
    };
    if (!videoId) return post({ type: 'error', error: 'Open one of your TikTok videos first.' });
    if (!(await ensureCommentsOpen())) {
      const ctx = await getContext();
      return post({ type: 'done', comments: [], scanned: 0, visibleTotal: ctx.visibleTotal, complete: ctx.visibleTotal === 0, reason: ctx.visibleTotal === 0 ? 'no comments' : 'comments did not load (open the comments panel and try again)' });
    }
    const store = new Map();
    let idle = 0;
    let replyBudget = opts.replies ? 400 : 0;
    let reason = 'TikTok stopped loading more comments';
    for (;;) {
      if (videoIdFromUrl() !== videoId) return post({ type: 'error', error: 'The page switched to a different video during the scan. Nothing was changed.' });
      const before = store.size;
      for (const c of readAll()) if (!store.has(c.key)) store.set(c.key, serial(c));
      const total = visibleTotal()?.n ?? null;
      post({ type: 'progress', scanned: store.size, visibleTotal: total });
      if (stopped) { reason = 'stopped by you'; break; }
      if (total !== null && store.size >= total) break;
      if (store.size >= opts.max) { reason = `stopped at the ${opts.max}-comment scan limit`; break; }

      const clicked = replyBudget > 0 ? expandReplies(Math.min(10, replyBudget)) : 0;
      replyBudget -= clicked;
      if (clicked) await sleep(400);
      const sc = scroller();
      // Step through the list instead of jumping to the end: TikTok's list can be virtualized,
      // so comments in the middle only exist in the page while they are near the viewport.
      if (sc && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4) {
        sc.scrollTop += Math.max(80, sc.clientHeight * 0.8);
        await sleep(300);
        idle = 0;
        continue;
      }
      const h0 = sc ? sc.scrollHeight : 0;
      const n0 = document.querySelectorAll(SEL.text).length;
      if (sc) sc.scrollTop = sc.scrollHeight;
      await waitFor(() => (sc && sc.scrollHeight !== h0) || document.querySelectorAll(SEL.text).length !== n0, 2500, 200);
      await sleep(250);
      for (const c of readAll()) if (!store.has(c.key)) store.set(c.key, serial(c));
      idle = store.size === before && !clicked && (!sc || sc.scrollHeight === h0) ? idle + 1 : 0;
      if (idle >= 4) break;
    }
    const total = visibleTotal()?.n ?? null;
    const complete = total !== null && store.size >= total;
    post({ type: 'done', comments: [...store.values()], scanned: store.size, visibleTotal: total, complete, reason: complete ? 'all comments TikTok reports were scanned' : reason });
  }

  // ---------- verified deletion ----------
  function sameComment(c, t) {
    return c.author_handle === t.author_handle && c.text === t.text && c.level === t.level && (!t.id || c.id === t.id) &&
      (c.parent?.text || '') === (t.parent?.text || '') && (c.parent?.author_handle || '') === (t.parent?.author_handle || '');
  }
  const matchesOf = (t) => readAll().filter((c) => sameComment(c, t));

  async function findByScrolling(t) {
    const sc = scroller();
    if (!sc) return matchesOf(t);
    sc.scrollTop = 0;
    await sleep(400);
    for (let i = 0; i < 80; i++) {
      const m = matchesOf(t);
      if (m.length) return m;
      const top = sc.scrollTop;
      sc.scrollTop = top + sc.clientHeight * 0.8;
      await sleep(350);
      if (sc.scrollTop === top) break;
    }
    return matchesOf(t);
  }

  function visibleDeleteControl(except) {
    const byAttr = [...document.querySelectorAll(SEL.deleteBtn)].filter(visible);
    if (byAttr.length) return byAttr[byAttr.length - 1];
    // Fallback: a visible menu entry whose text is exactly "Delete" inside a popover/menu.
    return [...document.querySelectorAll('[role="dialog"] button, [role="menu"] [role="menuitem"], [class*="Popover"] button, [class*="Popover"] li')]
      .filter((e) => e !== except && visible(e) && /^delete$/i.test(clean(e.textContent)))
      .pop() || null;
  }
  function confirmControl(menuBtn) {
    return [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button, [class*="modal"] button')]
      .filter((e) => e !== menuBtn && !e.matches(SEL.deleteBtn) && visible(e) && /^(delete|confirm)$/i.test(clean(e.textContent)))
      .pop() || null;
  }

  async function deleteComment({ videoId, target }) {
    const fail = (code, message) => ({ ok: false, code, message });
    if (videoIdFromUrl() !== videoId) return fail('page_changed', 'This tab now shows a different video. Nothing was deleted.');
    if (isModal()) return fail('use_video_page', 'TikTok ignores scripted clicks in the profile pop-up. Use "Open video page", rescan, then delete. Nothing was deleted.');
    let matches = matchesOf(target);
    if (!matches.length) matches = await findByScrolling(target);
    if (!matches.length) return fail('not_found', 'Could not find this exact comment on the page (it may already be gone). Nothing was deleted.');
    if (matches.length > 1) return fail('ambiguous', `Found ${matches.length} identical comments by @${target.author_handle}; not guessing which one. Delete it manually.`);

    matches[0].root.scrollIntoView({ block: 'center' });
    await sleep(400);
    // Scrolling can re-render a virtualized list, so find the comment again before touching it.
    const fresh = () => {
      const again = matchesOf(target);
      return again.length === 1 ? again[0] : null;
    };
    let m = fresh();
    if (!m) return fail('changed', 'The comment list changed while scrolling to this comment. Nothing was deleted.');
    hover(m.root);
    await sleep(200);
    m = fresh();
    if (!m) return fail('changed', 'The comment list changed while scrolling to this comment. Nothing was deleted.');
    const more = m.root.querySelector(SEL.more);
    if (!more) return fail('no_menu', "TikTok's ⋯ menu for this comment was not found. Nothing was deleted.");
    press(more.closest('[aria-haspopup], [role="button"]') || more);
    let del = await waitFor(() => visibleDeleteControl(), 3000);
    if (!del) {
      const inner = more.querySelector('svg') || more.firstElementChild;
      if (inner) press(inner);
      del = await waitFor(() => visibleDeleteControl(), 2000);
    }
    if (!del) {
      press(more);
      return fail('no_delete', 'TikTok did not offer a Delete option for this comment (only the video owner can delete). Nothing was deleted.');
    }
    // Recheck the exact author and text right before the irreversible click.
    const again = matchesOf(target);
    if (again.length !== 1 || again[0].root !== m.root || videoIdFromUrl() !== videoId) {
      press(more);
      return fail('changed', 'The comment list changed while opening the menu. Nothing was deleted.');
    }
    const totalBefore = visibleTotal()?.n ?? null;
    press(del);
    // Only "no exact match anywhere in the rendered list" counts; a detached node alone could be a re-render.
    const listOpen = () => !!document.querySelector('[class*="CommentListContainer"], [class*="DivCommentMain"], ' + SEL.text);
    const gone = () => matchesOf(target).length === 0 && listOpen();
    const next = await waitFor(() => (gone() ? 'gone' : confirmControl(del)), 4000);
    if (next && next !== 'gone') press(next);
    const ok = await waitFor(gone, 8000, 200);
    await sleep(700);
    if (!ok || !gone()) return fail('not_verified', 'Delete was clicked but the comment is still showing. Check the page before continuing.');
    const totalAfter = visibleTotal()?.n ?? null;
    return { ok: true, visibleTotal: totalAfter, countDropped: totalBefore !== null && totalAfter !== null && totalAfter < totalBefore };
  }

  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'ping') return reply({ ok: true }), false;
    const run = msg.type === 'context' ? getContext() : msg.type === 'delete' ? deleteComment(msg) : msg.type === 'audio' ? audioWav(videoIdFromUrl()) : null;
    if (!run) return false;
    run.then(reply, (e) => reply({ ok: false, code: 'error', message: e.message }));
    return true;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'bouncer-scan') return;
    port.onMessage.addListener((m) => {
      if (m.type === 'start') scan(port, { replies: m.replies !== false, max: m.max || 3000 }).catch((e) => port.postMessage({ type: 'error', error: e.message }));
    });
  });
})();
