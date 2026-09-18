# Bouncer

Bouncer is a Chrome extension for moderating comments on your own TikTok videos. It flags scam, impersonation and spam comments and deletes only the ones you pick.

Jev (TypeSafe) judges each comment through a small local Node service. The API key stays in that service and never reaches the extension or the page.

```
extension/        Chrome extension (side panel + content script), no build step
service/          local service: reads .env, calls Jev, tracks spend, caches, transcribes audio
  judge.mjs       the state sent to Jev, the questions asked, the thresholds (all policy lives here)
  transcribe.swift  on-device speech-to-text helper (macOS 26 SpeechAnalyzer), built on first use
test/             unit tests, recorded Jev answers, TikTok-like fixtures, Chrome smoke test
```

## Setup (about 2 minutes)

1. You need Node 20 or newer. There's nothing to install: the project has no npm dependencies. For automatic transcripts you also need macOS 26 with Xcode command line tools.
2. Put your key in `.env` in this folder:
   ```
   TYPESAFE_API_KEY=...
   ```
3. Start the service and leave it running:
   ```
   npm start
   ```
   Use `npm run start:mock` to work offline with a fake Jev that costs nothing.
4. Load the extension in Chrome:
   1. Open `chrome://extensions`.
   2. Turn on **Developer mode**. Chrome disables unpacked extensions without it.
   3. Click **Load unpacked** and select the `extension/` folder.
5. Open one of your videos, for example `tiktok.com/@you/video/…`. Click the Bouncer toolbar icon to open the side panel, then click **Scan comments**.

## Using it

- **Transcript.** Jev needs to know what the video says so that on-topic replies aren't mistaken for spam. Bouncer uses the first of these that's available:
  1. TikTok's own subtitles.
  2. The video's audio, transcribed **on this Mac** by Apple's built-in speech model: free, private, and about 2 seconds per minute of video. It covers 30 languages, including English, Spanish, French, German, Portuguese, Italian, Japanese, Korean and Chinese.
  3. What you type in the panel.

  The transcript is shown in an editable box, and Jev is told where it came from. Lithuanian isn't supported by Apple's model, so type those. Music-only videos come back as "no speech found".
- **Scanning.** The scan opens the comments, scrolls through them step by step (keep the TikTok tab visible) and expands replies. It removes duplicates by TikTok's comment ID where available, otherwise by author, text and thread. The panel shows three numbers:
  - comments scanned
  - the total TikTok shows
  - **Complete** or **Partial**, with the reason, such as "TikTok stopped loading more comments" or "stopped by you"

  Bouncer never claims coverage it didn't get.
- **Context sent to Jev** for each comment:
  - the caption, the transcript, and your handle, name and bio
  - the commenter's name and handle
  - the parent comment, and the first replies
  - repeat patterns counted in code: the same text from this account or from others, and how many comments the account left
  - contact details found in the text
  - whether the name looks like yours

  Anything missing is listed as `not_available`, never invented.
- **Groups.** Each comment lands in **Likely scam**, **Uncertain** or **Keep**, with a short reason and a confidence. "Likely scam" needs Jev's overall verdict plus a named signal: impersonation, a "DM me to learn" pitch, an off-TikTok contact request, a third-party "expert", or off-topic promotion. The same signal also counts when it comes from an account flooding the video (the same text 3+ times, or 5+ off-topic comments). Promotion that could be genuine stays **Uncertain**, and so does a flood with no scam signal.
- **Deleting.** You can delete one comment or a selection, from any group, after an in-panel confirmation. For each comment, Bouncer:
  - checks the tab still shows the scanned video
  - re-finds the comment by exact author and text (and ID and parent when available)
  - refuses if it finds zero or more than one match
  - opens TikTok's own ⋯ menu and clicks TikTok's **Delete** control
  - confirms TikTok's dialog if one appears
  - counts the deletion only when the comment no longer appears on the page

  A batch stops at the first problem, and the rest are left untouched.
- **Videos opened from your profile grid** open in a pop-up where TikTok ignores scripted clicks on ⋯. Bouncer can still scan there, but it disables Delete and offers **Open video page**. On the normal video page, deletion works.

## Spend

The service logs every live Jev call to `service/usage.json`, which the panel header also shows. It reserves a worst-case cost before each call, so parallel calls can't overshoot the budget. The default cap is **$4** (`BOUNCER_BUDGET_USD`). Answers are cached in `service/cache.json`, so re-judging the same comments is free. Transcription runs on-device and costs nothing.

Jev costs $0.042 per million input tokens, which works out to roughly **$0.00006 per comment**, or about $0.06 per 1,000 comments. All development and testing used **$0.043** of the $5 credit.

## Tests

```
npm test             # 21 unit tests + replay of recorded Jev answers (no API spend)
npm run test:chrome  # the real extension in Chrome for Testing against TikTok-like pages (no spend)
npm run record       # one live Jev pass over test/fixtures/comments.json; re-run after editing questions
```

`test:chrome` looks for Chrome for Testing/Chromium in the Playwright cache, or at `CHROME_PATH`. Branded Chrome ignores `--load-extension`. It uses macOS `say` to make the test audio.

## Test results (2026-09-19)

| What | Result |
|---|---|
| Classification: 36 realistic comments (scams, impersonators, shills, ambiguous promotion, rude-but-genuine), live Jev | **36/36** in the expected group. No genuine comment was flagged as a likely scam, and no scam was kept. |
| Unit tests: pattern facts, no invented context, decision and flood rules, service (origin guard, key redaction, cache, budget stop under parallel load) | **21/21** |
| Chrome smoke test on both TikTok layouts (standalone page, and profile pop-up with a virtualized list) | **8/8**: subtitles; on-device transcript from the video's audio; scroll and reply loading; honest partial and complete coverage; groups; bulk delete with verification; refusal on an ambiguous duplicate, a changed page, or a missing comment; the pop-up's Delete block and "Open video page" |
| **Live, owned video:** scan and judge, then delete a disposable comment through the panel | Scanned 2 of 2 (Complete). Deleted *"bouncer test delete me"*, and it was verified gone after a fresh reload. The other comment was untouched. Audio: "no speech found" (music only), which is correct. |
| **Live, @orangie/video/7686638305575783694** (read-only, not owned) | Used TikTok subtitles (952 characters); the on-device transcript of the same audio also matched. Scanned 368 of 425 comments (Partial: TikTok stopped loading more). Result: **133 likely scam** (the "@Marrion Jaime" and "@Gray_George" floods, "DM me to learn memecoin" pitches, "@Sophia Ashford \| Day Trader" shills) / 111 uncertain / 124 keep. About $0.02. Delete disabled ("not your video"). |
| **Live, public pet video** (read-only) | 162 comments in 12 s including 104 replies; reported Partial (162 of 5,624, stopped by you); 161 keep, 1 uncertain |

**Not verified live:**
- Bulk deletion of several comments on real TikTok. Only one was deleted live; bulk runs the same verified single-delete in sequence and is covered by the fixture test.
- Deletion from the profile pop-up. TikTok ignores it, so Bouncer blocks it on purpose.
- Scanning a video with thousands of comments all the way to the end.

TikTok changes its markup without notice. If a scan finds 0 comments or Delete is never offered, check the selectors at the top of `extension/content.js`.
