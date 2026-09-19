# Bouncer

Bouncer is a Chrome extension for moderating comments on your own TikTok videos. It flags scam, impersonation and spam comments and deletes only the ones you pick.

Jev (TypeSafe) judges each comment through a small Node service that holds the API key. The key never reaches the extension or the page.

```
extension/           Chrome extension (side panel + content script), no build step
  config.js          SERVICE_URL: the one line to change when publishing
  lib/transcribe.js  speech-to-text of the video's audio with Chrome's built-in speech recognition
  lib/patterns.js    facts counted in code: repeats, @account campaigns, look-alike names, contacts
service/             the service: reads .env, calls Jev, spend cap, cache, rate limit (zero dependencies)
  judge.mjs          the state sent to Jev, the questions asked, the thresholds (all policy lives here)
test/                unit tests, recorded Jev answers (written + real TikTok comments), Chrome smoke test
```

## Run it locally (about 2 minutes)

1. You need Node 20 or newer and Chrome 135 or newer. There's nothing to install.
2. Put your key in `.env` in this folder:
   ```
   TYPESAFE_API_KEY=...
   ```
3. Start the service and leave it running:
   ```
   npm start
   ```
4. Load the extension in Chrome:
   1. Open `chrome://extensions`.
   2. Turn on **Developer mode**.
   3. Click **Load unpacked** and select `extension/`.
5. Open one of your videos on tiktok.com, click the Bouncer icon, then **Scan comments**.

## Publishing (Chrome Web Store)

End users don't run anything. You host the service once, and the extension calls it.

1. **Deploy the service.** `service/server.mjs` has no dependencies and runs on any Node host (Render, Fly.io, Railway, a VPS). Set:
   - `TYPESAFE_API_KEY`
   - `HOST=0.0.0.0`
   - `PORT` (usually provided by the host)
   - `ALLOWED_ORIGINS=chrome-extension://<your published extension id>`
   - `TRUST_PROXY=1` if the host puts a proxy in front
   - optionally `BOUNCER_BUDGET_USD` and `BOUNCER_MAX_COMMENTS_PER_HOUR` (per IP, default 5000)

   Because the spend ledger and cache are small JSON files, give the service a persistent disk, or accept that both reset on redeploy.
2. **Point the extension at it:** put the service's `https://` URL in `extension/config.js`, then zip `extension/` and upload it.
3. **Write a store privacy note.** Comment text plus the video's caption and transcript go to your service and to TypeSafe. For videos without TikTok subtitles, the audio goes to Chrome's speech recognition, which is Google's.

Paid plans would sit in front of step 1 (for example a license key checked by the service). That isn't built yet.

## How it works

- **Transcript.** Jev needs to know what the video says so that on-topic replies aren't mistaken for spam. Bouncer uses the first of these that's available:
  1. TikTok's own subtitles.
  2. The video's audio, transcribed by Chrome's built-in speech recognition. It runs in the extension, in parallel 12-second slices: about 15–20 s for a 1-minute video, with no key and no cost. It covers 20 languages, including Lithuanian, via the language picker.
  3. What you type.

  The editable box shows exactly what Jev gets, and the whole transcript is sent (up to 12,000 characters, enough for any TikTok).
- **Context sent to Jev** for each comment:
  - the creator's handle, name and bio
  - the caption (TikTok's title) and the full transcript
  - the comment and its author's name and handle
  - the parent comment, and the first replies
  - facts counted in code: copies of the same text, the same @account pushed across comments, how many comments the account left, contact details found, and whether the name looks like the creator's

  Anything missing is marked `not_available`, never invented.
- **Groups.** Each comment lands in **Likely scam**, **Uncertain** or **Keep**, with a short reason and a confidence.
  - "Likely scam" needs Jev's verdict plus a named signal: impersonation, a "DM me to learn" pitch, an off-TikTok contact request, a third-party "teacher"/"expert", or off-topic promotion.
  - Inside a campaign (copy-paste, or several comments pushing one @account), a moderate signal is enough.
  - After judging, an account with a likely scam can't keep its other comments.
  - Ambiguous promotion stays Uncertain.
- **Scanning and deleting.**
  - The scan reports comments scanned, the total TikTok shows, and Complete or Partial, with the reason.
  - Deleting works from any group, after a confirmation. Before each deletion Bouncer checks the exact author and text, clicks TikTok's own Delete, and confirms the comment is gone.
  - It stops if the page changed or the match is ambiguous.
  - In the profile-grid pop-up, TikTok ignores scripted clicks, so Bouncer offers **Open video page** instead.

## Tests

```
npm test             # 24 unit tests + 78 recorded Jev judgements replayed (no spend)
npm run test:chrome  # the real extension in Chrome for Testing on TikTok-like pages, incl. speech-to-text
npm run record       # re-ask Jev for the fixtures after changing questions (about $0.003)
```

## Results (2026-09-19)

| What | Result |
|---|---|
| Fixtures: 36 written comments + **42 real @orangie comments** labelled by hand | **78/78** in the expected group |
| Live, 6 @orangie videos (937 comments, judged with full context) | 381 likely scam / 128 uncertain / 428 keep. Every one of the 84 unique "likely scam" texts was checked by hand, and **none were genuine**. The campaigns are caught (e.g. "@Henry_trader best teacher" ×47, "Ask/learn from @Marrion Jaime" ×85, "@TonnyNoir to learn" ×34, "@HARRYTRADE📊 best coach", "Slide in for guide", "wanna be an insider?"). Genuine replies stay in Keep: "Teach me pls", "Try Claude", "Keep grinding dog". |
| Live, owned video | A disposable comment was deleted through the panel and verified gone on reload; the other comment was untouched |
| Live speech-to-text inside the extension | 49 s of real TikTok audio became 181 words in 17.6 s, matching TikTok's own subtitles |
| Unit and Chrome tests | 24/24 unit, 8/8 Chrome (both TikTok layouts, delete safety, partial coverage, speech-to-text) |
| Jev spend for the whole build and all testing | **$0.13** of the $5 credit (about $0.00006 per comment) |

**Limits:**
- "Uncertain" still holds real judgement calls: "DM me" offers on a video asking for help, begging, and gains-flexing. Review that group before deleting.
- Chrome's speech recognition needs internet and may miss background singing.
- Bulk deletion on live TikTok has been tested with one comment only, since it's the same verified step repeated.
- TikTok changes its markup without notice. The selectors are at the top of `extension/content.js`.
