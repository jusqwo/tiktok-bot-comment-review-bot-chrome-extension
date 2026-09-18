// Builds TikTok-like pages for the Chrome smoke test. Markup mirrors what was captured from
// tiktok.com on 2026-09-19 (class names, data-e2e attributes, popover Delete control):
//   layout "drawer": standalone /@user/video/ID page, comments in a side drawer, no comment ids,
//                    ⋯ opens a TUXPopover with [data-e2e=comment-delete], then a confirm dialog.
//   layout "browse": video opened from the profile grid, comment ids on each item, a virtualized
//                    list, and a ⋯ button that only responds after the comment is hovered.
// The in-page script imitates TikTok's behaviour: paged loading on scroll (stopping early so the
// scan is partial), "View N replies", and removal after a successful delete.

export function renderFixture({ videoId, layout, creator, viewer, caption, comments, total, pages, subtitleUrl, mediaUrl }) {
  const item = {
    id: videoId,
    desc: caption,
    author: { uniqueId: creator.handle, nickname: creator.name, signature: creator.bio || '' },
    stats: { commentCount: total },
    video: { subtitleInfos: subtitleUrl ? [{ LanguageCodeName: 'eng-US', Url: subtitleUrl, Format: 'webvtt', Source: 'ASR' }] : [], claInfo: { captionInfos: [] }, ...(mediaUrl ? { playAddr: mediaUrl } : {}) },
    textLanguage: 'en',
  };
  const scope = {
    'webapp.app-context': { user: viewer ? { uniqueId: viewer } : undefined },
    ...(layout === 'drawer' ? { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } : { 'webapp.user-detail': {} }),
  };
  const cfg = { layout, creator, caption, comments, total, pages };
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture ${videoId}</title>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: scope }).replace(/</g, '\\u003c')}</script>
<style>
  body { font: 14px sans-serif; margin: 0; }
  .scroll { height: 420px; overflow-y: auto; border: 1px solid #ccc; width: 480px; position: relative; }
  [class*="DivCommentItemWrapper"], [class*="DivCommentContentContainer"] { display: flex; gap: 8px; padding: 6px; min-height: 60px; }
  [class*="DivVirtualItemContainer"] { position: absolute; left: 0; right: 0; }
  [class*="DivReplyContainer"] { margin-left: 40px; }
  [class*="DivMoreTriggerWrapper"] { visibility: hidden; }
  [class*="DivCommentItemWrapper"]:hover [class*="DivMoreTriggerWrapper"] { visibility: visible; }
  .modal { position: fixed; inset: 30% 30%; background: #fff; border: 1px solid #000; padding: 20px; z-index: 10; }
  [data-floating-ui-portal] [role="dialog"] { position: fixed; top: 100px; left: 500px; background: #333; padding: 8px; z-index: 9; }
</style></head><body><div id="app"></div>
<script>window.__CFG__ = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>
<script>(${pageScript.toString()})();</script>
</body></html>`;
}

// Runs inside the fixture page (serialized above).
function pageScript() {
  const C = window.__CFG__;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const PAGE = 10;
  const SLOT = 150;
  let loaded = 0; // top-level comments loaded so far
  let pagesLoaded = 0;
  let total = C.total;
  const deleted = new Set();
  const expanded = new Set();
  const app = document.getElementById('app');
  const top = C.comments.filter((c) => !c.parent);
  const repliesOf = (c) => C.comments.filter((r) => r.parent === c.cid);
  window.__deleted = deleted;

  function countText() {
    return C.layout === 'drawer' ? `${total} comments` : `Comments (${total})`;
  }
  function updateCounts() {
    document.querySelectorAll('.js-count').forEach((e) => (e.textContent = countText()));
    document.querySelectorAll('[data-e2e="comment-count"], [data-e2e="browse-comment-count"]').forEach((e) => (e.textContent = String(total)));
  }

  // ---------- item markup ----------
  function drawerItem(c, level) {
    const label = c.handle === C.creator.handle ? 'Creator' : c.friend ? 'Friend' : '';
    const badge = label ? `<p class="TUXText"><span>· ${label}</span></p>` : '';
    return `<div class="css-116ki3l-7937d88b--DivCommentItemWrapper eb3imn60" data-cid="${c.cid}">
      <div class="css-3qifq2-7937d88b--DivAvatarWrapper eb3imn61"><a href="/@${esc(c.handle)}"><img alt=""></a></div>
      <div class="css-onjzj2-7937d88b--DivCommentContentWrapper eb3imn62">
        <div class="css-ew0sm0-7937d88b--DivCommentHeaderWrapper eb3imn63">
          <div data-e2e="comment-username-${level}" class="css-1e1lvk0-7937d88b--DivUsernameContentWrapper eb3imn64"><div class="css-vbtcmf-7937d88b--DivTriggerWrapper"><a href="/@${esc(c.handle)}"><p class="TUXText">${esc(c.name)}</p></a></div>${badge}</div>
          <div aria-expanded="false" aria-haspopup="dialog" class="css-nzgs1i-7937d88b--DivMore e1wg38u11"><div class="css-1q8tavo-7937d88b--DivMoreTriggerWrapper e1wg38u10"><svg viewBox="0 0 48 48" width="14" height="14"><path d="M5 24a4 4 0 1 1 8 0"/></svg></div></div>
        </div>
        <span data-e2e="comment-level-${level}"><span class="TUXText">${esc(c.text)}</span></span>
        <div class="css-13hiqg9-7937d88b--DivCommentSubContentSplitWrapper"><span>1h ago </span><p role="button" data-e2e="comment-reply-${level}">Reply</p></div>
      </div>
    </div>`;
  }
  function browseItem(c, level) {
    const badge = c.handle === C.creator.handle ? `· <span data-e2e="comment-creator-${level}">Creator</span>` : '';
    return `<div id="${c.cid}" data-comment-ui-enabled="true" class="css-1h1x1ut-7937d88b--DivCommentContentContainer efqxa9p0" data-cid="${c.cid}">
      <a data-e2e="comment-avatar-${level}" href="/@${esc(c.handle)}"><img alt=""></a>
      <div class="css-li7ck6-7937d88b--DivContentContainer efqxa9p1">
        <a href="/@${esc(c.handle)}"><span data-e2e="comment-username-${level}" class="css-1hpzsvm-7937d88b--SpanUserNameText">${esc(c.name)} </span>${badge}</a>
        <p data-e2e="comment-level-${level}" class="css-1kzizld-7937d88b--PCommentText"><span dir="">${esc(c.text)}</span></p>
        <p class="css-5a945k-7937d88b--PCommentSubContent"><span data-e2e="comment-time-${level}">1h ago</span><span aria-label="Reply" role="button" data-e2e="comment-reply-${level}">Reply</span></p>
      </div>
      <div class="css-1powpye-7937d88b--DivActionContainer e1xhukj40">
        <div aria-label="more" role="button" tabindex="0" class="css-1o1b81g-7937d88b--DivMoreContainer e1xhukj41" style="display:none"><div data-e2e="comment-more-icon"><svg width="14" height="14"><circle cx="7" cy="7" r="3"/></svg></div></div>
      </div>
    </div>`;
  }
  function thread(c) {
    const reps = repliesOf(c).filter((r) => !deleted.has(r.cid));
    const shown = expanded.has(c.cid) ? reps : [];
    const itemFn = C.layout === 'drawer' ? drawerItem : browseItem;
    const more = reps.length && !expanded.has(c.cid) ? `<div class="css-9kgp5o-7937d88b--DivViewRepliesContainer" role="button" data-thread="${c.cid}"><span>View ${reps.length} ${reps.length > 1 ? 'replies' : 'reply'}</span></div>` : '';
    const inner = itemFn(c, 1) + (reps.length ? `<div class="css-zn6r1p-7937d88b--DivReplyContainer">${shown.map((r) => itemFn(r, 2)).join('')}${more}</div>` : '');
    return C.layout === 'drawer'
      ? `<div class="css-1mzopna-7937d88b--DivCommentObjectWrapper eb3imn610">${inner}</div>`
      : `<div class="css-gpmghg-7937d88b--DivCommentItemContainer epknno40">${inner}</div>`;
  }

  // ---------- layouts ----------
  const visibleTop = () => top.slice(0, loaded).filter((c) => !deleted.has(c.cid));
  let list, scroller;
  if (C.layout === 'drawer') {
    app.innerHTML = `<div data-e2e="recommend-list-item-container" style="height:300px">
        <div data-e2e="video-desc">${esc(C.caption)}</div>
        <button id="cbtn"><span data-e2e="comment-icon">💬</span><strong data-e2e="comment-count">${total}</strong></button>
      </div>
      <div id="drawer" hidden><div class="css-kccjlw-7937d88b--DivCommentMain-7937d88b--DivCommentMainWithoutScroll ewednpb8 scroll">
        <div class="css-1xxaa0l-7937d88b--DivCommentCountContainer ewednpb7"><span class="js-count">${countText()}</span></div>
        <div class="css-1i2ou4d-7937d88b--DivCommentListContainer e1x3sqeg0" id="list"></div>
      </div></div>`;
    list = document.getElementById('list');
    scroller = list.parentElement;
    document.getElementById('cbtn').addEventListener('click', () => {
      document.getElementById('drawer').hidden = false;
      if (!loaded) loadPage();
    });
  } else {
    app.innerHTML = `<button data-e2e="browse-close">✕</button><div class="css-1ddlbdk-7937d88b--DivCommentListContainer e1pto048 scroll" id="scroller">
        <div data-e2e="browse-video-desc" style="height:60px">${esc(C.caption)}</div>
        <div class="css-1iqer5i-7937d88b--DivTabMenuWrapper"><div class="css-1mltvac-7937d88b--DivTabItem e178qcw42 js-count">${countText()}</div><div class="css-qug611-7937d88b--DivTabItem e178qcw42">Creator videos</div></div>
        <div id="list" style="position:relative"></div>
      </div>`;
    list = document.getElementById('list');
    scroller = document.getElementById('scroller');
    loadPage();
  }

  // Virtual list for "browse": only threads near the viewport are in the DOM (fixed slot height).
  function render() {
    const threads = visibleTop();
    if (C.layout === 'drawer') {
      list.innerHTML = threads.map(thread).join('');
      return;
    }
    list.style.height = threads.length * SLOT + 'px';
    const first = Math.max(0, Math.floor((scroller.scrollTop - 100) / SLOT) - 2);
    const last = Math.min(threads.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / SLOT) + 2);
    list.innerHTML = threads
      .slice(first, last)
      .map((c, i) => `<div class="css-172bpka-7937d88b--DivVirtualItemContainer epknno49" style="top:${(first + i) * SLOT}px">${thread(c)}</div>`)
      .join('');
  }
  function loadPage() {
    if (pagesLoaded >= C.pages || loaded >= top.length) return;
    pagesLoaded++;
    loaded = Math.min(top.length, loaded + PAGE);
    render();
  }
  let loading = false;
  scroller.addEventListener('scroll', () => {
    if (C.layout === 'browse') render();
    if (loading || scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 40) return;
    loading = true;
    setTimeout(() => { loadPage(); loading = false; }, 300);
  });

  // ---------- interactions ----------
  let menuFor = null;
  function closeMenu() {
    document.querySelectorAll('[data-floating-ui-portal]').forEach((e) => e.remove());
    document.querySelectorAll('[aria-haspopup="dialog"][aria-expanded="true"]').forEach((e) => e.setAttribute('aria-expanded', 'false'));
    menuFor = null;
  }
  function openMenu(cid, anchor) {
    closeMenu();
    menuFor = cid;
    anchor.setAttribute?.('aria-expanded', 'true');
    const portal = document.createElement('div');
    portal.setAttribute('data-floating-ui-portal', '');
    portal.innerHTML = `<div class="TUXPopover-popover TUXPopover-popover--open" role="dialog"><div class="TUXPopover-content"><div>
      <button class="TUXButton" type="button" aria-label="Delete" data-e2e="comment-delete"><div class="TUXButton-content"><div class="TUXButton-label">Delete</div></div></button>
    </div></div></div>`;
    document.body.appendChild(portal);
  }
  function removeComment(cid) {
    setTimeout(() => {
      deleted.add(cid);
      total--;
      updateCounts();
      render();
    }, 400);
  }

  // Browse layout: the ⋯ button only appears (and only responds) after hovering the comment.
  document.addEventListener('mouseover', (e) => {
    const cc = e.target.closest?.('[class*="DivCommentContentContainer"]');
    if (!cc) return;
    document.querySelectorAll('[class*="DivMoreContainer"]').forEach((m) => (m.style.display = 'none'));
    const m = cc.querySelector('[class*="DivMoreContainer"]');
    if (m) m.style.display = 'flex';
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const view = t.closest('[data-thread]');
    if (view) {
      expanded.add(view.getAttribute('data-thread'));
      setTimeout(render, 250);
      return;
    }
    const moreB = t.closest('[aria-label="more"][role="button"]');
    if (moreB) {
      if (getComputedStyle(moreB).display === 'none') return; // hidden until hover, like TikTok
      openMenu(moreB.closest('[data-cid]').getAttribute('data-cid'), moreB);
      return;
    }
    const moreD = t.closest('[aria-haspopup="dialog"]');
    if (moreD) {
      if (moreD.getAttribute('aria-expanded') === 'true') return closeMenu();
      openMenu(moreD.closest('[data-cid]').getAttribute('data-cid'), moreD);
      return;
    }
    if (t.closest('[data-e2e="comment-delete"]') && menuFor) {
      const cid = menuFor;
      closeMenu();
      if (C.layout === 'browse') return removeComment(cid);
      const modal = document.createElement('div');
      modal.className = 'css-3o5v8c-7937d88b--DivModalContainer modal';
      modal.setAttribute('role', 'dialog');
      modal.innerHTML = '<p>Are you sure you want to delete this comment?</p><button class="js-cancel">Cancel</button> <button class="js-confirm">Delete</button>';
      document.body.appendChild(modal);
      modal.querySelector('.js-cancel').onclick = () => modal.remove();
      modal.querySelector('.js-confirm').onclick = () => { modal.remove(); removeComment(cid); };
    }
  });
}
