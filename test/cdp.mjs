// Minimal Chrome DevTools Protocol driver (no dependencies; Node 22 has WebSocket + fetch).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Branded Google Chrome ignores --load-extension, so prefer Chrome for Testing / Chromium.
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pw = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(pw)) {
    for (const dir of readdirSafe(pw).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const p = join(pw, dir, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        if (existsSync(p)) return p;
        const c = join(pw, dir, arch, 'Chromium.app/Contents/MacOS/Chromium');
        if (existsSync(c)) return c;
      }
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

function readdirSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

export async function launch({ headless = true, extensionDir, args = [] } = {}) {
  const userDataDir = mkdtempSync(join(process.env.CDP_TMP || tmpdir(), 'cdp-profile-'));
  const flags = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--window-size=1400,1000',
    ...(headless ? ['--headless=new'] : []),
    ...(extensionDir ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : []),
    ...args,
    'about:blank',
  ];
  const proc = spawn(findChrome(), flags, { stdio: 'ignore' });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new Connection(webSocketDebuggerUrl);
  await browser.ready;
  browser.close = async () => {
    try { await browser.send('Browser.close'); } catch {}
    proc.kill();
    await sleep(300);
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return browser;
}

// Attach to an already-running Chrome started with --remote-debugging-port=<port>.
export async function connect(port = 9333) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new Connection(webSocketDebuggerUrl);
  await browser.ready;
  browser.close = async () => browser.ws.close();
  return browser;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.listeners.push(fn); }

  // Open a page (or attach to an existing target) and return a session helper.
  async page(url = 'about:blank', { newWindow = false } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url, newWindow });
    return this.attach(targetId);
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const s = {
      targetId,
      sessionId,
      logs: [],
      send: (m, p) => this.send(m, p, sessionId),
      eval: async (expression) => {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      goto: async (u) => {
        await this.send('Page.navigate', { url: u }, sessionId);
        await s.waitFor('document.readyState === "complete"', 30000);
      },
      waitFor: async (expr, timeout = 10000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          try { if (await s.eval(expr)) return true; } catch {}
          await sleep(150);
        }
        throw new Error(`waitFor timed out: ${expr}`);
      },
      screenshot: async (path) => {
        const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
      },
    };
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    this.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') s.logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') s.logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    });
    return s;
  }
  async targets() {
    return (await this.send('Target.getTargets')).targetInfos;
  }
}
