// ---------------------------------------------------------------------------
// Admin — the setup a business touches rarely and deliberately.
//
// Four panels, in the order they are likely to be needed:
//
//   Business details    the letterhead and the rates (studio_settings)
//   Invoice terms       how to pay, when it is due, sales tax (invoice_settings)
//   Expense categories  what an expense can be, and which Schedule C line it
//                       rolls up to (expense_categories)
//   People              the sign-ins — owner only
//
// The first three are staff's: the bookkeeper is exactly the person who fixes
// a category name or the payment instructions. People is the owner's alone,
// and for the bookkeeper the panel is not on the page at all rather than shown
// disabled — the function behind it refuses them anyway (admin-users.js), and
// a button that cannot work is worse than no button.
//
// Categories are archived, never deleted: an expense from three years ago
// still points at the line it was filed under, and April is not the month to
// discover that it points at nothing.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, busy, fmtDate, formModal, panelHead, table, stackedCell,
} from './ui.js';
import { parseMoney, formatMoney, formatRate } from './money.js';
import { callAdminUsers, passwordFields, passwordHandoff, usernameOf } from './accounts.js';
import { openPersonForm, roleLabel } from './person-form.js';
import { filterPeople } from './people-search.js';
import { sectionNav } from './section-nav.js';

// Part II of Schedule C, as the form lists them. A category's line is one of
// these; the report groups by it. Kept as a list rather than free text so two
// categories cannot spell the same line two ways.
const SCHEDULE_C_LINES = [
  ['8', 'Advertising'],
  ['9', 'Car and truck expenses'],
  ['10', 'Commissions and fees'],
  ['11', 'Contract labor'],
  ['12', 'Depletion'],
  ['13', 'Depreciation'],
  ['14', 'Employee benefit programs'],
  ['15', 'Insurance (other than health)'],
  ['16a', 'Interest — mortgage'],
  ['16b', 'Interest — other'],
  ['17', 'Legal and professional services'],
  ['18', 'Office expense'],
  ['19', 'Pension and profit-sharing plans'],
  ['20a', 'Rent — vehicles, machinery, equipment'],
  ['20b', 'Rent — other business property'],
  ['21', 'Repairs and maintenance'],
  ['22', 'Supplies'],
  ['23', 'Taxes and licenses'],
  ['24a', 'Travel'],
  ['24b', 'Deductible meals'],
  ['25', 'Utilities'],
  ['26', 'Wages'],
  ['27a', 'Other expenses'],
  ['30', 'Business use of home'],
];

function lineLabel(code) {
  const entry = SCHEDULE_C_LINES.find(([value]) => value === code);
  return entry ? `${entry[0]} · ${entry[1]}` : String(code || '—');
}

const state = {
  studio: null,
  terms: null,
  categories: [],
  people: [],
  // A just-assigned password, held only until the next render draws it once.
  passwordNotice: null,
};

// Each panel keeps its own node so one mutation does not rebuild the whole page
// (and steal focus out of a search box someone is still using).
const panels = {
  business: el('section', { class: 'panel' }),
  terms: el('section', { class: 'panel' }),
  categories: el('section', { class: 'panel' }),
  people: el('section', { class: 'panel' }),
};

let ctx = null;

// Loading
// ---------------------------------------------------------------------------

async function loadAll() {
  const reads = [
    supabase.from('studio_settings').select('*').eq('id', true).maybeSingle(),
    supabase.from('invoice_settings').select('*').eq('id', true).maybeSingle(),
    supabase.from('expense_categories').select('*').order('position').order('name'),
  ];
  if (ctx.isOwner) {
    reads.push(supabase
      .from('profiles')
      .select('id, email, full_name, role, phone, created_at')
      .order('created_at'));
  }

  const [studio, terms, categories, people] = await Promise.all(reads);

  for (const result of [studio, terms, categories, people]) {
    if (result && result.error) throw result.error;
  }

  state.studio = studio.data || {};
  state.terms = terms.data || {};
  state.categories = categories.data || [];
  state.people = people ? people.data || [] : [];
}

async function refresh(render = renderAll) {
  try {
    await loadAll();
    render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

// Shared bits
// ---------------------------------------------------------------------------

function detailRow(label, value) {
  const lines = (Array.isArray(value) ? value : [value])
    .map((line) => (line == null ? '' : String(line).trim()))
    .filter(Boolean);
  return el('div', { class: 'detail-row' }, [
    el('dt', { class: 'detail-row__label', text: label }),
    el('dd', { class: 'detail-row__value' }, [
      lines.length
        ? el('div', { class: 'detail-block' }, lines.map((line) => el('div', { text: line })))
        : el('span', { class: 'progress__label', text: 'Not set' }),
    ]),
  ]);
}

/** "8.25" → 825. Null for anything that is not a percentage. */
function parseRate(input) {
  const cleaned = String(input == null ? '' : input).replace(/[%\s]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

// Business details
// ---------------------------------------------------------------------------

function cityLine(row) {
  const cityRegion = [row.city, row.region].filter(Boolean).join(', ');
  return [cityRegion, row.postal_code].filter(Boolean).join(' ');
}

function renderBusiness() {
  const row = state.studio || {};

  mount(panels.business,
    panelHead('Business details', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Edit',
      onclick: editBusiness,
    }), 'The letterhead on every invoice, and the rates the portal prices from.'),
    el('dl', { class: 'detail-list' }, [
      detailRow('Name', [row.business_name, row.entity_line]),
      detailRow('Address', [row.address_line1, row.address_line2, cityLine(row)]),
      detailRow('Phone', row.phone),
      detailRow('Email', row.email),
      detailRow('Website', row.website),
      detailRow('Checks payable to', row.payee_name),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'Hourly rate' }),
        el('dd', { class: 'detail-row__value' }, [
          row.hourly_rate_cents
            ? el('div', { text: `${formatMoney(row.hourly_rate_cents)} an hour` })
            : el('span', {
              class: 'progress__label',
              text: 'Not set — "Bill hours" on an invoice refuses to price a line '
                  + 'until there is one. A client can still carry a rate of their own.',
            }),
        ]),
      ]),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: '1099 threshold' }),
        el('dd', { class: 'detail-row__value' }, [
          el('div', { text: formatMoney(row.nec_threshold_cents || 0) }),
          el('div', {
            class: 'progress__label',
            text: 'A vendor flagged for a 1099 shows on the January report once '
                + 'the year\'s payments to them reach this. $2,000 from 2026; '
                + 'it was $600 before.',
          }),
        ]),
      ]),
    ]),
  );
}

async function editBusiness() {
  const row = state.studio || {};

  const result = await formModal({
    title: 'Business details',
    submitLabel: 'Save details',
    intro: 'Printed at the top of every invoice issued from now on. Invoices '
         + 'already issued keep the letterhead they were issued with.',
    fields: [
      { name: 'business_name', label: 'Business name', type: 'text', required: true, value: row.business_name || '' },
      {
        name: 'entity_line',
        label: 'Line under the name',
        type: 'text',
        value: row.entity_line || '',
        placeholder: 'A Texas limited liability company',
        hint: 'Optional. Printed under the name on documents.',
      },
      { name: 'address_line1', label: 'Address', type: 'text', value: row.address_line1 || '', autocomplete: 'address-line1' },
      { name: 'address_line2', label: 'Address line 2', type: 'text', value: row.address_line2 || '', autocomplete: 'address-line2' },
      { name: 'city', label: 'City', type: 'text', value: row.city || '', autocomplete: 'address-level2' },
      { name: 'region', label: 'State', type: 'text', value: row.region || '', autocomplete: 'address-level1' },
      { name: 'postal_code', label: 'ZIP', type: 'text', value: row.postal_code || '', inputmode: 'numeric', autocomplete: 'postal-code' },
      { name: 'phone', label: 'Phone', type: 'tel', value: row.phone || '', autocomplete: 'tel' },
      { name: 'email', label: 'Email', type: 'email', value: row.email || '', autocomplete: 'email', hint: 'Printed on the invoice. The portal never sends to it.' },
      { name: 'website', label: 'Website', type: 'text', value: row.website || '', inputmode: 'url', autocapitalize: 'none' },
      {
        name: 'payee_name',
        label: 'Checks payable to',
        type: 'text',
        value: row.payee_name || '',
        hint: 'Printed in the how-to-pay block beside the payment details.',
      },
      {
        name: 'hourly_rate',
        label: 'Hourly rate',
        type: 'text',
        inputmode: 'decimal',
        value: row.hourly_rate_cents ? (row.hourly_rate_cents / 100).toFixed(2) : '',
        placeholder: '150.00',
        hint: 'Dollars an hour. What "Bill hours" uses unless the client has a '
            + 'negotiated rate.',
      },
      {
        name: 'nec_threshold',
        label: '1099-NEC threshold',
        type: 'text',
        inputmode: 'decimal',
        required: true,
        value: ((row.nec_threshold_cents == null ? 200000 : row.nec_threshold_cents) / 100).toFixed(2),
        hint: 'Dollars. Change it when the IRS does, so the January report '
            + 'follows the law of the year.',
      },
    ],
    onSubmit: async (values) => {
      let rate = null;
      if (values.hourly_rate) {
        rate = parseMoney(values.hourly_rate);
        if (rate === null || rate <= 0) {
          throw new Error('That hourly rate is not an amount. Leave it blank until there is one.');
        }
      }
      const threshold = parseMoney(values.nec_threshold);
      if (threshold === null || threshold < 0) {
        throw new Error('That 1099 threshold is not an amount.');
      }

      // Text columns on studio_settings are NOT NULL with '' defaults, so a
      // cleared box is written as '' rather than null.
      const { error } = await supabase.from('studio_settings').update({
        business_name: values.business_name,
        entity_line: values.entity_line || '',
        address_line1: values.address_line1 || '',
        address_line2: values.address_line2 || '',
        city: values.city || '',
        region: values.region || '',
        postal_code: values.postal_code || '',
        phone: values.phone || '',
        email: values.email || '',
        website: values.website || '',
        payee_name: values.payee_name || '',
        hourly_rate_cents: rate,
        nec_threshold_cents: threshold,
      }).eq('id', true);
      if (error) throw new Error(errorMessage(error));
    },
  });

  if (result) {
    toast('Business details saved.', 'ok');
    await refresh(renderBusiness);
  }
}

// Invoice terms
// ---------------------------------------------------------------------------

function renderTerms() {
  const row = state.terms || {};
  const days = row.net_days == null ? 15 : row.net_days;

  mount(panels.terms,
    panelHead('Invoice terms', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Edit',
      onclick: editTerms,
    }), 'What every invoice says about how and when to pay.'),
    el('dl', { class: 'detail-list' }, [
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'How to pay' }),
        el('dd', { class: 'detail-row__value' }, [
          row.payment_details
            ? el('div', { class: 'detail-block' },
              String(row.payment_details).split('\n').filter(Boolean)
                .map((line) => el('div', { text: line.trim() })))
            : el('span', {
              class: 'progress__label',
              text: 'Not set, so no invoice tells a client where to send the money. '
                  + 'Worth two minutes.',
            }),
        ]),
      ]),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'Due' }),
        el('dd', { class: 'detail-row__value' }, [
          el('div', { text: `Net ${days} — ${days} days after the invoice date, unless the client has terms of their own.` }),
        ]),
      ]),
      el('div', { class: 'detail-row' }, [
        el('dt', { class: 'detail-row__label', text: 'Sales tax' }),
        el('dd', { class: 'detail-row__value' }, [
          row.tax_rate_bp
            ? el('div', { class: 'detail-block' }, [
              el('div', { text: `${row.tax_label || 'Sales tax'} at ${formatRate(row.tax_rate_bp)}` }),
              el('div', {
                class: 'progress__label',
                text: row.tax_registration
                  ? `Permit ${row.tax_registration}. Charged only on invoice lines ticked as taxable.`
                  : 'No permit number set — an invoice charging tax should carry one.',
              }),
            ])
            : el('span', {
              class: 'progress__label',
              text: 'Not charged. Right for consulting and design work; set a rate '
                  + 'here if the business bills anything taxable.',
            }),
        ]),
      ]),
      detailRow('Late payment note', row.late_note),
    ]),
  );
}

async function editTerms() {
  const row = state.terms || {};

  const result = await formModal({
    title: 'Invoice terms',
    submitLabel: 'Save terms',
    intro: 'Applies to invoices raised from now on. The due date and the tax '
         + 'rate are copied onto each invoice when it is raised, so a change '
         + 'here never restates one already sent.',
    fields: [
      {
        name: 'payment_details',
        label: 'How to pay',
        type: 'textarea',
        rows: 4,
        value: row.payment_details || '',
        hint: 'One per line — who checks are payable to, ACH details, a Zelle '
            + 'handle. Printed on every invoice. Bank details go here and '
            + 'nowhere else.',
      },
      {
        name: 'net_days',
        label: 'Default terms (days)',
        type: 'number',
        value: row.net_days == null ? 15 : row.net_days,
        required: true,
        inputmode: 'numeric',
        hint: 'Net 15 by default. A client can carry their own terms; an '
            + 'invoice can always be edited.',
      },
      {
        name: 'late_note',
        label: 'Late payment note',
        type: 'textarea',
        rows: 2,
        value: row.late_note || '',
        hint: 'Optional. Only include something you are actually willing to enforce.',
      },
      {
        name: 'tax_rate',
        label: 'Sales tax rate (%)',
        type: 'text',
        inputmode: 'decimal',
        value: row.tax_rate_bp ? formatRate(row.tax_rate_bp).replace('%', '') : '',
        placeholder: '8.25',
        hint: 'Leave empty if the business does not charge sales tax. What is '
            + 'actually taxable is a question for the CPA, and it is ticked per '
            + 'line on each invoice rather than per invoice.',
      },
      {
        name: 'tax_label',
        label: 'What to call it',
        type: 'text',
        value: row.tax_label || 'Sales tax',
        hint: 'Printed on the invoice beside the rate.',
      },
      {
        name: 'tax_registration',
        label: 'Sales tax permit number',
        type: 'text',
        value: row.tax_registration || '',
        hint: 'Printed on any invoice that charges tax, which is what the state '
            + 'expects to see on one.',
      },
    ],
    onSubmit: async (values) => {
      const net = Number(values.net_days);
      if (!Number.isInteger(net) || net < 0 || net > 365) {
        throw new Error('Terms are a number of days, 0 to 365.');
      }

      const rate = parseRate(values.tax_rate);
      if (rate === null) throw new Error('That tax rate is not a percentage.');

      const { error } = await supabase.from('invoice_settings').update({
        payment_details: values.payment_details || '',
        net_days: net,
        late_note: values.late_note || null,
        tax_rate_bp: rate,
        tax_label: values.tax_label || 'Sales tax',
        tax_registration: values.tax_registration || null,
      }).eq('id', true);
      if (error) throw new Error(errorMessage(error));
    },
  });

  if (result) {
    toast('Terms saved.', 'ok');
    await refresh(renderTerms);
  }
}

// Expense categories
// ---------------------------------------------------------------------------

/** The flags a category carries, as words. */
function categoryFlags(category) {
  const flags = [];
  if (category.needs_substantiation) flags.push('where & why');
  if (category.needs_attendees) flags.push('who was there');
  if (category.half_deductible) flags.push('50% deductible');
  return flags.join(' · ');
}

/** A stable code for a new category: the name as a slug, made unique against
 *  the ones already there. Internal — the form never shows it. */
function codeFor(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    || 'category';
  const taken = new Set(state.categories.map((row) => row.code));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function categoryRow(category) {
  const archived = Boolean(category.archived_at);

  return el('tr', {}, [
    el('td', {}, [
      el('button', {
        class: 'link-button',
        type: 'button',
        text: category.name,
        'aria-label': `Edit ${category.name}`,
        onclick: () => openCategoryForm(category),
      }),
      category.description
        ? el('p', { class: 'progress__label', text: category.description })
        : null,
    ]),
    el('td', { class: 'is-tight', text: lineLabel(category.schedule_c_line) }),
    el('td', {}, [
      archived ? el('span', { class: 'pill pill--amber', text: 'Archived' }) : null,
      el('span', { class: 'progress__label', text: categoryFlags(category) || '' }),
    ]),
    el('td', { class: 'is-tight' }, [
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: archived ? 'Restore' : 'Archive',
        'aria-label': `${archived ? 'Restore' : 'Archive'} ${category.name}`,
        onclick: busy(async () => {
          try {
            const { error } = await supabase
              .from('expense_categories')
              .update({ archived_at: archived ? null : new Date().toISOString() })
              .eq('id', category.id);
            if (error) throw error;
            toast(archived ? 'Category restored.' : 'Category archived.', 'ok');
            await refresh(renderCategories);
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        }, { label: archived ? 'Restoring…' : 'Archiving…' }),
      }),
    ]),
  ]);
}

function renderCategories() {
  const live = state.categories.filter((row) => !row.archived_at);
  const archived = state.categories.filter((row) => row.archived_at);

  mount(panels.categories,
    panelHead('Expense categories', el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add category',
      onclick: () => openCategoryForm(null),
    }), 'What an expense can be filed under, and the Schedule C line each one '
      + 'rolls up to. Archive one you no longer use — it stays on the '
      + 'expenses already filed under it.'),
    live.length
      ? table(['Category', 'Schedule C', 'Asks for', ''], live.map(categoryRow))
      : el('p', { class: 'empty', text: 'No categories. Add one before recording an expense.' }),
    archived.length
      ? el('details', { class: 'form-group' }, [
        el('summary', {}, [el('span', { text: `Archived (${archived.length})` })]),
        table(['Category', 'Schedule C', 'Asks for', ''], archived.map(categoryRow)),
      ])
      : null,
  );
}

async function openCategoryForm(category) {
  const editing = Boolean(category);
  const nextPosition = state.categories.reduce((max, row) => Math.max(max, row.position || 0), 0) + 10;

  const result = await formModal({
    title: editing ? category.name : 'Add category',
    submitLabel: editing ? 'Save category' : 'Add category',
    fields: [
      {
        name: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        value: editing ? category.name : '',
        placeholder: 'Software & subscriptions',
      },
      {
        name: 'schedule_c_line',
        label: 'Schedule C line',
        type: 'select',
        value: editing ? category.schedule_c_line : '27a',
        options: SCHEDULE_C_LINES.map(([value, label]) => ({ value, label: `${value} · ${label}` })),
        hint: 'Part II of Schedule C. The tax-year report groups by this.',
      },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        rows: 2,
        value: editing ? category.description || '' : '',
        hint: 'Shown under the name here and on the expense form, so the '
            + 'bookkeeper files things the same way you would.',
      },
      {
        name: 'needs_substantiation',
        label: 'Ask where and why (travel, vehicle, meals, gifts)',
        type: 'checkbox',
        value: editing ? category.needs_substantiation : false,
      },
      {
        name: 'needs_attendees',
        label: 'Ask who was there (meals, gifts)',
        type: 'checkbox',
        value: editing ? category.needs_attendees : false,
      },
      {
        name: 'half_deductible',
        label: 'Deductible at 50% (business meals)',
        type: 'checkbox',
        value: editing ? category.half_deductible : false,
      },
      {
        name: 'position',
        label: 'Sort order',
        type: 'number',
        inputmode: 'numeric',
        value: editing ? category.position : nextPosition,
        hint: 'Lower sorts first on the expense form.',
      },
    ],
    onSubmit: async (values) => {
      const position = Number(values.position);
      const patch = {
        name: values.name,
        schedule_c_line: values.schedule_c_line,
        description: values.description || '',
        needs_substantiation: Boolean(values.needs_substantiation),
        needs_attendees: Boolean(values.needs_attendees),
        half_deductible: Boolean(values.half_deductible),
        position: Number.isFinite(position) ? Math.round(position) : nextPosition,
      };

      const query = editing
        ? supabase.from('expense_categories').update(patch).eq('id', category.id)
        : supabase.from('expense_categories').insert({ ...patch, code: codeFor(values.name) });

      const { error } = await query;
      if (error) throw new Error(errorMessage(error));
    },
  });

  if (!result) return;
  toast(editing ? 'Category saved.' : 'Category added.', 'ok');
  await refresh(renderCategories);
}

// People — the sign-ins (owner only)
// ---------------------------------------------------------------------------

/** The form, wired to this page's data and refreshed afterwards. */
async function editPerson(person) {
  const result = await openPersonForm({ person, selfId: ctx.profile.id });
  if (!result) return;

  if (result.deleted) {
    toast('Sign-in deleted.', 'ok');
    await refresh(renderPeople);
    return;
  }

  if (result.handoff) state.passwordNotice = result.handoff;
  toast(result.editing ? 'Person saved.' : 'Sign-in created.', 'ok');
  await refresh(renderPeople);
}

/** Just the password, for the phone call that starts "I can't get in". */
async function setPassword(person) {
  const username = usernameOf(person.email);
  const result = await formModal({
    title: `New password for ${person.full_name || username}`,
    submitLabel: 'Set password',
    intro: 'Takes effect immediately. Devices they are already signed in on '
         + 'stay signed in until that session expires.',
    fields: passwordFields(),
    onSubmit: async (values) => {
      await callAdminUsers({ action: 'set-password', user_id: person.id, password: values.password });
    },
  });
  if (!result) return;

  state.passwordNotice = { username, password: result.password };
  toast('Password set.', 'ok');
  renderPeople();
}

function rolePill(role) {
  const tone = { owner: 'blue', staff: 'green', none: 'amber' }[role] || '';
  return el('span', { class: tone ? `pill pill--${tone}` : 'pill', text: roleLabel(role) });
}

// The search box is built once and kept. Rebuilding it on every keystroke
// would take the focus and the caret with it.
const peopleSearch = el('input', {
  type: 'search',
  id: 'people-search',
  class: 'panel-search',
  placeholder: 'Search people…',
  'aria-label': 'Search people',
  autocomplete: 'off',
  autocapitalize: 'none',
  autocorrect: 'off',
  spellcheck: 'false',
});

const peopleNotice = el('div');
const strayNotice = el('div');
const peopleRows = el('div');
let peopleMounted = false;

/** What a row can be found by: every column the table shows. */
function personFields(person) {
  return [
    person.full_name,
    usernameOf(person.email),
    roleLabel(person.role),
    fmtDate(person.created_at),
  ];
}

function personRow(person) {
  const username = usernameOf(person.email);
  const who = person.full_name || username || 'Unnamed';
  const isSelf = person.id === ctx.profile.id;

  return el('tr', {}, [
    el('td', {}, [
      el('button', {
        class: 'link-button',
        type: 'button',
        text: who,
        'aria-label': `Edit ${who}`,
        onclick: () => editPerson(person),
      }),
      isSelf ? el('span', { class: 'progress__label', text: ' (you)' }) : null,
    ]),
    el('td', { class: 'is-tight' }, stackedCell([username, person.phone])),
    el('td', { class: 'is-tight' }, [rolePill(person.role)]),
    el('td', { class: 'is-tight', text: fmtDate(person.created_at) }),
    el('td', { class: 'is-tight' }, [
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Set password',
        'aria-label': `Set a new password for ${who}`,
        onclick: () => setPassword(person),
      }),
    ]),
  ]);
}

function renderPeopleRows() {
  const query = peopleSearch.value;
  const shown = filterPeople(state.people, query, personFields);

  if (!state.people.length) {
    mount(peopleRows, el('p', {
      class: 'empty',
      text: 'No sign-ins yet. Use “Add a person” to create one — you set '
          + 'their password at the same time.',
    }));
    return;
  }

  if (!shown.length) {
    mount(peopleRows, el('p', { class: 'empty', text: `Nobody matches “${query.trim()}”.` }));
    return;
  }

  mount(peopleRows,
    table(['Person', 'Username', 'Role', 'Since', ''], shown.map(personRow), { className: 'table--people' }),
    // Only worth saying while the list is being narrowed.
    shown.length === state.people.length
      ? null
      : el('p', { class: 'progress__label', text: `${shown.length} of ${state.people.length} shown` }),
  );
}

/** Accounts with no role: they can sign in and see nothing. This is where
 *  somebody goes when a login "doesn't work", so they are said out loud. */
function renderStrays() {
  const strays = state.people.filter((person) => person.role === 'none');
  if (!strays.length) {
    mount(strayNotice);
    return;
  }

  mount(strayNotice, el('div', { class: 'notice notice--warn' }, [
    el('strong', {
      text: strays.length === 1
        ? 'One sign-in is not set up'
        : `${strays.length} sign-ins are not set up`,
    }),
    el('p', {
      class: 'progress__label',
      text: 'These can sign in but see nothing, because no role was given. '
          + 'Open one and pick a role — or delete it.',
    }),
    ...strays.map((person) => el('div', { class: 'btn-row' }, [
      el('span', { text: person.full_name || usernameOf(person.email) || 'Unnamed' }),
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Finish setup',
        'aria-label': `Finish setting up ${person.full_name || usernameOf(person.email) || 'this sign-in'}`,
        onclick: () => editPerson(person),
      }),
    ])),
  ]));
}

function renderPeople() {
  if (!ctx.isOwner) return;

  if (!peopleMounted) {
    peopleMounted = true;
    peopleSearch.addEventListener('input', renderPeopleRows);
    mount(panels.people,
      panelHead('People', el('div', { class: 'panel__tools' }, [
        peopleSearch,
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: 'Add a person',
          onclick: () => editPerson(null),
        }),
      ]), 'Who can sign in. Click a person to change their name, username, '
        + 'role or password. Nothing is emailed — hand the details over yourself.'),
      peopleNotice,
      strayNotice,
      peopleRows,
    );
  }

  // The one-time password panel, shown until the next render. It sits above
  // the table because it is the only thing on this page that cannot be
  // recovered by looking again.
  if (state.passwordNotice) {
    const notice = state.passwordNotice;
    mount(peopleNotice, passwordHandoff(notice.username, notice.password));
    state.passwordNotice = null;
  } else {
    mount(peopleNotice);
  }

  renderStrays();
  renderPeopleRows();
}

// ---------------------------------------------------------------------------

function renderAll() {
  renderBusiness();
  renderTerms();
  renderCategories();
  renderPeople();
}

async function main() {
  ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  try {
    await loadAll();
  } catch (error) {
    renderError(error);
    return;
  }

  const entries = [
    { id: 'business', label: 'Business details', target: panels.business },
    { id: 'terms', label: 'Invoice terms', target: panels.terms },
    { id: 'categories', label: 'Expense categories', target: panels.categories },
  ];
  if (ctx.isOwner) entries.push({ id: 'people', label: 'People', target: panels.people });

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Admin' }),
        el('p', {
          text: ctx.isOwner
            ? 'The letterhead, the invoice terms, the expense categories and who can sign in.'
            : 'The letterhead, the invoice terms and the expense categories.',
        }),
      ]),
    ]),
    // Four panels is more than enough to lose the one you came for on a
    // phone. The bar's targets must be direct children of #portal-root.
    sectionNav(entries),
    ...entries.map((entry) => entry.target),
  );

  renderAll();
}

main();
