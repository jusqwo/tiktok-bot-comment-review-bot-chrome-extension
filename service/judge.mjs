// Everything that decides how a comment is judged lives here: the state sent to Jev,
// the questions asked, and the thresholds that turn Jev's probabilities into a bucket.
// Code owns counting and policy; Jev only answers narrow, literal questions.

export const THRESHOLDS = {
  remove: 0.7, // verdict "remove" probability needed for "likely scam" when a harm signal fires
  removePromoOnly: 0.8, // stricter bar when the only problem is promotion (ambiguous promo stays uncertain)
  signal: 0.8, // a named signal must be at least this strong to justify "likely scam"
  keep: 0.6, // verdict "keep" probability needed for "keep"
  clean: 0.5, // every harm/promo signal must be below this for "keep"
  flood: 3, // same text (or the same @account pushed) this many times on the video = campaign
  heavyAuthor: 5, // an account with this many comments on one video is flooding it
  campaignSignal: 0.6, // a campaign needs only a moderate scam signal
  strongRemove: 0.85, // Jev very sure it should go: a moderate signal is enough
};

// A TikTok is at most 10 minutes (~10k characters of speech), so the transcript limit keeps it whole.
const LIMITS = { caption: 2200, transcript: 12000, bio: 300, text: 1000, parent: 500, reply: 200 };

export const QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions:
      'The creator described in `video.creator` is moderating comments on their own video. Decide what the creator should do with the comment in `comment`.',
    criteria: {
      remove:
        "Scam or spam: the comment impersonates the creator or another person or brand; asks readers to DM or message someone to learn a way to make money, trade, invest or get a 'secret'; asks readers to contact someone outside TikTok (WhatsApp, Telegram, Instagram, email, phone number or a link) for an offer; recommends a third-party 'expert', 'mentor', 'account manager', trader or recovery service; or is self-promotion or generic motivational 'thought leadership' that has nothing to do with this video.",
      review:
        'Unclear: the comment contains some promotion, a link, a mention or a contact request, but it could plausibly come from a genuine viewer (for example a relevant recommendation, a friendly shout-out from another creator, or a question about the topic). A human should decide.',
      keep:
        'A genuine viewer comment: a reaction, question, opinion, joke, compliment, encouragement, criticism or conversation about the video or the creator, including tagging friends with @name to show them the video, asking the creator for help or money, and rude, negative or very short comments.',
    },
  },
  impersonation: {
    type: 'noul',
    instructions:
      "Does the account that wrote `comment` pretend to be the creator in `video.creator`, the creator's team, backup or support account, or another famous person or brand? Judge from `comment.author_display_name`, `comment.author_handle` and `comment.text`.",
    criteria: {
      true: 'The name or text presents the commenter as the creator, their team or backup, or a famous person or brand they are not.',
      false: 'The commenter presents as an ordinary, separate person.',
    },
  },
  dm_to_learn: {
    type: 'noul',
    instructions:
      "Does `comment.text` invite readers to DM, message, text or 'reach out to' the commenter or someone they name, in order to learn a method, get mentorship, make money, trade, invest or receive a 'secret'?",
  },
  off_platform: {
    type: 'noul',
    instructions:
      'Does `comment.text` ask readers to contact someone or go to another app or website outside TikTok, such as WhatsApp, Telegram, Instagram, Snapchat, email, a phone number or a link?',
  },
  third_party_shill: {
    type: 'noul',
    instructions:
      "Does `comment.text` point readers to a specific person, account or service other than the creator in `video.creator` to learn from or get tips, mentorship, trading signals, investment help or account recovery from? Short forms count, for example '@name to learn', '@name best teacher', 'learn from @name', 'ask @name', 'tips @name', '@name for mentorship', or praise of an 'expert', 'mentor', 'account manager', trader or 'recovery' service. Thanking or praising the creator, and tagging a friend to show them the video, do not count.",
  },
  self_promotion: {
    type: 'noul',
    instructions:
      "Does `comment.text` promote the commenter's own account, page, channel, product, service, course or business?",
  },
  generic_thought_leadership: {
    type: 'noul',
    instructions:
      "Is `comment.text` a generic motivational, hustle, mindset or 'thought leadership' statement (a slogan, life lesson or advice) that could be pasted under any video and does not respond to anything specific in this video? Short reactions or compliments such as 'nice' or 'good job' do not count.",
  },
  on_topic: {
    type: 'noul',
    instructions:
      'Does `comment.text` respond to the subject of this video (see `video.caption` and `video.transcript` when present), to the creator, or to the comment it replies to?',
  },
};

const HARM = ['impersonation', 'dm_to_learn', 'third_party_shill', 'off_platform'];
const PROMO = ['self_promotion', 'generic_thought_leadership'];

const SIGNAL_REASONS = {
  impersonation: 'Looks like impersonation of you or someone else',
  dm_to_learn: '"DM me to learn / earn" pitch',
  off_platform: 'Asks people to contact them off TikTok',
  third_party_shill: 'Pushes a third-party "expert" / service',
  self_promotion: 'Self-promotion',
  generic_thought_leadership: 'Generic "thought leadership", not about your video',
};

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + ' …[truncated]' : s);

// Build the Jev state for one comment. Only facts we actually have are included;
// anything missing is listed under `video.not_available` rather than guessed.
export function buildState(video, c) {
  const creator = { handle: at(video.creator?.handle) };
  if (video.creator?.name) creator.display_name = video.creator.name;
  if (video.creator?.bio) creator.bio = cut(video.creator.bio, LIMITS.bio);

  const v = { creator };
  const missing = [];
  if (video.caption) v.caption = cut(video.caption, LIMITS.caption);
  else missing.push('caption');
  const transcript = video.manual_transcript || video.transcript;
  if (transcript) {
    v.transcript = cut(transcript, LIMITS.transcript);
    v.transcript_source = video.manual_transcript ? 'typed in by the creator' : video.transcript_source || 'TikTok subtitles';
  } else missing.push('transcript');
  if (missing.length) v.not_available = missing;

  const comment = {
    author_display_name: c.author_name || '',
    author_handle: at(c.author_handle),
    text: cut(c.text, LIMITS.text),
  };
  if (c.parent) {
    comment.in_reply_to = {
      author_display_name: c.parent.author_name || '',
      author_handle: at(c.parent.author_handle),
      text: cut(c.parent.text, LIMITS.parent),
    };
  }
  if (c.replies?.length) {
    comment.first_replies = c.replies.slice(0, 3).map((r) => ({ author_handle: at(r.author_handle), text: cut(r.text, LIMITS.reply) }));
  }
  const f = c.facts || {};
  if (f.links?.length) comment.links_in_text = f.links;
  if (f.mentions?.length) comment.mentions_in_text = f.mentions;
  if (f.has_phone) comment.contains_phone_number = true;
  if (f.has_email) comment.contains_email = true;
  if (f.author_name_resembles_creator) comment.author_name_resembles_creator = true;

  const state = { video: v, comment };
  const p = c.patterns || {};
  const rp = {};
  if (p.same_text_other_accounts > 0) rp.same_text_posted_by_other_accounts = p.same_text_other_accounts;
  if (p.same_text_by_this_author > 1) rp.same_text_posted_by_this_author = p.same_text_by_this_author;
  if (p.same_mention_in_comments >= 3) rp.comments_mentioning_the_same_account = p.same_mention_in_comments;
  if (p.author_comment_count > 1) rp.comments_by_this_author_on_this_video = p.author_comment_count;
  if (Object.keys(rp).length) state.repeated_patterns = rp;
  return state;
}

export function buildRequest(video, c, model) {
  return { model, state: buildState(video, c), questions: QUESTIONS };
}

// Turn Jev's answers into a bucket, a short reason and a confidence.
export function decide(answers, c) {
  const p = answers.verdict?.probabilities || {};
  const pr = { remove: p.remove ?? 0, review: p.review ?? 0, keep: p.keep ?? 0 };
  const s = {};
  for (const k of [...HARM, ...PROMO, 'on_topic']) s[k] = typeof answers[k]?.noul === 'number' ? answers[k].noul : null;
  if (s.on_topic === null || Object.values(s).some((x) => x === null) || !answers.verdict) {
    return { bucket: 'uncertain', confidence: 0, reasons: ['Jev returned an incomplete answer'], probabilities: pr, signals: s };
  }
  const T = THRESHOLDS;
  const harm = Math.max(...HARM.map((k) => s[k]));
  const promo = Math.max(...PROMO.map((k) => s[k]));
  const offTopic = 1 - s.on_topic;

  // Repetition is counted in code: copies of this exact text on the video, and how busy the author is.
  const pat = c.patterns || {};
  const copies = Math.max(pat.same_text_by_this_author || 1, (pat.same_text_other_accounts || 0) + 1);
  // Many *different* comments only counts when this one is off-topic: an engaged viewer can reply a lot.
  const pushed = pat.same_mention_in_comments || 0; // comments on this video pushing the same @account
  const flooding = copies >= T.flood || pushed >= T.flood || ((pat.author_comment_count || 1) >= T.heavyAuthor && offTopic >= 0.5);

  let bucket;
  if (pr.remove >= T.remove && harm >= T.signal) bucket = 'scam';
  else if (pr.remove >= T.strongRemove && (harm >= T.campaignSignal || (promo >= T.campaignSignal && offTopic >= 0.5))) bucket = 'scam';
  else if (pr.remove >= T.removePromoOnly && promo >= T.signal && offTopic >= 0.5) bucket = 'scam';
  // A scam signal inside a campaign (copy-paste, or many comments pushing one @account), unless Jev is confident it is genuine.
  else if (harm >= T.campaignSignal && flooding && pr.keep < 0.5) bucket = 'scam';
  // Genuine: Jev says keep (or sees no scam at all) and nothing points to a scam. Generic encouragement
  // alone doesn't block keep when Jev is confident; self-promotion and campaigns always do. An on-topic
  // reply Jev rates genuine may name a tool or person (e.g. "try Claude") unless the scam signal is strong.
  else if (
    (pr.keep >= T.keep || pr.remove < 0.3) &&
    harm < (pr.keep >= T.keep && s.on_topic >= 0.6 ? T.signal : T.clean) &&
    s.self_promotion < T.clean &&
    (s.generic_thought_leadership < T.clean || pr.keep >= 0.7) &&
    copies < T.flood &&
    !(pushed >= T.flood && harm >= 0.3)
  )
    bucket = 'keep';
  else bucket = 'uncertain';

  const fired = [...HARM, ...PROMO]
    .filter((k) => s[k] >= 0.5)
    .sort((a, b) => s[b] - s[a])
    .map((k) => `${SIGNAL_REASONS[k]} (${pct(s[k])})`);
  const facts = [];
  if (pat.same_text_by_this_author >= 2) facts.push(`Posted the same comment ${pat.same_text_by_this_author} times`);
  else if ((pat.author_comment_count || 1) >= T.heavyAuthor) facts.push(`${pat.author_comment_count} comments from this account`);
  if (pat.same_text_other_accounts > 0) facts.push(`Same text posted by ${pat.same_text_other_accounts} other account${pat.same_text_other_accounts > 1 ? 's' : ''}`);
  if (pushed >= T.flood && harm >= 0.3) facts.push(`Same @account pushed in ${pushed} comments`);
  if (c.facts?.author_name_resembles_creator) facts.push('Name resembles yours');
  if ((promo >= 0.5 || harm >= 0.5) && offTopic >= 0.5) facts.push('Not about your video');

  let reasons = [...fired.slice(0, 2), ...facts.slice(0, 2)];
  if (bucket === 'keep') reasons = [s.on_topic >= 0.5 ? 'Genuine comment about the video' : 'Genuine comment'];
  if (bucket === 'uncertain' && !reasons.length) {
    reasons = [pr.remove >= 0.5 ? `Jev leans scam (${pct(pr.remove)}) but found no clear scam pattern` : `Jev isn't sure it's genuine (keep ${pct(pr.keep)})`];
  }
  if (bucket === 'uncertain' && fired.length && pr.remove < T.remove) reasons.push('Jev is not sure this is a scam');

  // scam/keep: probability of that verdict. uncertain: Jev's strongest verdict (the panel shows the scam/keep split).
  const confidence = bucket === 'scam' ? pr.remove : bucket === 'keep' ? pr.keep : Math.max(pr.remove, pr.review, pr.keep);
  return { bucket, confidence: round(confidence), reasons, probabilities: roundAll(pr), signals: roundAll(s) };
}

function at(h) {
  if (!h) return '';
  return h.startsWith('@') ? h : '@' + h;
}
const pct = (x) => `${Math.round(x * 100)}%`;
const round = (x) => Math.round(x * 1000) / 1000;
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : round(v)]));
