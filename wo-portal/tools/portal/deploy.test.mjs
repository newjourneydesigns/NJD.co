// ---------------------------------------------------------------------------
// The deploy configuration is code, and it fails silently.
//
// netlify.toml decides what this origin serves. Its worst failures are quiet
// ones: a document that should 404 gets served instead, a redirect without
// `force` never fires, a second CSP header appears and intersects with the
// first until a page is denied the host it needs. None of that shows up in a
// test suite that only imports modules, and none of it shows up in a browser
// until after a deploy.
//
// So: the publish directory is the web root, and every file in it that is not
// meant to be a public URL must be named by a rule here.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

/** The [[redirects]] blocks, parsed well enough to assert on. */
function redirects() {
  return toml.split('[[redirects]]').slice(1).map((block) => ({
    from: /from\s*=\s*"([^"]+)"/.exec(block)?.[1],
    to: /to\s*=\s*"([^"]+)"/.exec(block)?.[1],
    status: Number(/status\s*=\s*(\d+)/.exec(block)?.[1]),
    force: /force\s*=\s*true/.test(block),
  }));
}

/** Does any rule 404 this path? A splat matches the rest of a path. */
function blocked(path) {
  return redirects().some((r) => {
    if (r.status !== 404 || !r.force) return false;
    if (r.from === path) return true;
    if (r.from.endsWith('/*')) return path.startsWith(r.from.slice(0, -1));
    return false;
  });
}

test('nothing but the portal is served from the web root', () => {
  // Everything at the top of the publish directory that a browser could ask
  // for. The four that ARE public: the portal, its assets, and the 404 page.
  const PUBLIC = new Set(['portal', 'assets', 'css', 'js', '404.html']);
  const entries = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules');

  for (const entry of entries) {
    if (PUBLIC.has(entry.name)) continue;
    const path = entry.isDirectory() ? `/${entry.name}/x` : `/${entry.name}`;
    assert.ok(
      blocked(path),
      `${entry.name} sits in the web root and no force-404 rule covers it. `
      + 'Add one to netlify.toml, or it is a public URL the moment this deploys.',
    );
  }
});

test('the operator\'s rulebook and recipes are not public', () => {
  // Named explicitly as well as covered by the sweep above: these describe how
  // the portal works and who can do what, and the sweep only catches them
  // while they happen to live at the root.
  assert.ok(blocked('/CLAUDE.md'), 'CLAUDE.md must 404');
  assert.ok(blocked('/.claude/skills/portal-ops/SKILL.md'), '.claude/* must 404');
  assert.ok(blocked('/supabase/schema.sql'), 'the schema must 404');
  assert.ok(blocked('/tools/portal/stub-client.js'), 'the harness must 404');
});

test('every 404 rule forces, or it does nothing at all', () => {
  // Without force = true Netlify serves an existing static file and never
  // consults the redirect — which is exactly the case these rules are for.
  for (const r of redirects()) {
    if (r.status === 404) {
      assert.ok(r.force, `${r.from} is a 404 rule without force = true, so it will never fire`);
    }
  }
});

test('the 404 page a rule points at exists', () => {
  for (const r of redirects()) {
    if (r.status === 404) assert.equal(r.to, '/404.html');
  }
  assert.ok(existsSync(join(ROOT, '404.html')), '404.html is missing');
});

test('the root sends people to the portal', () => {
  const root = redirects().find((r) => r.from === '/');
  assert.ok(root, 'no rule for /');
  assert.equal(root.to, '/portal/');
  assert.equal(root.status, 301);
});

test('exactly one Content-Security-Policy, and it is strict', () => {
  const policies = [...toml.matchAll(/Content-Security-Policy\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(policies.length, 1,
    'two CSP headers that both match a request apply as an intersection, and the '
    + 'failure only shows up in production');

  const csp = policies[0];
  assert.match(csp, /script-src 'self'/, 'scripts from this origin only');
  assert.ok(!csp.includes('unsafe-inline'), 'no unsafe-inline anywhere');
  assert.ok(!csp.includes('unsafe-eval'), 'no unsafe-eval anywhere');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);

  // connect-src must name the project the code actually talks to.
  const config = readFileSync(join(ROOT, 'js/portal/config.js'), 'utf8');
  const host = /SUPABASE_URL\s*=\s*'https:\/\/([^']+)'/.exec(config)?.[1];
  assert.ok(host, 'could not read SUPABASE_URL from config.js');
  assert.ok(csp.includes(host),
    `connect-src does not name ${host}, so every request the portal makes would be blocked`);
});

test('the portal is never cached, and never indexed', () => {
  const block = /\[\[headers\]\][\s\S]*?for = "\/portal\/\*"[\s\S]*?(?=\n\[\[|$)/.exec(toml)?.[0];
  assert.ok(block, 'no headers rule for /portal/*');
  assert.match(block, /Cache-Control = "no-store"/,
    'a portal page is a shell around one person\'s data');
  assert.match(toml, /X-Robots-Tag = "noindex, nofollow"/);
});

test('there is no build step to break', () => {
  assert.match(toml, /command = ""/, 'the portal has no build; an empty command says so');
  assert.match(toml, /publish = "\."/);
  assert.ok(!existsSync(join(ROOT, 'package.json')),
    'a package.json here would make Netlify try to install and build something');
});
