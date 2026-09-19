// Speech-to-text in the browser with Chrome's built-in speech recognition (Web Speech API), fed the
// video's own audio track. No key, no server of ours. The audio is cut into short slices that are
// recognized in parallel: faster than real time, and short sessions don't drop words.

const SLICE_SEC = 12;
const OVERLAP_SEC = 0.5;
const PARALLEL = 6;

// Common TikTok language codes -> recognizer locales. Anything else is passed through as-is.
const LOCALES = { en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', lt: 'lt-LT', lv: 'lv-LV', pl: 'pl-PL', ru: 'ru-RU', uk: 'uk-UA', tr: 'tr-TR', nl: 'nl-NL', ar: 'ar-SA', hi: 'hi-IN', id: 'id-ID', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', vi: 'vi-VN', th: 'th-TH' };
export const toLocale = (code) => LOCALES[(code || '').toLowerCase()] || code || 'en-US';

export function supported() {
  return !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
}

// audioBytes: an encoded audio file (e.g. WAV). Returns the transcript text ('' if no speech).
export async function transcribe(audioBytes, lang, onProgress = () => {}) {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!SR) throw new Error("this Chrome has no built-in speech recognition");
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    if (ctx.state !== 'running') throw Object.assign(new Error('audio is blocked until you click in the panel'), { needsGesture: true });
    const audio = await ctx.decodeAudioData(audioBytes.buffer.slice(0));
    const slices = [];
    for (let t = 0; t < audio.duration; t += SLICE_SEC) slices.push([Math.max(0, t - OVERLAP_SEC), Math.min(audio.duration, t + SLICE_SEC)]);
    const texts = new Array(slices.length).fill('');
    let next = 0;
    let done = 0;
    const errors = [];
    const worker = async () => {
      while (next < slices.length) {
        const i = next++;
        const r = await slice(SR, ctx, audio, ...slices[i], toLocale(lang));
        texts[i] = r.text;
        errors.push(...r.errors);
        onProgress(++done, slices.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, slices.length) }, worker));
    const text = texts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const fatal = errors.find((e) => e !== 'no-speech' && e !== 'aborted');
    if (!text && fatal) throw new Error(`speech recognition failed (${fatal})`);
    return { text, seconds: audio.duration, locale: toLocale(lang) };
  } finally {
    ctx.close();
  }
}

// Play [from, to) of the audio into a silent track and recognize it. Chrome may end a session early,
// so a new one is started until the slice has finished playing; unfinished (interim) text is kept.
function slice(SR, ctx, audio, from, to, locale) {
  return new Promise((resolve) => {
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    const parts = [];
    const errors = [];
    let playing = true;
    let current = null;
    const session = () => {
      const r = (current = new SR());
      let interim = '';
      r.lang = locale;
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) parts.push(e.results[i][0].transcript.trim());
          else interim += e.results[i][0].transcript;
        }
      };
      r.onerror = (e) => errors.push(e.error);
      r.onend = () => {
        if (interim.trim()) parts.push(interim.trim());
        const fatal = errors.some((x) => x === 'not-allowed' || x === 'language-not-supported') || errors.length >= 5;
        if (playing && !fatal) session();
        else finish();
      };
      try {
        r.start(track);
      } catch (e) {
        errors.push(e.message);
        playing = false;
        finish();
      }
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { src.stop(); } catch {}
      resolve({ text: parts.join(' '), errors });
    };
    src.onended = () => {
      playing = false;
      setTimeout(() => current?.stop(), 1200);
    };
    src.start(0, from, to - from);
    session();
  });
}
