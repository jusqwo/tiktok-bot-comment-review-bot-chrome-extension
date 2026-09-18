// Builds the exact Jev requests the service would send for the classification fixtures.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { annotate } from '../extension/lib/patterns.js';
import { buildRequest } from '../service/judge.mjs';

export const fixtures = JSON.parse(readFileSync(new URL('./fixtures/comments.json', import.meta.url), 'utf8'));

export function fixtureRequests(model = 'jev-latest') {
  const byId = Object.fromEntries(fixtures.comments.map((c) => [c.id, c]));
  const out = [];
  for (const [vKey, v] of Object.entries(fixtures.videos)) {
    const comments = fixtures.comments
      .filter((c) => c.video === vKey)
      .map((c) => {
        const p = c.parent && byId[c.parent];
        return {
          ...c,
          parent: p ? { author_name: p.author_name, author_handle: p.author_handle, text: p.text } : null,
          replies: fixtures.comments.filter((r) => r.parent === c.id).map((r) => ({ author_handle: r.author_handle, text: r.text })),
        };
      });
    annotate(comments, { handle: v.creator.handle, name: v.creator.name });
    const video = { creator: v.creator, caption: v.caption, transcript: v.transcript || '' };
    for (const c of comments) {
      const body = buildRequest(video, c, model);
      out.push({ c, video, body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16) });
    }
  }
  return out;
}
