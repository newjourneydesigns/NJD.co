// ---------------------------------------------------------------------------
// Page bootstrap: configuration check, auth gate, header chrome, role gate.
//
// Every portal page starts with:
//
//   const ctx = await bootstrap({ requireAdmin: true });
//   if (!ctx) return;           // a gate already rendered an explanation
//
// ctx is { session, profile, isAdmin, isOwner }. isAdmin means staff — the
// owner or the bookkeeper; isOwner is the owner alone, and it gates the Admin
// link in the menu and the People panel behind it.
// ---------------------------------------------------------------------------

import {
  supabase, isConfigured, sdkMissing, getSession, getProfile, signOut,
  isAdmin, isOwner, errorMessage,
} from './client.js';
import { BUSINESS_NAME } from './config.js';
import { el, mount, byId, formModal, toast } from './ui.js';
import { usernameOf } from './accounts.js';

const MIN_PASSWORD = 10;

/**
 * Change your own password.
 *
 * The current password is asked for and checked even though Supabase does not
 * require it. Without that, an unlocked laptop is enough for a passer-by to
 * change the password and lock the owner out of their own portal — and with no
 * email behind the account there is no reset link to fall back on, only the
 * other person with an owner sign-in. signInWithPassword is the check: it
 * either confirms the old password or it does not, and the session it returns
 * is the same one we already hold.
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
 * Which menu link describes the page being looked at. The detail pages belong
 * to the list they were opened from even though their paths never say
 * "clients" or "invoices" — and the trailing slash is what keeps each pair
 * apart: '/portal/clients/' does not start with '/portal/client/'.
 */
function isCurrent(href) {
  const path = window.location.pathname;
  if (href === '/portal/clients/') {
    return path.startsWith('/portal/clients/') || path.startsWith('/portal/client/');
  }
  if (href === '/portal/invoices/') {
    return path.startsWith('/portal/invoices/') || path.startsWith('/portal/invoice/');
  }
  return path.startsWith(href);
}

/** The brand: the mark and the word, going home. Shared by the full header
 *  and the bare one the error screens get. */
function brandLink() {
  return el('a', { class: 'portal-header__brand', href: '/portal/dashboard/' }, [
    el('img', { src: '/assets/img/wo-mark.svg', alt: BUSINESS_NAME, width: '34', height: '34' }),
    el('span', { class: 'portal-header__label', text: 'Portal' }),
  ]);
}

/**
 * The whole nav lives behind one hamburger button, at every width: one
 * navigation to learn, and a sticky header that never wraps to three rows on
 * a phone. Five destinations in the order the work happens — the figures,
 * who it is for, what was billed, what was spent, what it added up to — and
 * below them, on the canvas tint so it reads as a different kind of thing,
 * the card of what you touch least: Admin (owner only), Change password,
 * Sign out.
 *
 * The panel is a dropdown, not a full-screen takeover: Escape closes it, the
 * scrim closes it, opening returns focus to the button when it shuts, and the
 * page keeps scrolling underneath — it is a menu, not a mode.
 */
function renderNav(profile) {
  const nav = byId('portal-nav');
  if (!nav) return;

  const owner = isOwner(profile);

  const links = [
    { href: '/portal/dashboard/', label: 'Dashboard' },
    { href: '/portal/clients/', label: 'Clients' },
    { href: '/portal/invoices/', label: 'Invoices' },
    { href: '/portal/expenses/', label: 'Expenses' },
    { href: '/portal/reports/', label: 'Reports' },
  ];

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
    'aria-current': isCurrent(link.href) ? 'page' : null,
  }, [link.label]);

  const panel = el('nav', {
    class: 'portal-menu__panel',
    id: 'portal-menu',
    hidden: true,
    'aria-label': 'Portal',
  }, [
    // Who is signed in, one tap away rather than in every screen's sticky
    // header. The name if there is one, else the username — never the
    // synthetic address behind it.
    el('p', { class: 'portal-menu__who', text: profile.full_name || usernameOf(profile.email) }),
    el('div', { class: 'portal-menu__group', role: 'group', 'aria-label': 'Pages' },
      links.map(item)),
    el('div', {
      class: 'portal-menu__group portal-menu__group--foot',
      role: 'group',
      'aria-label': 'Account',
    }, [
      // The bookkeeper has no business on the Admin page: the panels there
      // are business settings and sign-ins, and the page itself refuses them.
      // Hiding the link is a courtesy, not the boundary.
      owner ? item({ href: '/portal/admin/', label: 'Admin' }) : null,
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
        onclick: () => signOut(),
      }),
    ]),
  ]);

  let isOpen = false;

  function onKeydown(event) {
    if (event.key === 'Escape') {
      close();
      button.focus();
    }
  }

  function open() {
    if (isOpen) return;
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

  mount(nav, brandLink(), button, scrim, panel);

  trackHeaderHeight();
}

/**
 * Publish the sticky header's real height as --portal-header-h, so anything
 * else that pins itself (the section nav on the client record and the Admin
 * page) can sit exactly under it. Measured rather than hard-coded because the
 * header wraps taller on a narrow phone.
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

function renderBrandOnly() {
  const nav = byId('portal-nav');
  if (!nav) return;
  mount(nav, brandLink());
  trackHeaderHeight();
}

export function renderSetupNotice(target = root()) {
  if (!target) return;
  mount(target,
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Portal not configured yet' }),
      el('p', {
        text: 'Add the Supabase project URL and publishable key to js/portal/config.js, '
            + 'and apply supabase/schema.sql to the project. '
            + 'The steps are in WO-LAUNCH.md.',
      }),
    ]),
  );
}

/** A sign-in with no role behind it: an account that exists in Supabase but
 *  was never invited, so every table returns nothing. The only way on is the
 *  owner finishing the setup from Admin → People. */
function renderNoAccess() {
  mount(root(),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Not set up yet' }),
      el('p', { text: 'Your sign-in is not set up yet. Ask Walter to finish it.' }),
      el('p', {}, [
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Sign out',
          onclick: () => signOut(),
        }),
      ]),
    ]),
  );
}

/** Staff on an owner-only page. The menu never offers the link, so this is
 *  a typed address or an old bookmark, and the answer is the way back. */
function renderForbidden() {
  mount(root(),
    el('div', { class: 'panel' }, [
      el('h1', { text: 'Not available' }),
      el('p', { text: 'This page is for the owner.' }),
      el('p', {}, [el('a', { class: 'btn btn--ghost btn--small', href: '/portal/dashboard/', text: 'Back to the Dashboard' })]),
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

export async function bootstrap({ requireAdmin = false, requireOwner = false } = {}) {
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
  const owner = isOwner(profile);

  renderNav(profile);

  // A token that expires or a sign-out in another tab should not leave a stale
  // page showing another account's data.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('/portal/');
  });

  // Role 'none' sees nothing anywhere, whatever the page asked for: there is
  // no page in this portal a person with no role can use.
  if (!admin) {
    renderNoAccess();
    return null;
  }

  if ((requireAdmin && !admin) || (requireOwner && !owner)) {
    renderForbidden();
    return null;
  }

  return { session, profile, isAdmin: admin, isOwner: owner };
}
