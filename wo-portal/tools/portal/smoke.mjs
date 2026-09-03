// ---------------------------------------------------------------------------
// Browser smoke test: does every page actually run?
//
//   WO_CHECK_USER=… WO_CHECK_PASSWORD=… node tools/portal/smoke.mjs
//
// The unit tests cover the pure modules and live-check.mjs covers the database
// through its API, but neither loads a page. This does: it serves the folder,
// drives headless Chromium over the DevTools protocol, and visits every screen
// signed in, failing on any console error, any uncaught exception, any sideways
// scroll at phone width, and any page that never renders past its "Loading…"
// skeleton.
//
// Hermetic on purpose. tools/portal/stub-client.js stands in for the Supabase
// SDK, so this needs no account, no network and no live database, and it says
// the same thing every time it runs. What it proves is that the pages work:
// that their queries name tables this portal has, that their render functions
// survive real-shaped rows, that no module imports something that is gone.
// Whether the DATABASE behaves is live-check.mjs's question, against the real
// project, and neither test can answer the other's.
//
// Screenshots land in tools/portal/shots/ when WO_SHOTS=1, which is how the
// phone layout gets looked at.
//
// Give it the machine. Two headless Chromiums on a small box starve each
// other, and what that looks like from here is a page that never finishes
// rendering and a manifest icon that "isn't a valid image" — neither of which
// is true. It picks a free port so two runs cannot collide outright, but a run
// racing another for CPU will still report failures it should not.
//
// No Playwright: this container has the Chromium binary but not the npm
// package, and Node 22 ships a WebSocket client, so the protocol is spoken
// directly. That is about a hundred lines, and it is the only thing standing
// between "the modules parse" and "the page works".
// ---------------------------------------------------------------------------
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Read from config.js so a version bump cannot leave the stub un-swapped.
const SDK_VERSION = /SUPABASE_SDK_VERSION\s*=\s*'([^']+)'/
  .exec(await readFile(resolve(ROOT, 'js/portal/config.js'), 'utf8'))?.[1] || '2.111.0';

const PORT = Number(process.env.WO_PORT || 8899);
const SHOTS = process.env.WO_SHOTS === '1';
const WIDTH = Number(process.env.WO_WIDTH || 390);
const HEIGHT = Number(process.env.WO_HEIGHT || 844);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

// The pages, in the order somebody would meet them.
const SCREENS = [
  ['/portal/dashboard/', 'Dashboard'],
  ['/portal/clients/', 'Clients'],
  ['/portal/invoices/', 'Invoices'],
  ['/portal/expenses/', 'Expenses'],
  ['/portal/reports/', 'Reports'],
  ['/portal/admin/', 'Admin'],
];

let failures = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok' : 'FAILED'}: ${what}`);
  if (!cond) failures += 1;
};

// --- the static server, with the production headers that matter ------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.includes('..')) { res.writeHead(403).end(); return; }
  if (path.endsWith('/')) path += 'index.html';
  // The vendored SDK is swapped for the stub at the door rather than injected
  // ahead of it: a classic <script> that runs later would otherwise overwrite
  // window.supabase with the real client, which then cannot reach anything.
  const file = path === `/js/vendor/supabase-${SDK_VERSION}.js`
    ? join(ROOT, 'tools/portal/stub-client.js')
    : join(ROOT, path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // The one that catches real bugs locally: a page that violates the
      // production policy fails here rather than after a deploy.
      // The production policy, with connect-src narrowed to 'self': the stub
      // answers in-process, so any screen that reaches the network at all
      // trips this and shows up as a console error.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; "
        + "font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; "
        + "form-action 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

// --- the smallest CDP client that can do this ------------------------------
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const page = new Page(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && page.waiting.has(msg.id)) {
        const { resolve: r, reject } = page.waiting.get(msg.id);
        page.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : r(msg.result);
      } else if (msg.method) page.events.push(msg);
    };
    return page;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
    return r.result.value;
  }

  /** Poll a predicate rather than racing a fixed sleep. */
  //
  // With `value`, the expression's own result is returned rather than a
  // boolean — so a caller can read several facts about the page at the exact
  // moment the condition held, instead of asking again afterwards and racing
  // whatever the page did next.
  async until(expression, { timeout = 15000, label = expression, value = false } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const got = await this.eval(`(() => { try { return (${expression}) || false; } catch { return false; } })()`);
      if (got) return value ? got : true;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Console errors and failed requests since the last call. */
  drain() {
    const problems = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        problems.push(`uncaught: ${e.params.exceptionDetails.exception?.description
          || e.params.exceptionDetails.text}`);
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        problems.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        const { source, text, url } = e.params.entry;
        // A 400 from PostgREST is reported here and nowhere else.
        problems.push(`${source}: ${text}${url ? ` (${url})` : ''}`);
      }
    }
    this.events.length = 0;
    return problems;
  }
}

function launch(port) {
  const debugPort = port + 400;
  return new Promise((resolve, reject) => {
    const child = execFile(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=9222', '--remote-allow-origins=*',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ], () => {});
    const deadline = Date.now() + 20000;
    const poll = async () => {
      try {
        const res = await fetch('http://127.0.0.1:9222/json/version');
        const info = await res.json();
        resolve({ child, wsUrl: info.webSocketDebuggerUrl });
      } catch (err) {
        if (Date.now() > deadline) reject(err);
        else setTimeout(poll, 200);
      }
    };
    setTimeout(poll, 300);
  });
}

/** Bind the first free port from PORT upward, so two runs cannot collide. */
function listen(from) {
  return new Promise((resolve, reject) => {
    let port = from;
    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < from + 20) { port += 1; attempt(); }
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    attempt();
  });
}

async function main() {
  const port = await listen(PORT);
  const { child, wsUrl } = await launch(port);

  // A page target of our own, so the about:blank one is left alone.
  const browser = await Page.open(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const target = list.find((t) => t.id === targetId);
  const page = await Page.open(target.webSocketDebuggerUrl);

  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true,
  });

  const base = `http://localhost:${port}`;
  if (SHOTS) await mkdir(join(ROOT, 'tools/portal/shots'), { recursive: true });

  const shoot = async (name) => {
    if (!SHOTS) return;
    // Viewport only, and JPEG: a full-page PNG of a long screen is a
    // multi-megabyte base64 frame, and Node's WebSocket drops it.
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    await writeFile(join(ROOT, 'tools/portal/shots', `${name}.jpg`), Buffer.from(data, 'base64'));
  };

  console.log(`Serving ${ROOT} at ${base}, driving ${WIDTH}×${HEIGHT}`);

  // --- the sign-in page ------------------------------------------------------
  //
  // It renders before the shell exists, so it is checked on its own terms: the
  // form is there, it is the right business, and nothing threw on the way.
  await page.send('Page.navigate', { url: `${base}/portal/?stub=signedout` });
  await page.until('document.getElementById("login-submit")', { label: 'the sign-in form' });
  ok(await page.eval('document.title.includes("Walter Ochenski")'), 'sign-in page titled for the business');
  ok(await page.eval('!!document.querySelector(\'img[src*="wo-mark"]\')'), 'the WO mark is on the sign-in page');
  ok(await page.eval('!!document.getElementById("login-username")'), 'it asks for a username, not an email');
  ok(await page.eval('!document.body.textContent.includes("@")'), 'no address is shown to type');
  ok(await page.eval('document.body.textContent.includes("467-5988")'), 'the phone number is the way back in');
  const loginProblems = page.drain();
  ok(loginProblems.length === 0, `sign-in page clean${loginProblems.length ? `: ${loginProblems.join(' | ')}` : ''}`);
  await shoot('01-login');

  // Signed out, a portal page must send you to the sign-in page rather than
  // rendering an empty shell of somebody else's data.
  //
  // Path and query are read in the SAME evaluation. Reading them in two calls
  // is a race: the sign-in page is entitled to move on the moment it has a
  // session, and the query string can be gone by the second call.
  await page.send('Page.navigate', { url: `${base}/portal/invoices/?stub=signedout` });
  const bounced = await page.until(
    '(location.pathname === "/portal/") && location.href',
    { label: 'the bounce to sign-in', timeout: 20000, value: true },
  );
  ok(true, 'a portal page signed out bounces to the sign-in page');
  ok(/next=%2Fportal%2Finvoices/.test(bounced), `and remembers where you were going (${bounced.split('?')[1] || ''})`);
  page.drain();

  // --- every screen ---------------------------------------------------------
  for (const [path, label] of SCREENS) {
    await page.send('Page.navigate', { url: base + path });
    await page.until('document.getElementById("portal-root")', { label: `${label} root` });
    try {
      // The shell replaces the skeleton with the page's own content; a page
      // that throws leaves "Loading…" on screen forever, which is exactly the
      // failure a parse-only check cannot see.
      await page.until(
        '!document.querySelector("#portal-root .skeleton") && document.querySelector("#portal-root").children.length > 0',
        { label: `${label} to render`, timeout: 20000 },
      );
      ok(true, `${label} renders`);
    } catch (err) {
      ok(false, `${label} renders — ${err.message}`);
    }
    const navLinks = await page.eval('document.querySelectorAll("#portal-nav a").length');
    ok(navLinks > 0, `${label} has the header nav (${navLinks} links)`);
    const wide = await page.eval('document.documentElement.scrollWidth <= window.innerWidth + 1');
    ok(wide, `${label} does not scroll sideways at ${WIDTH}px`);
    const problems = page.drain();
    ok(problems.length === 0, `${label} console clean${problems.length ? `: ${problems.slice(0, 3).join(' | ')}` : ''}`);
    await shoot(`${String(SCREENS.findIndex((s) => s[0] === path) + 2).padStart(2, '0')}-${label.toLowerCase()}`);
  }

  child.kill();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nSmoke OK — every page renders, and logs nothing.');
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
