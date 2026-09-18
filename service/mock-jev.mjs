// Offline stand-in for Jev: same response shape, crude keyword heuristics, zero cost.
// Used by BOUNCER_MOCK=1 and the tests so repeated runs never spend API credit.

const has = (re, s) => (re.test(s) ? 0.95 : 0.05);

export function mockJev(body) {
  const { state } = body;
  const text = (state.comment?.text || '').toLowerCase();
  const name = `${state.comment?.author_display_name} ${state.comment?.author_handle}`.toLowerCase();
  const n = {
    impersonation: state.comment?.author_name_resembles_creator || /official|backup|support team/.test(name) ? 0.93 : 0.04,
    dm_to_learn: has(/\b(dm|inbox|message|text) me\b|\bdm\b.*\b(learn|earn|show|teach)/, text),
    off_platform: has(/whatsapp|telegram|instagram|\big\b|snap|wa\.me|t\.me|http|\.com|email|\+\d{6,}/, text),
    third_party_shill: has(/thanks to|recommend|mentor|account manager|expert|she helped|he helped|recover/, text),
    self_promotion: has(/my (page|channel|profile|course|store|shop|business)|check out my|follow me/, text),
    generic_thought_leadership: has(/success|mindset|grind|hustle|millionaire|abundance|wealth/, text),
    on_topic: /great|love|lol|haha|agree|thanks|question|why|how|video|this/.test(text) && !/mindset|dm me|whatsapp/.test(text) ? 0.85 : 0.2,
  };
  const harm = Math.max(n.impersonation, n.dm_to_learn, n.off_platform, n.third_party_shill);
  const promo = Math.max(n.self_promotion, n.generic_thought_leadership);
  let probs;
  if (harm > 0.9) probs = { remove: 0.9, review: 0.07, keep: 0.03 };
  else if (promo > 0.9) probs = { remove: 0.45, review: 0.4, keep: 0.15 };
  else probs = { remove: 0.03, review: 0.07, keep: 0.9 };
  const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  const answers = { verdict: { type: 'choice', choice, probabilities: probs, confidence: Math.max(...Object.values(probs)) } };
  for (const [k, v] of Object.entries(n)) answers[k] = { type: 'noul', noul: v };
  return { model: 'mock-jev', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}
