# Vendored dependencies

## supabase-2.111.0.js

The Supabase JavaScript client, self-hosted rather than pulled from a CDN.

`dist/umd/supabase.js` copied verbatim out of the published npm tarball:

```
npm pack @supabase/supabase-js@2.111.0
tar xzf supabase-supabase-js-2.111.0.tgz package/dist/umd/supabase.js
cp package/dist/umd/supabase.js js/vendor/supabase-2.111.0.js
```

It defines a single global, `window.supabase`, and is loaded by a plain
`<script>` tag ahead of the portal's module entry point on each portal page.

### Why it is vendored instead of loaded from jsDelivr

The portal used to import this from a CDN. When the CDN is unreachable — a
corporate network that blocks it, an aggressive extension, a regional block, or
simply an outage — the import fails, the whole module graph fails with it, and
the client sees a blank white page with no explanation. For a page a paying
client signs in to, that is the worst available failure mode. Self-hosting
means the portal is up exactly when the rest of the site is up, and it lets the
Content-Security-Policy drop the CDN from `script-src` entirely.

### Upgrading

Repeat the commands above with the new version, commit the new file under its
own version-stamped name, delete the old one, and update the `<script src>` in
all four `portal/*/index.html` pages plus `SUPABASE_SDK_VERSION` in
`js/portal/config.js`. Read the supabase-js release notes first — this is a
client library holding an auth session, so a major bump deserves a real test
pass against a staging Supabase project.
