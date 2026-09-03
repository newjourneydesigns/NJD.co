// ---------------------------------------------------------------------------
// Every portal page names itself for the home screen.
//
//   node --test tools/portal/home-screen-titles.test.mjs
//
// WHY THE TAG IS PER-PAGE
//
// On iOS, Add to Home Screen installs THE URL THAT IS ON SCREEN — not the
// manifest's start_url, which is what Android installs. That quirk is what
// makes several shortcuts possible from one app: add from /portal/expenses/
// and the icon opens Expenses, add from /portal/dashboard/ and it opens the
// Dashboard.
//
// What Safari pre-fills in the Add sheet is `apple-mobile-web-app-title`. With
// one shared value every shortcut arrives with the same label and the person
// renames each one by hand. A page-specific tag pre-fills the right word.
//
// The login page keeps the brand deliberately: installing the portal from its
// front door should give an icon that says what it is, not "Sign in".
//
// SHORT ON PURPOSE
//
// A home screen label truncates at roughly 12 characters, so these are names,
// not descriptions.
//
// ADD A LINE HERE WHENEVER YOU ADD A PORTAL PAGE. The same rule netlify.toml
// states for the force-404s, and for the same reason: this is a list a machine
// can hold and a person will forget. A new page with no entry fails here rather
// than shipping an icon called after whichever page it was copied from — which
// is the actual failure mode, since every portal page starts life as a copy.
//
// A page that still carries the scaffold's title (copied from the NJD portal,
// not yet rebranded) is not a page yet: it is reported and skipped, so this
// passes while the pages are being built and holds them once they land. The
// mark of a landed page is the business name in its <title>.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORTAL = join(ROOT, 'portal');

const BRAND = 'Walter Ochenski LLC';

/** The declared expectation — the contract's APPTITLE list — diffed against
 *  what the pages actually carry. */
const TITLES = {
  // The front door. Brand, not function.
  'portal': 'WO Portal',

  'portal/dashboard': 'Dashboard',
  'portal/clients': 'Clients',
  'portal/client': 'Client',
  'portal/invoices': 'Invoices',
  'portal/invoice': 'Invoice',
  'portal/expenses': 'Expenses',
  'portal/reports': 'Reports',
  'portal/admin': 'Admin',
};

const TAG = /<meta name="apple-mobile-web-app-title" content="([^"]*)">/;
const TITLE = /<title>([^<]*)<\/title>/;

/** Every index.html under portal/, as repo-relative directory keys. */
function portalPages(dir = PORTAL, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) portalPages(path, found);
    else if (entry === 'index.html') found.push(path);
  }
  return found;
}

const PAGES = portalPages();

function keyOf(page) {
  return relative(ROOT, dirname(page)).split('\\').join('/');
}

/** A page has landed once its <title> names the business. */
function landed(source) {
  const match = TITLE.exec(source);
  return Boolean(match && match[1].includes(BRAND));
}

test('there are portal pages to check', () => {
  assert.ok(PAGES.length >= 1, `only found ${PAGES.length} portal pages`);
});

test('every landed portal page declares a home-screen title, and it is the declared one', (t) => {
  const wrong = [];
  const pending = [];

  for (const page of PAGES) {
    const key = keyOf(page);
    const source = readFileSync(page, 'utf8');

    if (!landed(source)) { pending.push(key); continue; }

    const match = TAG.exec(source);
    if (!match) { wrong.push(`${key}: no apple-mobile-web-app-title at all`); continue; }
    if (!(key in TITLES)) { wrong.push(`${key}: new page — add it to TITLES in this file`); continue; }
    if (match[1] !== TITLES[key]) wrong.push(`${key}: is "${match[1]}", expected "${TITLES[key]}"`);
  }

  if (pending.length) {
    t.diagnostic(`not yet rebranded, skipped: ${pending.join(', ')}`);
  }

  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('every landed page names the business in its <title>', () => {
  // The other half of "landed": a page whose title says the business name
  // but spells it the way the dictation did is not rebranded either.
  const misspelt = PAGES
    .map((page) => [keyOf(page), readFileSync(page, 'utf8')])
    .filter(([, source]) => /Oshinsky/.test(source))
    .map(([key]) => key);
  assert.deepEqual(misspelt, [], `the name is Ochenski: ${misspelt.join(', ')}`);
});

test('TITLES names only pages that exist', () => {
  // A page can be listed before it is rebranded, but not before it exists:
  // an entry for a directory that is not there is a typo in this file.
  const missing = Object.keys(TITLES).filter((key) => !existsSync(join(ROOT, key, 'index.html')));
  assert.deepEqual(missing, [], `TITLES names pages that do not exist: ${missing.join(', ')}`);
});

test('the titles fit a home screen', () => {
  // Roughly where iOS starts truncating. Not a hard platform limit, so this is
  // a smell test rather than a rule.
  const tooLong = Object.entries(TITLES).filter(([, title]) => title.length > 12);
  assert.deepEqual(tooLong, [], `these will be truncated on the home screen: ${JSON.stringify(tooLong)}`);
});

test('the front door keeps the brand', () => {
  assert.equal(TITLES['portal'], 'WO Portal');
});

test('no two pages share a title', () => {
  // Two icons reading "Invoices" are two icons nobody can tell apart.
  const seen = new Map();
  const clashes = [];
  for (const [key, title] of Object.entries(TITLES)) {
    if (seen.has(title)) clashes.push(`${title}: ${seen.get(title)} and ${key}`);
    seen.set(title, key);
  }
  assert.deepEqual(clashes, [], `\n  ${clashes.join('\n  ')}\n`);
});

test('the manifest and the login page agree on the brand', () => {
  const manifest = JSON.parse(readFileSync(join(PORTAL, 'site.webmanifest'), 'utf8'));
  assert.equal(manifest.short_name, 'WO Portal');
  assert.equal(manifest.name, `${BRAND} — Portal`);
  assert.equal(manifest.start_url, '/portal/');
  assert.equal(manifest.scope, '/portal/');
  assert.equal(manifest.theme_color, '#FF5100');
  assert.equal(manifest.background_color, '#FFFFFF');
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/assets\/img\/wo-app-icon-/, `icon ${icon.src} is not one of ours`);
  }
});
