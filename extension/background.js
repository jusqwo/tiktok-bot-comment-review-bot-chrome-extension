// Opens the side panel from the toolbar button, and fetches subtitle files for the
// content script when TikTok's CDN does not allow the page to read them directly.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'fetchText') return false;
  const url = String(msg.url || '');
  if (!/^https:\/\/[^/]*(tiktok|tiktokcdn|tiktokv|ttwstatic|byteoversea|ibyteimg)[^/]*\//.test(url)) {
    reply({ ok: false, error: 'blocked non-TikTok URL' });
    return false;
  }
  fetch(url, { credentials: 'omit' })
    .then(async (r) => reply(r.ok ? { ok: true, text: await r.text() } : { ok: false, error: `HTTP ${r.status}` }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});
