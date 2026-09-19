// Facts computed in code (never asked of the model): contact details in the text,
// look-alike names, and comments repeated across accounts. Shared by the panel and tests.

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|me|ly|app|link|bio|site|online|store|shop|xyz|info|live|club|pro|vip|top)(?:\/\S*)?|\b(?:wa\.me|t\.me|bit\.ly|linktr\.ee)\/\S*/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MENTION_RE = /@([\p{L}\p{N}._]{2,30})/gu; // run on text with emails removed ("Tips@Victoria" counts)
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

export function extractFacts(text = '') {
  const t = text.normalize('NFKC');
  const noEmail = t.replace(EMAIL_RE, ' ');
  const links = [...new Set((noEmail.match(URL_RE) || []).map((s) => s.replace(/[),.!?]+$/, '')))];
  const mentions = [...new Set([...noEmail.matchAll(MENTION_RE)].map((m) => '@' + m[1].toLowerCase().replace(/\.+$/, '')))];
  const digits = (t.match(PHONE_RE) || [''])[0].replace(/\D/g, '');
  return { links, mentions, has_phone: digits.length >= 8, has_email: noEmail !== t };
}

// Text key used to spot the same message posted by several accounts.
export function normalizeText(text = '') {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(EMAIL_RE, ' email ')
    .replace(URL_RE, ' url ')
    .replace(MENTION_RE, ' @ ')
    .replace(/\d+/g, '0')
    .replace(/[^\p{L}\p{N}@]+/gu, ' ')
    .trim();
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '$': 's', 'ı': 'i' };
const FILLER = /(official|real|backup|team|support|help|desk|page|fans?|acct|account|mgmt|management|private|vip|tv|the|its|iam|admin|verified|original|2nd|second|new)/g;

function core(name = '') {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[01345$ı7]/g, (ch) => LEET[ch] || ch)
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(FILLER, '');
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// True when a different account's handle or display name looks like the creator's.
export function resemblesCreator(author, creator) {
  const ah = (author.handle || '').replace(/^@/, '').toLowerCase();
  const ch = (creator.handle || '').replace(/^@/, '').toLowerCase();
  if (!ah || !ch || ah === ch) return false;
  const creatorCores = [core(ch), core(creator.name)].filter((x) => x.length >= 4);
  const authorCores = [core(ah), core(author.name)].filter((x) => x.length >= 4);
  for (const c of creatorCores)
    for (const a of authorCores) {
      if (a === c || a.includes(c)) return true;
      if (c.length >= 6 && editDistance(a, c) <= 1) return true;
    }
  return false;
}

// Mentions in the text, lower-cased, without the creator's own handle.
const mentionsOf = (text, creatorHandle) => extractFacts(text).mentions.filter((m) => m !== '@' + creatorHandle);

// Annotate scanned comments in place with facts, repeat patterns and "is the creator".
export function annotate(comments, creator) {
  const ch = (creator.handle || '').replace(/^@/, '').toLowerCase();
  const byText = new Map();
  const byAuthor = new Map();
  const byAuthorText = new Map();
  const byMention = new Map(); // @name -> number of comments on this video that mention it
  for (const c of comments) {
    for (const m of new Set(mentionsOf(c.text, ch))) byMention.set(m, (byMention.get(m) || 0) + 1);
    const h = (c.author_handle || '').replace(/^@/, '').toLowerCase();
    byAuthor.set(h, (byAuthor.get(h) || 0) + 1);
    const key = normalizeText(c.text);
    if (key.replace(/[@\s]/g, '').length >= 2) byAuthorText.set(h + '|' + key, (byAuthorText.get(h + '|' + key) || 0) + 1);
    if (key.replace(/[@\s]/g, '').length >= 15) {
      if (!byText.has(key)) byText.set(key, new Set());
      byText.get(key).add(h);
    }
  }
  for (const c of comments) {
    const h = (c.author_handle || '').replace(/^@/, '').toLowerCase();
    const facts = extractFacts(c.text);
    facts.author_name_resembles_creator = resemblesCreator({ handle: c.author_handle, name: c.author_name }, creator);
    c.facts = facts;
    const authors = byText.get(normalizeText(c.text));
    c.patterns = {
      same_text_other_accounts: authors ? authors.size - (authors.has(h) ? 1 : 0) : 0,
      same_text_by_this_author: byAuthorText.get(h + '|' + normalizeText(c.text)) || 1,
      author_comment_count: byAuthor.get(h) || 1,
      same_mention_in_comments: Math.max(0, ...mentionsOf(c.text, ch).map((m) => byMention.get(m))),
    };
    c.author_is_creator = !!ch && h === ch;
  }
  return comments;
}

// After judging: an account that posted a likely scam on this video doesn't get its other comments
// kept (scammers pad with filler), and its other comments that carry a scam signal become likely scams.
export function flagScamAccounts(comments, results) {
  const scammers = new Set(comments.filter((c) => results.get(c.key)?.bucket === 'scam').map((c) => c.author_handle));
  for (const c of comments) {
    const r = results.get(c.key);
    if (!r || r.bucket === 'scam' || r.skipped || !scammers.has(c.author_handle)) continue;
    const s = r.signals || {};
    const signal = Math.max(s.impersonation || 0, s.dm_to_learn || 0, s.off_platform || 0, s.third_party_shill || 0, s.self_promotion || 0);
    const why = 'This account also posted a likely scam here';
    if (signal >= 0.5) results.set(c.key, { ...r, bucket: 'scam', reasons: [why, ...r.reasons.filter((x) => !x.startsWith('Jev is not sure'))].slice(0, 3) });
    else if (r.bucket === 'keep') results.set(c.key, { ...r, bucket: 'uncertain', reasons: [why] });
  }
  return results;
}
