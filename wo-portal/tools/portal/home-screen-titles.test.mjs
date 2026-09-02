// ---------------------------------------------------------------------------
// Every portal page names itself for the home screen.
//
//   node --test tools/portal/home-screen-titles.test.mjs
//
// WHY THE TAG IS PER-PAGE
//
// On iOS, Add to Home Screen installs THE URL THAT IS ON SCREEN — not the
// manifest's start_url, which is what Android installs (ARCHITECTURE §9.10).
// That quirk is what makes several shortcuts possible from one app: add from
// /portal/admin/ledger/drives/ and the icon opens Drives, add from
// /portal/dashboard/ and it opens the Dashboard.
//
// What Safari pre-fills in the Add sheet is `apple-mobile-web-app-title`. With
// one shared value every shortcut arrived called "New Journey", so four icons
// meant four identical labels and the person renamed each one by hand. A
// page-specific tag pre-fills the right word instead.
//
// The two client-facing entry points keep the brand deliberately: a client
// installing the portal should get an icon that says who it is from, not one
// that says "Projects" among forty other apps.
//
// SHORT ON PURPOSE
//
// A home screen label truncates at roughly 12 characters, so these are names,
// not descriptions — "Scopes", not "Scopes of Work".
//
// ADD A LINE HERE WHENEVER YOU ADD A PORTAL PAGE. The same rule netlify.toml
// states for the force-404s, and for the same reason: this is a list a machine
// can hold and a person will forget. A new page with no entry fails here rather
// than shipping an icon called after whichever page it was copied from — which
// is the actual failure mode, since every portal page starts life as a copy.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORTAL = join(ROOT, 'portal');

/** The declared expectation, diffed against what the pages actually carry. */
const TITLES = {
  // The two a CLIENT installs. Brand, not function.
  'portal': 'New Journey',
  'portal/projects': 'New Journey',

  'portal/project': 'Project',
  'portal/focus': 'Focus',
  'portal/dashboard': 'Dashboard',
  'portal/inbox': 'Inbox',
  'portal/clients': 'Clients',
  'portal/client': 'Client',
  'portal/form-entries': 'Form Entries',
  'portal/whiteboards': 'Whiteboards',
  'portal/sign': 'Sign',

  'portal/admin': 'Admin',
  'portal/admin/sows': 'Scopes',
  'portal/admin/sow': 'Scope',
  'portal/admin/invoices': 'Invoices',
  'portal/admin/invoice': 'Invoice',
  'portal/admin/journey': 'Journey',

  'portal/admin/ledger': 'Ledger',
  'portal/admin/ledger/accounts': 'Accounts',
  'portal/admin/ledger/drives': 'Drives',
  'portal/admin/ledger/entries': 'Journal',
  'portal/admin/ledger/expenses': 'Expenses',
  'portal/admin/ledger/reconcile': 'Reconcile',
  'portal/admin/ledger/reports': 'Reports',
};

const TAG = /<meta name="apple-mobile-web-app-title" content="([^"]*)">/;

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

test('there are portal pages to check', () => {
  assert.ok(PAGES.length >= 20, `only found ${PAGES.length} portal pages`);
});

test('every portal page declares a home-screen title, and it is the declared one', () => {
  const wrong = [];

  for (const page of PAGES) {
    const key = relative(ROOT, dirname(page)).split('\\').join('/');
    const match = TAG.exec(readFileSync(page, 'utf8'));

    if (!match) { wrong.push(`${key}: no apple-mobile-web-app-title at all`); continue; }
    if (!(key in TITLES)) { wrong.push(`${key}: new page — add it to TITLES in this file`); continue; }
    if (match[1] !== TITLES[key]) wrong.push(`${key}: is "${match[1]}", expected "${TITLES[key]}"`);
  }

  assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}\n`);
});

test('the manifest lists no page that has since been deleted', () => {
  const live = new Set(PAGES.map((p) => relative(ROOT, dirname(p)).split('\\').join('/')));
  const stale = Object.keys(TITLES).filter((key) => !live.has(key));
  assert.deepEqual(stale, [], `TITLES names pages that no longer exist: ${stale.join(', ')}`);
});

test('the titles fit a home screen', () => {
  // Roughly where iOS starts truncating. Not a hard platform limit, so this is
  // a smell test rather than a rule — but "Scopes of Work" failing it is
  // exactly the catch that is wanted.
  const tooLong = Object.entries(TITLES).filter(([, title]) => title.length > 12);
  assert.deepEqual(tooLong, [], `these will be truncated on the home screen: ${JSON.stringify(tooLong)}`);
});

test('the client-facing entry points keep the brand', () => {
  // A client installing the portal gets an icon that says who it is from.
  // Renaming these to "Projects" would put an anonymous word on their phone.
  assert.equal(TITLES['portal'], 'New Journey');
  assert.equal(TITLES['portal/projects'], 'New Journey');
});

test('no two staff pages share a title', () => {
  // Two icons reading "Ledger" are two icons nobody can tell apart.
  const staff = Object.entries(TITLES).filter(([key]) => !['portal', 'portal/projects'].includes(key));
  const seen = new Map();
  const clashes = [];
  for (const [key, title] of staff) {
    if (seen.has(title)) clashes.push(`${title}: ${seen.get(title)} and ${key}`);
    seen.set(title, key);
  }
  assert.deepEqual(clashes, [], `\n  ${clashes.join('\n  ')}\n`);
});
