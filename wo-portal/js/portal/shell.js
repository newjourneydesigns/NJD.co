// ---------------------------------------------------------------------------
// Page bootstrap: configuration check, auth gate, header chrome, role gate.
//
// Every portal page starts with:
//
//   const ctx = await bootstrap();
//   if (!ctx) return;           // a gate already rendered an explanation
//
// ctx is { session, profile, isAdmin }.
// ---------------------------------------------------------------------------

import { supabase, isConfigured, sdkMissing, getSession, getProfile, signOut, isAdmin, errorMessage } from './client.js';
import { SUPPORT_EMAIL, BOARDS_BASE_URL } from './config.js';
import { el, mount, byId, formModal, toast } from './ui.js';
import { icon } from './icons.js';
import { createSearch } from './search.js';
import { initQuickAdd } from './quick-add.js';
import { openNotificationsDialog, syncSubscription, forgetThisDevice } from './push.js';
import { renderInstallHint } from './install-hint.js';

const MIN_PASSWORD = 10;

/**
 * Change your own password.
 *
 * The current password is asked for and checked even though Supabase does not
 * require it. Without that, an unlocked laptop is enough for a passer-by to
 * change the password and lock the owner out of their own portal — and since
 * this is the one place a client can lock themselves out, it is worth the extra
 * field. signInWithPassword is the check: it either confirms the old password
 * or it does not, and the session it returns is the same one we already hold.
 */
async function openChangePassword() {
  const session = await getSession();
  const email = session && session.user && session.user.email;
  if (!email) {
    toast('Your session has expired. Sign in again.', 'error');
    return;
  }

  const result = await formModal({
    title: 'Change your password',
    submitLabel: 'Change password',
    intro: 'You stay signed in here. Anywhere else you are signed in stays '
         + 'signed in until that session expires.',
    fields: [
      {
        name: 'current',
        label: 'Current password',
        type: 'password',
        required: true,
        autocomplete: 'current-password',
      },
      {
        name: 'next',
        label: 'New password',
        type: 'password',
        required: true,
        autocomplete: 'new-password',
        hint: `At least ${MIN_PASSWORD} characters.`,
      },
      {
        name: 'confirm',
        label: 'New password again',
        type: 'password',
        required: true,
        autocomplete: 'new-password',
      },
    ],
    onSubmit: async (values) => {
      if (values.next.length < MIN_PASSWORD) {
        throw new Error(`Your new password must be at least ${MIN_PASSWORD} characters.`);
      }
      if (values.next !== values.confirm) {
        throw new Error('The two new passwords do not match.');
      }
      if (values.next === values.current) {
        throw new Error('That is already your password. Pick a different one.');
      }

      const { error: wrong } = await supabase.auth.signInWithPassword({
        email,
        password: values.current,
      });
      if (wrong) throw new Error('That is not your current password.');

      const { error } = await supabase.auth.updateUser({ password: values.next });
      if (error) throw new Error(errorMessage(error, 'We could not change your password.'));
    },
  });

  if (result) toast('Password changed.', 'ok');
}

function root() {
  return byId('portal-root');
}

/**
 * Which menu link describes the page being looked at. Prefix matching, most
 * specific first: /portal/admin/sow… is SOWs, not Admin, and the detail pages
 * belong to the list they were opened from even though their paths never say
 * "projects" or "clients".
 *
 * Two pairs differ by one letter, and the trailing slash is what keeps each
 * apart — '/portal/clients/' does not start with '/portal/client/', and
 * '/portal/projects/' does not start with '/portal/project/'.
 */
function isCurrent(href) {
  const path = window.location.pathname;
  const inSows = path.startsWith('/portal/admin/sow');
  const inInvoices = path.startsWith('/portal/admin/invoice');
  const inLedger = path.startsWith('/portal/admin/ledger');
  if (href === '/portal/admin/sows/') return inSows;
  if (href === '/portal/admin/invoices/') return inInvoices;
  if (href === '/portal/admin/ledger/') return inLedger;
  if (href === '/portal/admin/') {
    return path.startsWith('/portal/admin/') && !inSows && !inInvoices && !inLedger;
  }
  if (href === '/portal/clients/') {
    return path.startsWith('/portal/clients/') || path.startsWith('/portal/client/');
  }
  if (href === '/portal/projects/') {
    return path.startsWith('/portal/projects/') || path.startsWith('/portal/project/');
  }
  return path.startsWith(href);
}

/** The bell, drawn rather than typed — the Lucide "bell" paths inlined the
 *  same way search.js inlines its magnifier, so the portal still ships no
 *  icon set. An emoji flattened by CSS filters sat here before, and it was
 *  a different shape and weight on every platform; the SVG inherits
 *  currentColor and matches the hamburger beside it everywhere. */
function bellIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'portal-bell__glyph');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const clapper = document.createElementNS(NS, 'path');
  clapper.setAttribute('d', 'M10.268 21a2 2 0 0 0 3.464 0');

  const body = document.createElementNS(NS, 'path');
  body.setAttribute('d', 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326');

  svg.append(clapper, body);
  return svg;
}

/**
 * The whole nav lives behind one hamburger button, at every width. Six items
 * were wrapping the sticky header to three rows on a phone, and a menu that
 * exists on desktop too means there is exactly one navigation to learn. It is
 * also what lets the staff list grow without the header caring.
 *
 * The order is the order of a job, not the alphabet — and the menu is
 * segmented along the same seams, because eleven staff items in one flat run
 * made every glance a re-read. Three labelled runs of destinations: the state
 * of the business and what needs you (Your day), the work and who it is for
 * (The work), what was quoted, billed and accounted for (The money). Below
 * them, on the canvas tint so it reads as a different kind of thing, the card
 * of what you touch least: Admin, Profile, Sign out.
 *
 * The labels render for staff only. A client's menu is three items; headers
 * over three items are furniture.
 *
 * The panel is a dropdown, not a full-screen takeover: Escape closes it, the
 * scrim closes it, opening returns focus to the button when it shuts, and the
 * page keeps scrolling underneath — it is a menu, not a mode.
 *
 * Between the brand and the button sits the search field (js/portal/search.js),
 * so the first thing on screen after signing in is the box that finds anything.
 * It is left out for an account with nothing to search — a client whose profile
 * is not linked to anything yet gets the "almost there" screen, and a search
 * box over it would return nothing however it was used.
 */
function renderNav(profile, { withSearch = true } = {}) {
  const nav = byId('portal-nav');
  if (!nav) return;

  const admin = isAdmin(profile);

  const groups = [];
  if (admin) {
    groups.push({
      id: 'portal-menu-day',
      label: 'Your day',
      links: [
        // Focus is the staff home (it replaced the Dashboard as the landing
        // on 2026-08-23, as the Dashboard once replaced Today): your own day
        // first — starred cards, overdue, due today, done today — with the
        // business chase-downs and the pipeline under it.
        { href: '/portal/focus/', label: 'Focus' },
        // The Dashboard keeps the full picture: figures, boards, projects,
        // notes, activity, the whole book at a glance.
        { href: '/portal/dashboard/', label: 'Dashboard' },
        // Inbox after them: all three answer "what needs me", and the bell
        // in the bar points here too.
        { href: '/portal/inbox/', label: 'Inbox' },
        // Boards lives on its own origin with its own session, so this one
        // leaves the portal — a new tab, like every boards link here. Staff
        // only: clients cannot sign in over there at all.
        { href: BOARDS_BASE_URL, label: 'Boards', external: true },
      ],
    });
    groups.push({
      id: 'portal-menu-work',
      label: 'The work',
      links: [
        { href: '/portal/projects/', label: 'Projects' },
        // Clients and Form Entries are top-level rather than panels inside
        // Admin. They are the two most-visited staff tables, and burying the
        // list you look something up in behind a page about accounts and
        // templates made every lookup a scroll past things nobody came for.
        { href: '/portal/clients/', label: 'Clients' },
        { href: '/portal/form-entries/', label: 'Form Entries' },
        // The studio's own whiteboards. A board that belongs to a client or a
        // project lives on that page, with the rest of that work; this is only
        // the ones attached to nothing.
        { href: '/portal/whiteboards/', label: 'Whiteboards' },
      ],
    });
    groups.push({
      id: 'portal-menu-money',
      label: 'The money',
      links: [
        // SOWs first because that is where the money starts: one is usually
        // written straight off a discovery call, and one that takes three
        // navigations to start is one that gets written in Word instead.
        { href: '/portal/admin/sows/', label: 'SOWs' },
        // Then Invoices, because that is where an invoice comes from — and
        // then Ledger, because that is the order the money moves: quote it,
        // bill it, then account for it.
        { href: '/portal/admin/invoices/', label: 'Invoices' },
        { href: '/portal/admin/ledger/', label: 'Ledger' },
      ],
    });
  } else {
    groups.push({
      id: 'portal-menu-work',
      label: null,
      links: [{ href: '/portal/projects/', label: 'Projects' }],
    });
  }

  const button = el('button', {
    class: 'portal-menu__button',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'portal-menu',
    'aria-label': 'Menu',
  }, [
    el('span', { class: 'portal-menu__bar', 'aria-hidden': 'true' }),
    el('span', { class: 'portal-menu__bar', 'aria-hidden': 'true' }),
    el('span', { class: 'portal-menu__bar', 'aria-hidden': 'true' }),
  ]);

  const scrim = el('div', { class: 'portal-menu__scrim', hidden: true });

  const item = (link) => el('a', {
    class: 'portal-menu__item',
    href: link.href,
    target: link.external ? '_blank' : null,
    rel: link.external ? 'noopener' : null,
    'aria-current': isCurrent(link.href) ? 'page' : null,
  }, [
    link.label,
    // The same mark the project page's "Open board" button carries: this one
    // leaves the portal.
    link.external ? icon('external-link', { size: 14, className: 'portal-menu__ext' }) : null,
  ]);

  const panel = el('nav', {
    class: 'portal-menu__panel',
    id: 'portal-menu',
    hidden: true,
    'aria-label': 'Portal',
  }, [
    // The signed-in address lives here now rather than in the bar: reference
    // information belongs one tap away, not in every screen's sticky header.
    el('p', { class: 'portal-menu__who', text: profile.email || '' }),
    ...groups.map((group) => el('div', {
      class: 'portal-menu__group',
      // The heading is visible text, so the group borrows it by id rather
      // than repeating it in an aria-label a screen reader would hear twice.
      role: group.label ? 'group' : null,
      'aria-labelledby': group.label ? group.id : null,
    }, [
      group.label ? el('p', { class: 'portal-menu__label', id: group.id, text: group.label }) : null,
      ...group.links.map(item),
    ])),
    el('div', {
      class: 'portal-menu__group portal-menu__group--foot',
      role: 'group',
      'aria-label': 'Account',
    }, [
      admin ? item({ href: '/portal/admin/', label: 'Admin' }) : null,
      // Every role, on every page, because this is a setting that belongs to
      // the DEVICE rather than to the account — the answer is different on
      // your phone and your laptop, and the place to change it has to be
      // wherever you happen to be standing. It is deliberately not buried in
      // Admin beside the email preferences: a client cannot reach Admin at
      // all, and it is a client's phone this matters most on.
      el('button', {
        class: 'portal-menu__item',
        type: 'button',
        text: 'Notifications',
        onclick: () => {
          close();
          openNotificationsDialog();
        },
      }),
      // Named for what it opens. It said "Profile", and the dialog behind it is
      // three password fields — there is no profile to edit here.
      el('button', {
        class: 'portal-menu__item',
        type: 'button',
        text: 'Change password',
        onclick: () => {
          close();
          openChangePassword();
        },
      }),
      el('button', {
        class: 'portal-menu__item portal-menu__item--signout',
        type: 'button',
        text: 'Sign out',
        // The device's notifications go with the session. A push subscription
        // belongs to the browser and outlives signing out, so without this the
        // next person to pick up a shared phone would get the last person's
        // alerts — on a lock screen, without signing in at all. Awaited so the
        // row is deleted while the session that is allowed to delete it still
        // exists; it never throws and never blocks the sign-out.
        onclick: async () => {
          await forgetThisDevice();
          signOut();
        },
      }),
    ]),
  ]);

  const search = withSearch ? createSearch({ isAdmin: admin }) : null;

  // The bell — staff only, since every notification producer targets staff.
  // The count itself arrives via initInboxBadge once bootstrap has a session.
  const bell = admin
    ? el('a', { class: 'portal-bell', href: '/portal/inbox/', 'aria-label': 'Inbox' }, [
        bellIcon(),
        el('span', { class: 'portal-bell__badge', id: 'portal-bell-badge', hidden: true }),
      ])
    : null;

  let isOpen = false;

  function onKeydown(event) {
    if (event.key === 'Escape') {
      close();
      button.focus();
    }
  }

  function open() {
    if (isOpen) return;
    // Two dropdowns hanging off the same bar is one too many.
    if (search) search.close();
    isOpen = true;
    panel.hidden = false;
    scrim.hidden = false;
    button.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    scrim.hidden = true;
    button.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
  }

  button.addEventListener('click', () => (isOpen ? close() : open()));
  scrim.addEventListener('click', () => close());

  mount(nav,
    // The brand goes home, and home depends on who you are: staff to Focus,
    // a client straight to their projects rather than through Focus's
    // redirect.
    el('a', {
      class: 'portal-header__brand',
      href: isAdmin(profile) ? '/portal/focus/' : '/portal/projects/',
    }, [
      el('img', { src: '/assets/img/njd-icon.png', alt: 'New Journey Designs', width: '34', height: '34' }),
      el('span', { class: 'portal-header__label', text: 'Client Portal' }),
    ]),
    search ? search.node : null,
    bell,
    button,
    scrim,
    panel,
  );

  trackHeaderHeight();
}

/**
 * Publish the sticky header's real height as --portal-header-h, so anything
 * else that pins itself (the project page's tab bar, the client page's
 * section nav) can sit exactly under it. Measured rather than hard-coded
 * because the header wraps taller on a narrow phone.
 */
function trackHeaderHeight() {
  const header = document.querySelector('.portal-header');
  if (!header) return;

  const apply = () => {
    document.documentElement.style.setProperty(
      '--portal-header-h',
      `${Math.ceil(header.getBoundingClientRect().height)}px`,
    );
  };

  apply();
  window.addEventListener('resize', apply);
}

/**
 * The unread count on the bell, kept live. One head-count query on page load,
 * then a realtime subscription on this person's notification rows recounts on
 * any change — a new alert, a mark-read in another tab, an archive here.
 * RLS already scopes the count; the filter just keeps the channel quiet.
 *
 * The same count drives the app-icon badge where the portal is installed to
 * a home screen (the Badging API — Chromium, and iOS 16.4+ home-screen
 * apps). Feature-detected and fire-and-forget: in a plain tab the calls are
 * absent or refused, and a badge is never worth an error state.
 */
function initInboxBadge(profile) {
  const badge = byId('portal-bell-badge');
  if (!badge) return;

  function setAppBadge(unread) {
    if (typeof navigator.setAppBadge !== 'function') return;
    const call = unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge();
    if (call && call.catch) call.catch(() => {});
  }

  async function refresh() {
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
      .is('archived_at', null);
    if (error) return; // a badge is not worth an error state
    const unread = count || 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
    setAppBadge(unread);
  }

  refresh();

  supabase
    .channel(`inbox-badge:${profile.id}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${profile.id}`,
    }, refresh)
    .subscribe();
}

function renderBrandOnly() {
  const nav = byId('portal-nav');
  if (!nav) return;
  mount(nav,
    el('a', { class: 'portal-header__brand', href: '/' }, [
      el('img', { src: '/assets/img/njd-icon.png', alt: 'New Journey Designs', width: '34', height: '34' }),
      el('span', { class: 'portal-header__label', text: 'Client Portal' }),
    ]),
  );
}

export function renderSetupNotice(target = root()) {
  if (!target) return;
  mount(target,
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Portal not configured yet' }),
      el('p', {
        text: 'Add your Supabase project URL and anon key to js/portal/config.js, '
            + 'and run supabase/schema.sql in the Supabase SQL editor. '
            + 'Setup steps are in the README.',
      }),
    ]),
  );
}

function renderNoAccess(profile) {
  mount(root(),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Almost there' }),
      el('p', {
        text: `You are signed in as ${profile.email}, but this account is not linked `
            + 'to a project yet. Once we connect it, your waypoints, documents and '
            + 'messages will show up here.',
      }),
      el('p', {}, [
        'Email us at ',
        el('a', { href: `mailto:${SUPPORT_EMAIL}`, text: SUPPORT_EMAIL }),
        ' and we will finish the setup.',
      ]),
    ]),
  );
}

function renderForbidden() {
  mount(root(),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Not available' }),
      el('p', { text: 'This page is for New Journey Designs staff.' }),
      el('p', {}, [el('a', { class: 'btn btn--ghost btn--small', href: '/portal/projects/', text: 'Back to your projects' })]),
    ]),
  );
}

export function renderSdkMissing(target = root()) {
  if (!target) return;
  mount(target,
    el('div', { class: 'panel' }, [
      el('h1', { text: 'The portal could not start' }),
      el('p', {
        text: 'The Supabase client script did not load, so nothing on this page '
            + 'can talk to the server.',
      }),
      el('p', { class: 'notice notice--error' }, [
        'Check that ',
        el('strong', { text: 'js/vendor/supabase-2.111.0.js' }),
        ' is deployed and that this page loads it before its module script.',
      ]),
    ]),
  );
}

export function renderError(error) {
  mount(root(),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Something went wrong' }),
      el('p', { class: 'notice notice--error', text: errorMessage(error) }),
      el('p', {}, [el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Reload', onclick: () => window.location.reload() })]),
    ]),
  );
}

export async function bootstrap({ requireAdmin = false } = {}) {
  if (!isConfigured) {
    renderBrandOnly();
    renderSetupNotice();
    return null;
  }

  if (sdkMissing) {
    renderBrandOnly();
    renderSdkMissing();
    return null;
  }

  let session;
  try {
    session = await getSession();
  } catch (error) {
    renderBrandOnly();
    renderError(error);
    return null;
  }

  if (!session) {
    const next = window.location.pathname + window.location.search;
    window.location.replace(`/portal/?next=${encodeURIComponent(next)}`);
    return null;
  }

  let profile;
  try {
    profile = await getProfile();
  } catch (error) {
    renderBrandOnly();
    renderError(error);
    return null;
  }

  const admin = isAdmin(profile);

  // A home client on the profile is the common case; a login whose access is
  // only membership rows (home cleared later, profile_clients kept) must not
  // hit the no-access wall. Asked only when it would decide anything — one
  // read, own rows only under RLS.
  let hasClientAccess = Boolean(profile.client_id);
  if (!admin && !hasClientAccess) {
    const { data } = await supabase.from('profile_clients').select('client_id').limit(1);
    hasClientAccess = Boolean(data && data.length);
  }

  renderNav(profile, { withSearch: admin || hasClientAccess });

  if (!admin && !hasClientAccess) {
    renderNoAccess(profile);
    return null;
  }

  if (requireAdmin && !admin) {
    renderForbidden();
    return null;
  }

  // A token that expires or a sign-out in another tab should not leave a stale
  // page showing another account's data.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('/portal/');
  });

  if (admin) initInboxBadge(profile);

  // Staff only, on every staff screen: a note on a client or a card on a board
  // from wherever you happen to be standing (js/portal/quick-add.js). A page
  // that knows whose record is open refines it with setQuickAddContext().
  if (admin) initQuickAdd(profile);

  // Both are quiet by design and neither is awaited: the page is already usable
  // and neither has anything to say on the common path.
  //
  // syncSubscription re-points this browser's push subscription at whoever is
  // signed in NOW — a subscription belongs to the browser, so on a shared
  // machine it would otherwise keep ringing for the last person. It never asks
  // for permission; somebody who has not opted in sees nothing.
  syncSubscription();
  // And the offer, for a browser that could install the portal and has not.
  renderInstallHint();

  return { session, profile, isAdmin: admin };
}
