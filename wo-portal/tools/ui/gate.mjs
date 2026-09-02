// ---------------------------------------------------------------------------
// The UI gate — the rules that are correctness rather than taste, measured.
//
//   python3 -m http.server 8899 --bind 127.0.0.1     # from the repo root
//   node tools/ui/gate.mjs [--shot] [--only=<name>]
//
// Not part of `node --test`: it needs a running server and a Playwright
// install, and neither is a dependency of this repo (there is no package.json
// and there is not going to be one). It is a tool you run when you have
// changed how something looks, in the same spirit as tools/pricing/build.mjs.
//
// GATE_PORT overrides the port, GATE_OUT the screenshot directory.
//
// What it enforces, and why each one is not a matter of opinion:
//
//   1. The document never scrolls sideways, down to 320px. ARCHITECTURE §7.12
//      calls this a correctness invariant, and it is judged on the document's
//      own scrollWidth — not element by element, because a skip link at
//      -9999px, a spam honeypot and anything inside an SVG viewBox all sit
//      outside the viewport perfectly legitimately.
//
//   2. Target sizes, against two different floors, because they come from two
//      different rules: 44px for anything that reads as a control (this
//      repo's own floor), and WCAG 2.2 SC 2.5.8 AA's 24px for a plain text
//      link — with the spec's exemption for a link sized by the line-height
//      of the prose around it. Conflating the two buries real defects under
//      a hundred false ones; the first version of this file did exactly that.
//
//   3. Form controls at 16px or larger. Below that, iOS Safari zooms the page
//      on focus and does not zoom back, and this is a form-heavy app.
//
//   4. A :focus-visible ring that actually changes something, compared
//      before and after focus rather than by trusting that a rule exists
//      somewhere in six thousand lines of CSS.
//
// It measures two kinds of subject. Real pages are served from the repo and
// are the higher-fidelity half — but Supabase is unreachable from a dev
// container, so those render their static shell only. The fixtures cover the
// rest, and each one names the render function its markup was transcribed
// from. When that function changes, re-check the fixture: an out-of-date
// fixture passes happily while the real screen is broken, and a fixture that
// used the wrong wrapper class is how this file first reported four defects
// that did not exist.
// ---------------------------------------------------------------------------
// Playwright is deliberately not a dependency of this repo — there is no
// package.json to declare it in, and there is not going to be one. So it is
// resolved at run time from wherever it happens to live: a local install
// first, then a global one. Note NODE_PATH is no help here; it applies to
// CommonJS resolution only, which is exactly why the global lookup goes
// through createRequire rather than a bare import.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

function loadPlaywright() {
  try {
    return createRequire(`${process.cwd()}/`)('playwright');
  } catch { /* not installed locally — try the global root */ }

  const roots = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* npm may not be on PATH */ }
  roots.push('/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules');

  for (const root of roots.filter(Boolean)) {
    try {
      return createRequire(`${process.cwd()}/`)(`${root}/playwright`);
    } catch { /* keep looking */ }
  }
  return null;
}

const playwright = loadPlaywright();
if (!playwright) {
  console.error(`This tool needs Playwright, which this repo deliberately does not depend on.

  npm install -g playwright        # or a local install in this directory

Everything else in tools/ runs with no install; this is the one exception, and
it is why the gate is not part of \`node --test\`.`);
  process.exit(2);
}
const { chromium } = playwright;

// PLAYWRIGHT_BROWSERS_PATH usually resolves the browser on its own; the pinned
// path is a fallback for containers where it does not.
async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({
      executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    });
  }
}

const PORT = process.env.GATE_PORT || '8899';
const BASE = `http://localhost:${PORT}`;
const HERE = process.env.GATE_OUT || '.';
const SHOT = process.argv.includes('--shot');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

// The markup below is transcribed from the portal's render functions, not
// invented. Each fixture names the module it came from so it can be re-checked
// when that module changes.
const FIXTURES = [
  {
    name: 'ai-rewrite-panel',
    from: 'ai-rewrite.js mount() + openPanel()',
    html: `
      <div class="panel">
        <h2>Waypoint message</h2>
        <form class="composer">
          <div class="form-field">
            <textarea rows="3" aria-label="Message">The homepage is done, take a look.</textarea>
            <div class="ai-rewrite" role="group" aria-label="AI suggestions">
              <p class="ai-rewrite__status progress__label" aria-live="polite">Three suggestions ready. Pick a tone, then use it or dismiss.</p>
              <div class="ai-rewrite__tones" role="group" aria-label="Tone">
                <button class="btn btn--ghost btn--small ai-rewrite__tone" type="button" aria-pressed="true">Professional</button>
                <button class="btn btn--ghost btn--small ai-rewrite__tone" type="button" aria-pressed="false">Friendly</button>
                <button class="btn btn--ghost btn--small ai-rewrite__tone" type="button" aria-pressed="false">Concise</button>
              </div>
              <p class="ai-rewrite__text">The homepage build is complete and ready for your review, including a very long unbroken address like https://example.com/a/rather/long/path/that/must/fold/instead/of/scrolling-sideways-at-320px.</p>
              <div class="ai-rewrite__foot">
                <button class="btn btn--small" type="button">Use this</button>
                <button class="btn btn--ghost btn--small" type="button">Dismiss</button>
              </div>
            </div>
          </div>
          <div class="composer__foot">
            <button class="btn btn--small" type="submit">Send</button>
            <button class="btn btn--ghost btn--small ai-rewrite__button" type="button" aria-label="Suggest an AI rewrite of this text"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg><span>AI rewrite</span></button>
          </div>
        </form>
      </div>`,
  },
  {
    name: 'btn-row-contact',
    from: 'client-detail.js contactRow()',
    html: `
      <div class="panel">
        <h2>People</h2>
        <div class="link-row">
          <div><strong>Robert Moon</strong><div class="muted">Owner · robert@example.com</div></div>
          <div class="btn-row">
            <button class="btn btn--ghost btn--tiny" type="button">Edit</button>
            <button class="btn btn--ghost btn--tiny" type="button">Move up</button>
            <button class="btn btn--ghost btn--tiny" type="button">Move down</button>
            <button class="btn btn--ghost btn--tiny" type="button">Remove</button>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'focus-card-row',
    from: 'focus.js cardRow() + render() figures',
    html: `
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1">
        <div class="progress__track"><div class="progress__bar" style="width:50%"></div></div>
        <p class="progress__label">1 of 2 done today — Keep going</p>
      </div>
      <div class="figure-row figure-row--six">
        <div class="figure"><p class="figure__label">Overdue</p><p class="figure__value figure__value--bad">1</p></div>
        <div class="figure"><p class="figure__label">Due today</p><p class="figure__value">1</p></div>
        <div class="figure"><p class="figure__label">Done today</p><p class="figure__value">1</p></div>
        <div class="figure"><p class="figure__label">Assigned</p><p class="figure__value">7</p></div>
        <div class="figure"><p class="figure__label">This week</p><p class="figure__value">2</p></div>
        <div class="figure"><p class="figure__label">High priority</p><p class="figure__value">3</p></div>
      </div>
      <div class="panel">
        <div class="panel__head"><div><h2>Overdue</h2></div><div class="page-head__actions"><span class="pill pill--red">1</span></div></div>
        <div class="agenda">
          <div class="agenda__row">
            <div class="agenda__body">
              <a class="agenda__title" href="#">Order new tower graphics</a>
              <p class="agenda__where">Marketing</p>
              <div class="kcard__meta">
                <span class="tag tag--priority tag--priority-high">High</span>
                <span class="tag tag--overdue">Overdue Aug 21</span>
                <span class="tag tag--checklist">3/5</span>
              </div>
              <div class="btn-row">
                <button class="btn btn--ghost btn--tiny" type="button">Done</button>
                <button class="btn btn--ghost btn--tiny" type="button">Focus</button>
              </div>
            </div>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'btn-row-invoice-line',
    from: 'invoice-editor.js lineRow() + rowControls()',
    html: `
      <div class="panel">
        <h2>Lines</h2>
        <div class="row-card">
          <div class="row-card__grid">
            <div class="form-field">
              <label class="form-field__label" for="l1">Description</label>
              <input id="l1" type="text" value="Homepage design and build">
            </div>
            <div class="form-field">
              <label class="form-field__label" for="l2">Quantity</label>
              <input id="l2" type="text" inputmode="decimal" value="1">
            </div>
            <div class="form-field">
              <label class="form-field__label" for="l3">Rate</label>
              <input id="l3" type="text" inputmode="decimal" value="2,400.00">
            </div>
            <div class="form-field">
              <span class="form-field__label">Amount</span>
              <p class="row-card__amount">$2,400.00</p>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn btn--ghost btn--tiny" type="button">Move up</button>
            <button class="btn btn--ghost btn--tiny" type="button">Move down</button>
            <button class="btn btn--ghost btn--tiny" type="button">Remove</button>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'consent',
    from: 'signature-panel.js — the bug that started this',
    html: `
      <div class="panel consent">
        <h2>Agreeing to sign electronically</h2>
        <p>Texas and federal law let us sign electronically, but only if you agree
           to it first. This is that agreement, and it is separate from signing anything.</p>
        <div class="btn-row">
          <button class="btn btn--wide" type="button">I agree to use electronic records and signatures.</button>
          <a class="btn btn--ghost" href="#">Back to your projects</a>
        </div>
      </div>`,
  },
  {
    name: 'comment-board',
    from: 'comments.js commentNode() + likeButton() + the composer',
    html: `
      <div class="panel">
        <form class="composer">
          <div class="form-field"><textarea rows="3" placeholder="Leave a comment…" aria-label="Comment"></textarea></div>
          <div class="composer__foot">
            <button class="btn btn--small" type="submit">Post comment</button>
            <span class="progress__label">Everyone on the project can read this.</span>
          </div>
        </form>
        <div class="comments">
          <div class="comment">
            <p class="comment__who">Dana Reid · Aug 14, 9:02 AM</p>
            <p class="comment__body">The new homepage direction looks great — one thought about the hero photo below.</p>
            <div class="comment__foot">
              <button class="btn btn--ghost btn--tiny like" type="button" aria-pressed="true" aria-label="Like this comment — 2 so far">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
                <span class="like__count">2</span>
              </button>
              <button class="btn btn--ghost btn--tiny" type="button">Remove</button>
            </div>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'drive-arrived',
    from: 'drives.js renderTracker() (arrived) — the card an iPhone automation '
        + 'leaves behind: netlify/functions/drive-hook.js marked both ends and '
        + 'the drive is waiting on an odometer reading. Its headline is the '
        + 'longest of the three states, carrying two clock times and two place '
        + 'names, so it is the one that finds a sideways scroll at 320px.',
    html: `
      <div class="panel">
        <div class="panel__head"><div><h2>Drive tracker</h2>
          <p class="progress__label">One tap when you pull out, one when you arrive. GPS marks both ends and, while this page stays open on the dash, measures the route.</p></div></div>
        <p><strong>Arrived 4:42 PM at Acme office — left 2:14 PM from Studio</strong></p>
        <p class="progress__label">Your phone marked both ends of this one. It needs the odometer reading before it can go on the books. It started at 112,437.</p>
        <div class="btn-row">
          <button class="btn" type="button">Log the miles</button>
          <button class="btn btn--ghost" type="button">Discard</button>
        </div>
      </div>`,
  },
  {
    name: 'drive-tracker',
    from: 'drives.js renderTracker() (running) + renderLog() showing everyone — '
        + 'the two-tap panel and one log row, in its widest state: three filters '
        + 'and a row carrying the driver line and the odometer trail',
    html: `
      <div class="panel">
        <div class="panel__head"><div><h2>Drive tracker</h2>
          <p class="progress__label">Read the odometer when you pull out, read it again when you park. The difference is the distance, so nothing has to stay open in between.</p></div></div>
        <p><strong>Driving — started 2:14 PM from Studio</strong></p>
        <p class="progress__label">Odometer at the start: 112,437. Close this page — the miles come from the reading you take when you park.</p>
        <div class="btn-row">
          <button class="btn" type="button">End the drive</button>
          <button class="btn btn--ghost" type="button">Discard</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel__head"><div><h2>Drive log</h2>
          <p class="progress__label">One line per trip — the contemporaneous record the standard mileage deduction stands on.</p></div>
          <div class="page-head__actions">
            <button class="btn btn--small" type="button">Add a drive</button>
            <button class="btn btn--ghost btn--small" type="button">Download the log</button>
          </div></div>
        <div class="filters">
          <div class="form-field"><label for="drv-from">From</label><input type="date" id="drv-from" value="2026-01-01"></div>
          <div class="form-field"><label for="drv-to">To</label><input type="date" id="drv-to" value="2026-08-27"></div>
          <div class="form-field"><label for="drv-driver">Whose</label><select id="drv-driver"><option value="mine">My drives</option><option value="all" selected>Everyone&#39;s drives</option></select></div>
        </div>
        <div class="table-scroll">
          <table class="table table--wide">
            <thead><tr><th scope="col">Date</th><th scope="col">Trip</th><th scope="col">Miles</th><th scope="col">Amount</th><th scope="col"></th></tr></thead>
            <tbody>
              <tr>
                <td class="is-tight" data-label="Date">Aug 27, 2026</td>
                <td class="is-roomy" data-label="Trip">
                  <span class="sow-cell__name">Studio → Acme office</span>
                  <span class="sow-cell__desc">Driven by Trip Ochenski</span>
                  <span class="sow-cell__desc">Kickoff meeting</span>
                  <span class="sow-cell__desc">Acme Co</span>
                  <span class="sow-cell__desc">Odometer 112,437 → 112,449.4</span>
                  <span class="sow-cell__desc">Pinned</span>
                  <span class="pill pill--amber pill--wrap">Not on the books — open it and Save</span>
                </td>
                <td class="is-numeric" data-label="Miles">12.4</td>
                <td class="is-numeric" data-label="Amount">$9.42</td>
                <td><button class="btn btn--ghost btn--tiny" type="button" aria-label="Edit the 12.4-mile drive to Acme office">Edit</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="progress__label">1 drive · 12.4 miles · $9.42 — every owner&#39;s driving pooled, each trip at the rate it was driven under</p>
      </div>`,
  },
  {
    name: 'recurring-row',
    from: 'ledger-expenses.js recurringRow() — a due one with its Record button '
        + 'and a paused one, the two states that share a row',
    html: `
      <div class="panel">
        <div class="panel__head"><div><h2>Subscriptions &amp; recurring</h2>
          <p class="progress__label">The monthly stack, recorded with a tap when each one falls due.</p></div>
          <div class="page-head__actions"><button class="btn btn--small" type="button">Add a subscription</button></div></div>
        <div class="table-scroll">
          <table class="table table--wide">
            <thead><tr><th scope="col">Subscription</th><th scope="col">Books to</th><th scope="col">Amount</th><th scope="col">Standing</th><th scope="col"></th></tr></thead>
            <tbody>
              <tr>
                <td class="is-roomy" data-label="Subscription">
                  <span class="sow-cell__name">Adobe Creative Cloud</span>
                  <span class="sow-cell__desc">Adobe</span>
                </td>
                <td class="is-tight" data-label="Books to"><span>6000 · Software subscriptions</span>
                  <span class="sow-cell__desc">Day 15 · Card</span></td>
                <td class="is-numeric" data-label="Amount">$89.99</td>
                <td data-label="Standing"><span class="pill pill--amber pill--wrap">3 months waiting — oldest is June</span></td>
                <td>
                  <span class="btn-row">
                    <button class="btn btn--small" type="button" aria-label="Record Adobe Creative Cloud for June">Record June</button>
                    <button class="btn btn--ghost btn--tiny" type="button" aria-label="Edit the subscription Adobe Creative Cloud">Edit</button>
                  </span>
                </td>
              </tr>
              <tr>
                <td class="is-roomy" data-label="Subscription"><span class="sow-cell__name">Figma</span></td>
                <td class="is-tight" data-label="Books to"><span>6000 · Software subscriptions</span>
                  <span class="sow-cell__desc">Day 1 · Card</span></td>
                <td class="is-numeric" data-label="Amount">$15.00</td>
                <td data-label="Standing"><span class="pill">Paused</span></td>
                <td>
                  <span class="btn-row">
                    <button class="btn btn--ghost btn--tiny" type="button" aria-label="Edit the subscription Figma">Edit</button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="notice notice--warn">1 waiting to be recorded.</p>
      </div>`,
  },
  {
    name: 'task-row',
    from: 'tasks.js taskRow() — the check button, the meta tags, one done row',
    html: `
      <div class="panel">
        <div class="panel__head"><div><h2>Tasks</h2><p class="progress__label">1 of 2 done</p></div>
          <div class="page-head__actions"><button class="btn btn--small" type="button">New task</button></div></div>
        <div class="tasks">
          <div class="task">
            <div class="task__head">
              <button class="task__check" type="button" aria-pressed="false" aria-label="Mark “Send over your logo files” done">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
              </button>
              <h3 class="task__title">Send over your logo files</h3>
            </div>
            <div class="task__body">
              <p class="task__desc">Please send over examples for both of these companies; I need one for each.</p>
              <div class="task__meta">
                <span class="tag">For Jacob Cheatham</span>
                <span class="tag tag--overdue">Overdue Aug 10, 2026</span>
                <button class="btn btn--ghost btn--tiny" type="button" aria-expanded="false" aria-label="Messages about Send over your logo files">2 messages</button>
                <button class="btn btn--ghost btn--tiny" type="button">Edit</button>
              </div>
            </div>
          </div>
          <h3 class="tasks__done-head">Done</h3>
          <div class="task task--done">
            <div class="task__head">
              <button class="task__check" type="button" aria-pressed="true" aria-label="Reopen “Approve the sitemap”">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg>
              </button>
              <h3 class="task__title">Approve the sitemap</h3>
            </div>
            <div class="task__body">
              <div class="task__meta"><span class="tag">Done Aug 12, 2026</span></div>
            </div>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'waypoint-row',
    from: 'waypoints.js waypointRow() + reorder.js handle() — staff view, grip and all',
    html: `
      <div class="panel">
        <div class="panel__head"><div><h2>Waypoints</h2></div></div>
        <div class="timeline">
          <div class="waypoint waypoint--in_progress is-reorderable">
            <div class="waypoint__head">
              <button class="reorder-handle" type="button" draggable="false" aria-label="Reorder Database access and environment review">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>
              </button>
              <div class="waypoint__dot" aria-hidden="true"></div>
              <h3 class="waypoint__title">Database access and environment review</h3>
            </div>
            <div class="waypoint__body">
              <p class="waypoint__desc">Credentialed read access to the existing Contrack database, plus a review of its schema, data quality, and what the spec builder can rely on. This waypoint is the project start trigger — the clock does not run before it clears.</p>
              <div class="waypoint__meta">
                <span class="pill pill--blue">In Progress</span>
                <span class="tag">Due Aug 14, 2026</span>
                <span class="tag">1 card left</span>
                <button class="btn btn--ghost btn--tiny waypoint__discuss" type="button" aria-expanded="false" aria-label="Messages about Database access and environment review">1 message</button>
                <button class="btn btn--ghost btn--tiny" type="button">Edit</button>
              </div>
            </div>
          </div>
        </div>
      </div>`,
  },
  {
    name: 'journey-bar',
    from: 'phase.js renderPhaseBar() — the staff bar (buttons) at Trek, then the client bar (spans) at Discovery',
    // The 44px floor is met by each step's whole column, not its 24px marker —
    // same reasoning as the checkbox measured by its label. The legs are
    // flex: 1 with a min-width, so at 320px the bar must compress rather than
    // push the page sideways.
    html: `
      <div class="page-head">
        <div><h1>Website Refresh</h1></div>
        <div class="page-head__actions"><span class="pill pill--blue">In Progress</span></div>
      </div>
      <div class="journey" role="group" aria-label="Project phase: Trek, 3 of 4 on the journey">
        <button class="journey__step journey__step--past" type="button" aria-label="Move this project to Discovery (1 of 4)" title="Learning your world — goals, audience, and what success looks like.">
          <span class="journey__marker" aria-hidden="true">1</span>
          <span class="journey__label">Discovery</span>
        </button>
        <span class="journey__leg journey__leg--travelled" aria-hidden="true"></span>
        <button class="journey__step journey__step--past" type="button" aria-label="Move this project to Chart (2 of 4)" title="Charting the course — scope, plan, and waypoints.">
          <span class="journey__marker" aria-hidden="true">2</span>
          <span class="journey__label">Chart</span>
        </button>
        <span class="journey__leg journey__leg--travelled" aria-hidden="true"></span>
        <button class="journey__step journey__step--current" type="button" aria-current="step" aria-label="Trek — the current phase (3 of 4)" title="Making the trek — design and build, waypoint by waypoint.">
          <span class="journey__marker" aria-hidden="true">3</span>
          <span class="journey__label">Trek</span>
        </button>
        <span class="journey__leg" aria-hidden="true"></span>
        <button class="journey__step journey__step--ahead" type="button" aria-label="Move this project to Journey (4 of 4)" title="The journey begins — delivered, live, and looked after.">
          <span class="journey__marker" aria-hidden="true">4</span>
          <span class="journey__label">Journey</span>
        </button>
      </div>
      <div class="journey" role="group" aria-label="Project phase: Discovery, 1 of 4 on the journey">
        <span class="journey__step journey__step--current" aria-current="step" title="Learning your world — goals, audience, and what success looks like.">
          <span class="journey__marker" aria-hidden="true">1</span>
          <span class="journey__label">Discovery</span>
        </span>
        <span class="journey__leg" aria-hidden="true"></span>
        <span class="journey__step journey__step--ahead" title="Charting the course — scope, plan, and waypoints.">
          <span class="journey__marker" aria-hidden="true">2</span>
          <span class="journey__label">Chart</span>
        </span>
        <span class="journey__leg" aria-hidden="true"></span>
        <span class="journey__step journey__step--ahead" title="Making the trek — design and build, waypoint by waypoint.">
          <span class="journey__marker" aria-hidden="true">3</span>
          <span class="journey__label">Trek</span>
        </span>
        <span class="journey__leg" aria-hidden="true"></span>
        <span class="journey__step journey__step--ahead" title="The journey begins — delivered, live, and looked after.">
          <span class="journey__marker" aria-hidden="true">4</span>
          <span class="journey__label">Journey</span>
        </span>
      </div>`,
  },
  {
    name: 'whiteboard-row',
    from: 'whiteboard.js renderList() + renderEditor()',
    html: `
      <div class="panel">
        <div class="panel__head">
          <div><h2>Whiteboard</h2><p class="progress__label">Sketching space for this project.</p></div>
          <div class="page-head__actions">
            <button class="btn btn--small" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M5 12h14"/><path d="M12 5v14"/></svg> New board</button>
          </div>
        </div>
        <div class="link-list">
          <div class="link-row">
            <button class="link-row__main" type="button">
              <span class="link-row__title">Homepage sitemap and the second-pass navigation sketch</span>
              <span class="link-row__desc">Saved 10 minutes ago by Erin Wilson</span>
            </button>
            <div class="btn-row">
              <span class="pill pill--blue" title="The client can open this board and draw on it.">Client can draw</span>
              <button class="btn btn--ghost btn--small" type="button" aria-label="Settings for Homepage sitemap"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></button>
            </div>
          </div>
          <div class="link-row">
            <button class="link-row__main" type="button">
              <span class="link-row__title">Kickoff</span>
              <span class="link-row__desc">Not saved yet</span>
            </button>
            <div class="btn-row">
              <span class="pill" title="Nobody outside the studio can see this board.">Only us</span>
              <button class="btn btn--ghost btn--small" type="button" aria-label="Settings for Kickoff"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></button>
            </div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel__head">
          <div><h2>Homepage sitemap</h2><span class="progress__label">Saved just now by Trip</span></div>
          <div class="page-head__actions">
            <span class="pill pill--blue">Client can draw</span>
            <button class="btn btn--ghost btn--small" type="button">Settings</button>
            <button class="btn btn--ghost btn--small" type="button" title="Load the latest version of this board"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg> Refresh</button>
            <button class="btn btn--ghost btn--small" type="button" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg> Full screen</button>
            <button class="btn btn--ghost btn--small" type="button">Back to boards</button>
          </div>
        </div>
        <div class="whiteboard"><div class="whiteboard__canvas"><p class="skeleton">Loading the whiteboard…</p></div></div>
      </div>`,
  },
  {
    name: 'section-nav',
    from: 'project.js buildNav() — the nine entries a staff project page carries',
    html: `
      <nav class="section-nav scroll-fade is-fade-end" aria-label="On this page">
        <a class="section-nav__link is-on" href="#overview" aria-current="true">Overview</a>
        <a class="section-nav__link" href="#links">Links</a>
        <a class="section-nav__link" href="#team">Team</a>
        <a class="section-nav__link" href="#time">Time</a>
        <a class="section-nav__link" href="#waypoints">Waypoints</a>
        <a class="section-nav__link" href="#documents">Documents</a>
        <a class="section-nav__link" href="#messages">Messages</a>
        <a class="section-nav__link" href="#comments">Comments</a>
        <a class="section-nav__link" href="#tasks">Tasks</a>
      </nav>
      <div class="panel">
        <div class="panel__head"><div><h2>Overview</h2></div></div>
        <div class="progress"><div class="progress__track"><div class="progress__bar"></div></div>
        <p class="progress__label">2 of 14 waypoints reached</p></div>
      </div>`,
  },
  {
    name: 'form',
    from: "form-modal.js — el('div', { class: 'form-field' }, [label, control])",
    html: `
      <div class="panel">
        <h2>Add link</h2>
        <div class="form-field"><label class="form-field__label" for="f1">Title</label><input id="f1" type="text"></div>
        <div class="form-field"><label class="form-field__label" for="f2">URL</label><input id="f2" type="url"></div>
        <div class="form-field"><label class="form-field__label" for="f3">Kind</label>
          <select id="f3"><option>Design</option><option>Staging</option></select></div>
        <div class="form-field"><label class="form-field__label" for="f4">Notes</label><textarea id="f4" rows="3"></textarea></div>
        <div class="form-field"><label class="form-field__label" for="f5">Effective on</label><input id="f5" type="date"></div>
        <div class="btn-row">
          <button class="btn" type="submit">Add link</button>
          <button class="btn btn--ghost" type="button">Cancel</button>
        </div>
      </div>`,
  },
  {
    name: 'form-clearable',
    from: "ui.js formModal — field.clearable, as drives.js startDrive() uses it: "
        + 'a prefilled odometer with an ✕ overlaid inside the right edge',
    // The ✕ is absolutely positioned INSIDE the input, so it is the one
    // control on this screen whose 44px floor cannot come from the box it
    // sits in — it has to declare its own, and the glyph inside is 16px. The
    // input's padding-right is here for the same reason: a six-figure reading
    // must not run under the button.
    html: `
      <div class="panel">
        <h2>Start a drive</h2>
        <div class="form-field">
          <label class="form-field__label" for="c1">Odometer now</label>
          <div class="form-field__clearable">
            <input id="c1" type="text" inputmode="numeric" value="112,468">
            <button class="form-field__clear" type="button" aria-label="Clear Odometer now"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
          <span class="progress__label">Carried over from where your last drive finished. Check it against the dash — tap the ✕ if anything has been driven since.</span>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">Start the drive</button>
          <button class="btn btn--ghost" type="button">Cancel</button>
        </div>
      </div>`,
  },
  {
    name: 'form-groups',
    from: "ui.js formModal — the `groups` sections, as ledger-expenses.js "
        + 'expenseForm() builds them: two <details> under the six fields that '
        + 'are always on screen',
    // The summary is the tap target and has to reach 44px on its own — its
    // text is one line and would not. The note beside it is a sentence that
    // changes with the category, so it is here at its longest and wrapping:
    // nowrap there would set the summary's width and take a phone sideways,
    // which is the same lesson the expenses table's gaps pill carries.
    html: `
      <div class="panel">
        <h2>Record an expense</h2>
        <div class="form-field"><label class="form-field__label" for="g1">Amount</label><input id="g1" type="text" inputmode="decimal"></div>
        <div class="form-field"><label class="form-field__label" for="g2">Who it was paid to<span class="label-optional"> (optional)</span></label><input id="g2" type="text" list="g2-list">
          <datalist id="g2-list"><option value="Adobe"></option></datalist>
          <span class="progress__label">A name used before fills the category in for you. A new one is remembered, so the next time it does the same.</span></div>
        <details class="form-group" open>
          <summary><span>The who, what and where</span><span class="form-group__note">Cost of the work — 6070 Meals &amp; entertainment needs where it was, the business purpose, who was there.</span></summary>
          <div class="form-group__fields">
            <div class="form-field"><label class="form-field__label" for="g3">Where<span class="label-optional"> (optional)</span></label><input id="g3" type="text">
              <span class="progress__label">The restaurant, the city, the destination.</span></div>
            <div class="form-field"><label class="form-field__label" for="g4">Who you were with<span class="label-optional"> (optional)</span></label><input id="g4" type="text"></div>
          </div>
        </details>
        <details class="form-group">
          <summary><span>Client, billing and reference</span><span class="form-group__note">Whose job it was, and anything to quote back.</span></summary>
          <div class="form-group__fields">
            <div class="form-field"><label class="form-field__label" for="g5">For a client</label><select id="g5"><option>An overhead, not a job cost</option></select></div>
            <label class="check" for="g6"><input type="checkbox" id="g6">Meant to be billed back to them</label>
          </div>
        </details>
        <div class="btn-row">
          <button class="btn" type="submit">Record it</button>
          <button class="btn btn--ghost" type="button">Cancel</button>
        </div>
      </div>`,
  },
  {
    name: 'form-checkboxes',
    from: "ui.js formModal — the type: 'checkboxes' group (person-form.js Clients)",
    // Each box lives inside its own .check label, so the row is the target the
    // 44px floor is measured against — the same shape the single checkbox and
    // the checklist wear. The long client name is here for 320px: the label
    // must wrap rather than push the page sideways.
    html: `
      <div class="panel">
        <h2>Edit person</h2>
        <div class="form-field">
          <span class="form-field__label">Clients</span>
          <div class="check-group" role="group" aria-label="Clients">
            <label class="check"><input type="checkbox" name="client_ids" value="c-1" checked>Contrack Management, Inc.</label>
            <label class="check"><input type="checkbox" name="client_ids" value="c-2" checked>Dr. Moon + Associates</label>
            <label class="check"><input type="checkbox" name="client_ids" value="c-3">The Very Long Company Name That Has To Wrap Cleanly At Three Hundred And Twenty Pixels, LLC</label>
          </div>
          <span class="progress__label">Tick every client this login opens — one sign-in can hold several. A client account needs at least one; staff see every client and need none.</span>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">Save person</button>
          <button class="btn btn--ghost" type="button">Cancel</button>
        </div>
      </div>`,
  },
  {
    name: 'agreement-editor',
    from: "agreement-editor.js — sectionNode() and nodeRow()",
    // The <summary> is the tap target that opens a section, and it is the one
    // control on this screen whose height comes from CSS rather than from a
    // .btn class — which is exactly the kind of thing that measures 28px on a
    // phone and nobody notices. The textareas are here for the 16px floor: an
    // iOS zoom on a contract editor would be a bad afternoon.
    html: `
      <div class="panel">
        <h2>Edit the Master Services Agreement</h2>
        <p class="progress__label">2 of 71 passages differ from the v2 template.</p>
        <details class="agreement-section" open>
          <summary><span>10. Limitation of liability</span><span class="pill pill--blue">1 edited</span></summary>
          <div class="form-field agreement-edit agreement-edit--changed">
            <label for="a1">10.3 Elevated cap. <span class="pill pill--blue">Edited</span></label>
            <textarea id="a1" rows="4">For claims arising from a breach of Section 5 or Section 6.</textarea>
            <div class="btn-row">
              <button class="btn btn--ghost btn--tiny" type="button">Back to the template</button>
            </div>
          </div>
          <div class="form-field agreement-edit">
            <label for="a2">10.4 Outside every cap.</label>
            <textarea id="a2" rows="4">The limits in this Section do not apply to Client's obligation to pay.</textarea>
            <div class="btn-row"></div>
          </div>
        </details>
        <details class="agreement-section">
          <summary><span>11. Indemnification</span><span class="pill pill--blue" hidden></span></summary>
        </details>
        <div class="btn-row">
          <button class="btn" type="button">Save the edits</button>
          <button class="btn btn--danger btn--tiny" type="button">Revert the whole document</button>
          <button class="btn btn--ghost" type="button">Cancel</button>
        </div>
      </div>`,
  },
  {
    name: 'quick-add-fab',
    from: 'quick-add.js initQuickAdd() — the menu, open',
    // Transcribed from the real builder: item() emits a <button> carrying an
    // 18px-box svg then a bare text node, and the menu is a plain stack. Five
    // rows since the two ledger shortcuts landed, which is the reason this
    // fixture exists at all — every one of them is a tap target on a phone,
    // and the FAB had no gate coverage before.
    //
    // Rendered with [hidden] removed, because a hidden menu measures zero and
    // a fixture that measures nothing passes everything.
    html: `
      <div class="portal-fab">
        <div class="portal-fab__menu">
          <button class="portal-fab__action" type="button"><svg class="portal-fab__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v9"/><path d="M16 7v5"/></svg>Card on a board</button>
          <button class="portal-fab__action" type="button"><svg class="portal-fab__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/></svg>Note on a client</button>
          <button class="portal-fab__action" type="button"><svg class="portal-fab__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>Log a drive</button>
          <button class="portal-fab__action" type="button"><svg class="portal-fab__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/></svg>Log an expense</button>
          <button class="portal-fab__action" type="button"><svg class="portal-fab__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>Time on a project</button>
        </div>
        <button class="portal-fab__button" type="button" aria-expanded="true" aria-label="Quick add"><svg class="portal-fab__plus" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button>
      </div>`,
  },
  {
    name: 'install-hint',
    from: 'install-hint.js renderInstallHint()',
    // THIS FIXTURE WAS ONCE A LIE, and it is worth knowing how. The markup
    // below is transcribed by hand, so it describes what the function was
    // MEANT to emit — and on 2026-08-27 the function emitted the literal word
    // "null" beside this sentence on every iPhone, because it used the raw
    // .append() (which stringifies null) instead of mount() (which drops it).
    // The fixture was green throughout: not stale, just aspirational from
    // birth. Measuring is not the same as running the real function, and this
    // gate never runs one. The guard that actually holds that line is
    // tools/portal/nullable-append-guard.test.mjs.
    // The bar sits above someone's own work on every portal page, at every
    // width, so 320px is the case that matters: a long sentence, a button and a
    // dismiss all have to fit without pushing the page sideways. It wraps to
    // get there, which only works because .install-hint__text can shrink below
    // its content (min-width: 0) — the exact property whose absence turns a
    // flex row into a horizontal scrollbar.
    //
    // Both variants are here because they are different shapes: the iOS one is
    // pure text (no install API exists to call), the promptable one carries a
    // button. And .install-hint__close is a bare <button>, so it meets the 44px
    // floor from its own rule rather than inheriting .btn's.
    html: `
      <div class="install-hint">
        <svg class="install-hint__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
        <p class="install-hint__text">Add the portal to your home screen — it opens like an app, and it is the only way to get notifications on iPhone.<span class="install-hint__steps"> Tap Share, then "Add to Home Screen".</span></p>
        <button class="install-hint__close" type="button" aria-label="Dismiss"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <div class="install-hint">
        <svg class="install-hint__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
        <p class="install-hint__text">Install the portal and it opens like an app, with notifications when something needs you.</p>
        <button class="btn btn--small" type="button">Install</button>
        <button class="install-hint__close" type="button" aria-label="Dismiss"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>`,
  },
  {
    name: 'push-dialog',
    from: 'push.js openNotificationsDialog() + ui.js modalShell()',
    // The one control a client ever uses to turn notifications on, and it is
    // reached from a phone more often than from anything else. Transcribed with
    // the modal chrome around it because the dialog is what carries the width
    // at 320px, and .modal__close is the other 44px target on this screen.
    html: `
      <div class="modal">
        <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="gate-push-title" tabindex="-1">
          <div class="modal__head">
            <h2 id="gate-push-title">Notifications</h2>
            <button class="modal__close" type="button" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
          <div class="modal__body">
            <p class="notice notice--error" role="alert" hidden></p>
            <p class="push-dialog__status push-dialog__status--needs-install">Add the portal to your home screen first</p>
            <p class="push-dialog__body">On iPhone and iPad, notifications only work once the portal is installed. Tap the Share button, choose "Add to Home Screen", then open the portal from your home screen and come back here.</p>
            <p class="push-dialog__steps">Then open it from your home screen and come back to this screen.</p>
          </div>
          <div class="modal__foot">
            <button class="btn" type="button">Turn on notifications</button>
          </div>
        </div>
      </div>`,
  },
];

// Real pages, served from the repo. Higher fidelity than any fixture — this is
// the actual shipped markup — but limited to what renders without Supabase,
// which the container's proxy blocks. The login page is fully static and so is
// measured completely; the others render their shell and chrome only.
const PAGES = [
  { name: 'page-login', url: '/portal/index.html', full: true },
  { name: 'page-dashboard', url: '/portal/dashboard/index.html', full: false },
  { name: 'page-focus', url: '/portal/focus/index.html', full: false },
  { name: 'page-sign', url: '/portal/sign/index.html', full: false },
  { name: 'page-drives', url: '/portal/admin/ledger/drives/index.html', full: false },
  { name: 'page-home', url: '/index.html', full: true },
  // The other two shapes a topographic canvas sits in — .case-hero, which is
  // most of the site's page tops, and .page-simple. Both gained
  // position/overflow so the canvas has something to be absolute inside, and
  // an absolutely-positioned full-width child is exactly the thing that puts a
  // page into sideways scroll if it is ever sized wrong.
  { name: 'page-pricing', url: '/pricing/index.html', full: true },
  { name: 'page-404', url: '/404.html', full: true },
  // The experiments origin (experiments.newjourneydesigns.com) serves from
  // experiments/ — its pages use relative URLs precisely so they render the
  // same from the repo root here as from that origin's own root. No Supabase
  // anywhere on the lab bench, so both measure complete: the player's rows
  // render from playlist.json within the same 400ms wait the portal shells get.
  { name: 'page-experiments-hub', url: '/experiments/index.html', full: true },
  { name: 'page-experiments-player', url: '/experiments/mp3-player/index.html', full: true },
];

const WIDTHS = [
  ['iPhone SE', 320, true],
  ['iPhone 13', 390, true],
  ['tablet', 768, true],
  ['desktop', 1280, false],
];

function page(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${BASE}/css/styles.css">
<link rel="stylesheet" href="${BASE}/css/portal.css">
</head><body class="portal"><main class="portal-main"><div class="container" id="portal-root">
${body}
</div></main></body></html>`;
}

// Everything measured in one pass inside the page, so the numbers come from
// the browser's own layout rather than from anything this script believes.
const MEASURE = () => {
  const out = { scrolls: false, overflow: [], targets: [], inputs: [] };
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const coarse = matchMedia('(pointer: coarse)').matches;

  const describe = (n) => {
    const cls = typeof n.className === 'string' && n.className ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
    const txt = (n.textContent || '').trim().slice(0, 34);
    return `${n.tagName.toLowerCase()}${cls}${txt ? ` "${txt}"` : ''}`;
  };

  // Horizontal overflow is a property of the DOCUMENT, not of any one element.
  // Plenty of elements legitimately sit outside the viewport — the skip link
  // parked at -9999px, the spam honeypot, anything inside an SVG's viewBox
  // (clipped by the SVG, not by the page). Judging element-by-element reports
  // all of those as failures. So: the verdict is the document's own scrollWidth,
  // and the per-element list is only a diagnostic for explaining a real one.
  out.scrolls = doc.scrollWidth > vw + 0.5;
  if (out.scrolls) {
    for (const n of document.querySelectorAll('body *')) {
      if (n.closest('svg')) continue;                      // clipped by its viewBox
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'absolute') continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 0.5) {
        out.overflow.push({ el: describe(n), right: Math.round(r.right), vw });
      }
    }
  }

  const INTERACTIVE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]';
  for (const n of document.querySelectorAll(INTERACTIVE)) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right < 0 || r.bottom < 0) continue;             // parked off-screen on purpose

    // Two different floors, because they come from two different rules and
    // conflating them buries the real defects in a hundred false ones.
    //
    //   44px — this repo's own floor, from ARCHITECTURE and the UI spec. It is
    //          about a thumb finding a CONTROL: a button, a link dressed as a
    //          button, a form control, anything with a hit area of its own.
    //   24px — WCAG 2.2 SC 2.5.8 AA, which is what a plain text link must
    //          clear. The spec then exempts links sized by the line-height of
    //          the text around them, because making one 44px tall would wreck
    //          the paragraph it sits in.
    const looksLikeAControl = n.tagName !== 'A'
      || n.classList.contains('btn')
      || cs.backgroundImage !== 'none'
      || !['rgba(0, 0, 0, 0)', 'transparent'].includes(cs.backgroundColor)
      || parseFloat(cs.borderTopWidth) > 0;
    const sizedByItsLine = n.tagName === 'A' && cs.display.startsWith('inline');

    const floor = looksLikeAControl ? 43.5 : 23.5;
    const exempt = !looksLikeAControl && sizedByItsLine
      && Boolean(n.closest('p, li, td, figcaption, blockquote, h1, h2, h3'));

    // A checkbox or radio is deliberately not 44px — portal.css draws the box
    // at 22px and gives its *label* the height, because "every .check in the
    // portal is a <label>" and a 44px box would dwarf its own text (see the
    // coarse-pointer block in portal.css). That matches how WCAG 2.5.8
    // measures: the target is everything that activates the control, and
    // clicking anywhere in the label toggles the box. So a labelled box is
    // judged by its label's rect; only a bare, label-less one is judged alone.
    let hit = r;
    if (n.type === 'checkbox' || n.type === 'radio') {
      const label = n.closest('label')
        || (n.id ? document.querySelector(`label[for="${CSS.escape(n.id)}"]`) : null);
      if (label) hit = label.getBoundingClientRect();
    }

    if (coarse && !exempt && (hit.height < floor || hit.width < floor)) {
      out.targets.push({
        el: describe(n), w: Math.round(hit.width), h: Math.round(hit.height),
        floor: looksLikeAControl ? 44 : 24,
      });
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName) && n.type !== 'hidden') {
      const px = parseFloat(cs.fontSize);
      if (px < 15.99) out.inputs.push({ el: describe(n), px });
    }
  }
  return out;
};

// A focus ring is only meaningful if it CHANGES something. Compare computed
// outline+shadow before and after :focus-visible rather than trusting that a
// rule exists somewhere in 6,000 lines of CSS.
const FOCUS_PROBE = () => {
  const seen = [];
  const nodes = [...document.querySelectorAll('button, a[href], input, select, textarea')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width || r.height; })
    // A control inside a shut <details> still reports a rect in Chromium, and
    // focus() on something not revealed changes nothing — so every field in a
    // closed formModal section came back as "no ring". Nobody can focus it
    // until the section opens, and when it does it is an ordinary field again.
    .filter((n) => !n.closest('details:not([open])'));
  for (const n of nodes) {
    const before = getComputedStyle(n);
    const rest = `${before.outlineStyle}|${before.outlineWidth}|${before.outlineColor}|${before.boxShadow}`;
    n.focus();
    const after = getComputedStyle(n);
    const focused = `${after.outlineStyle}|${after.outlineWidth}|${after.outlineColor}|${after.boxShadow}`;
    n.blur();
    if (rest === focused) {
      const cls = typeof n.className === 'string' && n.className ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
      seen.push(`${n.tagName.toLowerCase()}${cls} "${(n.textContent || n.type || '').trim().slice(0, 30)}"`);
    }
  }
  return seen;
};

const browser = await launch();
let failures = 0;
const report = [];

const SUBJECTS = [
  ...FIXTURES.map((f) => ({ ...f, kind: 'fixture' })),
  ...PAGES.map((p) => ({ ...p, kind: 'page' })),
];

for (const s of SUBJECTS) {
  if (ONLY && s.name !== ONLY) continue;
  for (const [label, width, touch] of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 }, deviceScaleFactor: 2,
      hasTouch: touch, isMobile: touch,
    });
    const p = await ctx.newPage();

    if (s.kind === 'page') {
      // Supabase is unreachable here; the module scripts will throw. That is
      // expected and does not affect the static shell being measured, so the
      // wait is on 'load' rather than 'networkidle' and page errors are eaten.
      p.on('pageerror', () => {});
      await p.goto(`${BASE}${s.url}`, { waitUntil: 'load' });
      await p.waitForTimeout(400);
    } else {
      await p.setContent(page(s.html), { waitUntil: 'networkidle' });
    }

    const m = await p.evaluate(MEASURE);
    const noRing = await p.evaluate(FOCUS_PROBE);

    const bad = (m.scrolls ? 1 : 0) + m.targets.length + m.inputs.length;
    failures += bad;
    report.push({ fixture: s.name, from: s.from || s.url, label, width, ...m, noRing });

    if (SHOT) await p.screenshot({ path: `${HERE}/gate-${s.name}-${width}.png`, fullPage: true });
    await ctx.close();
  }
}
await browser.close();

for (const r of report) {
  const bad = (r.scrolls ? 1 : 0) + r.targets.length + r.inputs.length;
  console.log(`\n── ${r.fixture} @${r.width} (${r.label})${bad ? '' : '  ok'}`);
  if (r.scrolls) {
    console.log(`   SCROLLS   the document scrolls sideways at ${r.width}px. Widest offenders:`);
    for (const o of r.overflow.slice(0, 6)) console.log(`             ${o.el}  right=${o.right} > vw=${o.vw}`);
  }
  for (const t of r.targets) console.log(`   TARGET    ${t.el}  ${t.w}x${t.h} < ${t.floor}`);
  for (const i of r.inputs) console.log(`   IOSZOOM   ${i.el}  ${i.px}px < 16`);
  if (r.width === 1280 && r.noRing.length) {
    for (const f of r.noRing) console.log(`   NO-RING?  ${f}`);
  }
}
console.log(`\n${failures ? `FAIL — ${failures} violation(s)` : 'PASS — no overflow, no small targets, no zooming inputs'}`);
process.exit(failures ? 1 : 0);
