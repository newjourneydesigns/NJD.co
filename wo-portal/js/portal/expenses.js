// ---------------------------------------------------------------------------
// What the studio spends, and who it spends it with.
//
// Recording an expense is the one bookkeeping habit that has to be frictionless
// or it does not happen, and an expense that does not get recorded is a
// deduction the studio pays tax on for no reason. So this form is short: a
// date, an amount, what it was for, what paid for it. Everything else — the
// client it belongs to, the receipt, whether it gets billed back — is optional
// and sits below the fold.
//
// An expense here is recorded when it is paid, which is a deliberate
// simplification: this studio pays a card and a bank account, not a payables
// run. It is also why the cash-basis and accrual-basis reports agree on costs.
// A genuine accrual is still possible as a journal entry against 2000 Accounts
// payable, for the rare case that needs it.
//
// The receipt is worth the extra step. A deduction without one is a deduction
// that does not survive an audit, and photographing it now costs nothing.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import { el, mount, byId, toast, formModal, fmtDate, fmtBytes, panelHead, table, confirmModal } from './ui.js';
import { shouldAutoOpen } from './quick-add-model.js';
import { formatMoney, parseMoney } from './sow-fees.js';
import { downloadCsv } from './csv.js';
import {
  pickFile, safeName, shrinkImage, makeThumbnail, MAX_UPLOAD_BYTES,
} from './files.js';
import {
  CASH_SUBTYPES,
  MILEAGE_ACCOUNT_CODE,
  PAYMENT_METHODS,
  accountLabel,
  defaultMethodFor,
  matchVendor,
  memberName,
  methodLabel,
  personName,
  mileageAmount,
  mileageRateLabel,
  recentValues,
  recurringStatus,
  substantiationGaps,
} from './ledger-catalog.js';
import {
  addReceipt,
  deleteExpense,
  deleteReceipt,
  deleteRecurring,
  loadAccounts,
  loadClients,
  loadExpenses,
  loadOwners,
  loadProjects,
  loadRecurring,
  loadSettings,
  loadVendors,
  saveExpense,
  saveRecurring,
  saveVendor,
} from './ledger-data.js';

const RECEIPT_BUCKET = 'expense-receipts';

const state = {
  profileId: null,
  accounts: [],
  vendors: [],
  clients: [],
  projects: [],
  expenses: [],
  recurring: [],
  owners: [],
  settings: null,
  from: '',
  to: '',
  search: '',
  accountId: '',
  // Who entered it. "Anyone" by default, which is the opposite of the drive
  // log's default and deliberately so: a mileage log is filed per person, and
  // the expense ledger is the studio's whole spend. The filter is here for
  // "what did Vic put through last month", not for privacy.
  enteredBy: '',
};

const panels = {
  expenses: el('section', { class: 'panel' }),
  recurring: el('section', { class: 'panel' }),
  vendors: el('section', { class: 'panel' }),
};

const expenseTable = el('div', {});
const recurringTable = el('div', {});
const vendorTable = el('div', {});

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function yearStart() {
  return `${todayIso().slice(0, 4)}-01-01`;
}

function spendAccounts() {
  return state.accounts.filter((row) => !row.archived_at && row.type === 'expense');
}

/**
 * The category list, in the order a chart of accounts is read and with each
 * account's own description attached.
 *
 * Cost of sales first because those are the costs a job creates, then the
 * overheads, then anything below the line. A flat alphabetical list of forty
 * accounts is how a cost ends up in a different place every month.
 */
function categoryOptions() {
  const order = { cost_of_sales: 0, expense: 1, other_expense: 2 };
  const heading = {
    cost_of_sales: 'Cost of the work',
    expense: 'Running the studio',
    other_expense: 'Below the line',
  };

  return spendAccounts()
    .slice()
    .sort((a, b) => (order[a.subtype] - order[b.subtype]) || a.code.localeCompare(b.code))
    .map((account) => ({
      value: account.id,
      label: `${heading[account.subtype]} — ${accountLabel(account)}`
           + (account.needs_substantiation ? ' (needs the story)' : ''),
    }));
}

function cashAccounts() {
  return state.accounts.filter((row) => (
    !row.archived_at && CASH_SUBTYPES.includes(row.subtype)
  ));
}

/**
 * The capital accounts a personally-borne cost can be credited to — one per
 * member, named for the member rather than for the account.
 *
 * No bank or card moved when a member pays out of their own pocket, so
 * crediting one would misstate a balance the reconciliation has to prove. It
 * is their capital account that grows, and *whose* is the whole point: a
 * pooled credit moves one member's stake in the studio onto everybody's.
 */
function memberAccounts() {
  return state.owners
    .map((member) => {
      const account = state.accounts.find((a) => (
        a.id === member.contributions_account_id && !a.archived_at
      ));
      return account ? { account, member } : null;
    })
    .filter(Boolean);
}

function payFromAccounts() {
  return [...cashAccounts(), ...memberAccounts().map((row) => row.account)];
}

// What the form remembers between visits
// ---------------------------------------------------------------------------
//
// One studio, one card, forty expenses a year against it. Asking "what paid
// for it" from a blank select every single time is asking a question whose
// answer has not changed since March.

const PREFS_KEY = 'njd.ledger.expense.prefs';

function rememberPrefs(patch) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...lastPrefs(), ...patch }));
  } catch {
    // Private mode, a full quota, a browser that says no. The memory is a
    // nicety and its absence costs one extra tap.
  }
}

/** Whatever was last used, shaped the same however little came back — a
 *  convenience is not worth an exception on the way to opening a form. */
function lastPrefs() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      paidFrom: typeof parsed.paidFrom === 'string' ? parsed.paidFrom : null,
      method: typeof parsed.method === 'string' ? parsed.method : null,
    };
  } catch {
    return {};
  }
}

/** The account to open "what paid for it" on: the one used last, while it is
 *  still an account money can come out of. Never a guess at somebody else's
 *  capital account, which is a statement about who bore a cost. */
function rememberedPayFrom() {
  const { paidFrom } = lastPrefs();
  if (!paidFrom) return '';
  return cashAccounts().some((account) => account.id === paidFrom) ? paidFrom : '';
}

/** The paid-from option list, with each member's own line saying in words
 *  what picking it means. */
function payFromOptions() {
  return [
    ...cashAccounts().map((a) => ({ value: a.id, label: accountLabel(a) })),
    ...memberAccounts().map(({ account, member }) => ({
      value: account.id,
      label: `${memberName(member)} — paid personally`,
    })),
  ];
}

async function loadAll() {
  const [accounts, vendors, clients, projects, settings, expenses, recurring, owners] =
    await Promise.all([
      loadAccounts(),
      loadVendors({ includeArchived: true }),
      loadClients(),
      loadProjects(),
      loadSettings(),
      loadExpenses({ from: state.from || null, to: state.to || null }),
      loadRecurring(),
      loadOwners(),
    ]);

  Object.assign(state,
    { accounts, vendors, clients, projects, settings, expenses, recurring, owners });
}

async function refresh(render) {
  try {
    await loadAll();
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  render();
}

// Recording one
// ---------------------------------------------------------------------------

/**
 * The expense form.
 *
 * Six questions on the screen and nine more behind two summary lines — and
 * not one of the fifteen dropped. What changed is who answers them: the
 * vendor names its own category, the account that paid names its own method,
 * the substantiation block opens itself when the category is one the IRS asks
 * about, and the miles box appears only for the account that means miles.
 *
 * The version before this put all fifteen in one flat column, on the argument
 * that a field which materialises when you pick a category is a field people
 * learn to avoid. That argument was right about *materialising* and wrong
 * about the remedy: fifteen boxes between a lunch receipt and Record it
 * produced exactly one hand-typed expense in the life of the ledger. Nothing
 * here appears out of nowhere — the sections are on the screen from the start,
 * named, and say on their own summary line what is waiting inside. They open
 * themselves rather than existing conditionally.
 *
 * The category list is grouped so that a cost of sales and an overhead are
 * visibly different kinds of thing, and every option carries its account's own
 * description, so "what belongs in this one" is answered where the choice is
 * made.
 *
 * Returns the whole shape formModal needs — fields, sections, and the watcher
 * that drives one from another — because the three are one design and reading
 * them apart is how they drift.
 */
function expenseForm(row = {}) {
  const rate = (state.settings && state.settings.mileage_rate_cents) || 70;
  const editing = Boolean(row.id);

  // Every supplier the ledger has ever heard of, saved or typed once as a
  // one-off. This is the field that used to be two — a select of saved vendors
  // and a text box under it captioned "Only read when no vendor is picked
  // above" — which is a precedence rule nobody should be reading at a counter.
  const vendorNames = [
    ...state.vendors.filter((v) => !v.archived_at).map((v) => v.name),
    ...recentValues(state.expenses, 'vendor_name', { limit: 10 }),
  ];

  const openingVendor = row.vendor_id
    ? (state.vendors.find((v) => v.id === row.vendor_id) || {}).name || ''
    : row.vendor_name || '';

  return {
    groups: [
      {
        key: 'story',
        label: 'The who, what and where',
        hint: 'Checking…',
      },
      {
        key: 'extras',
        label: 'Client, billing and reference',
        hint: 'Whose job it was, and anything to quote back.',
        open: Boolean(row.client_id || row.reference),
      },
    ],

    fields: [
      { name: 'spent_on', label: 'Date', type: 'date', required: true,
        value: row.spent_on || todayIso() },
      { name: 'amount', label: 'Amount', type: 'text', inputmode: 'decimal',
        value: row.amount_cents ? formatMoney(row.amount_cents).replace(/^\$/, '') : '',
        hint: 'A refund from a supplier is a negative amount.' },
      {
        name: 'vendor',
        label: 'Who it was paid to',
        type: 'text',
        value: openingVendor,
        suggestions: vendorNames,
        autocapitalize: 'words',
        hint: 'A name used before fills the category in for you. A new one is '
            + 'remembered, so the next time it does the same.',
      },
      {
        name: 'account_id',
        label: 'Category',
        type: 'select',
        value: row.account_id || '',
        options: categoryOptions(),
      },
      {
        name: 'paid_from_account_id',
        label: 'What paid for it',
        type: 'select',
        // An edit keeps what it was booked against; a new one opens on
        // whatever paid for the last one.
        value: row.paid_from_account_id || (editing ? '' : rememberedPayFrom()),
        options: payFromOptions(),
      },
      { name: 'description', label: 'What it was', type: 'text',
        value: row.description || '',
        suggestions: recentValues(state.expenses, 'description') },

      // The three the IRS asks for, and the one the mileage rate needs.
      {
        name: 'place',
        label: 'Where',
        type: 'text',
        group: 'story',
        value: row.place || '',
        suggestions: recentValues(state.expenses, 'place'),
        hint: 'The restaurant, the city, the destination.',
      },
      {
        name: 'business_purpose',
        label: 'What you were doing',
        type: 'text',
        group: 'story',
        value: row.business_purpose || '',
        suggestions: recentValues(state.expenses, 'business_purpose'),
        hint: 'The business reason, in a few words — "discussing the spring rebrand". '
            + 'This is the field a deduction is most often disallowed for missing.',
      },
      {
        name: 'attendees',
        label: 'Who you were with',
        type: 'text',
        group: 'story',
        value: row.attendees || '',
        suggestions: recentValues(state.expenses, 'attendees'),
        hint: 'Names and how they relate to the business — "Dana Reid (prospective '
            + 'client, Acme Co)". Needed for meals and gifts.',
      },
      {
        name: 'miles',
        label: 'Miles driven',
        type: 'text',
        inputmode: 'decimal',
        group: 'story',
        value: row.miles == null ? '' : String(row.miles),
        hint: 'Leave the amount empty and it is worked out at '
            + `${mileageRateLabel(rate)} a mile. The Drives page tracks trips with `
            + 'GPS and logs them here itself.',
      },

      {
        name: 'client_id',
        label: 'For a client',
        type: 'select',
        group: 'extras',
        value: row.client_id || '',
        options: [
          { value: '', label: 'An overhead, not a job cost' },
          ...state.clients.map((c) => ({ value: c.id, label: c.name })),
        ],
      },
      { name: 'billable', label: 'Meant to be billed back to them', type: 'checkbox',
        group: 'extras', value: Boolean(row.billable) },
      {
        name: 'method',
        label: 'How',
        type: 'select',
        group: 'extras',
        value: row.method || 'card',
        options: PAYMENT_METHODS,
        hint: 'Set from the account above. Change it for the cheque written off '
            + 'the checking account.',
      },
      { name: 'reference', label: 'Reference', type: 'text', group: 'extras',
        value: row.reference || '' },
    ],

    onChange: expenseWatch(row),
  };
}

/**
 * The part that answers a question with another question's answer.
 *
 * Both prefills are keyed on *what changed*, not on what is empty: filling
 * only-when-blank would leave the category on the first vendor's after you
 * corrected the vendor, and re-imposing it on every keystroke would fight
 * anyone who deliberately booked a Dropbox charge somewhere unusual. So each
 * remembers what it last acted on and moves only when that moves.
 *
 * The opening call arrives with `name === null`. It seeds those trackers and
 * sets the sections, and deliberately prefills nothing: an expense being
 * edited was booked the way it was booked.
 */
function expenseWatch(row = {}) {
  let lastVendorId = row.vendor_id || null;
  let lastPaidFrom = row.paid_from_account_id || '';

  return (name, values, api) => {
    const opening = name === null;

    // A vendor knows where its bills go. That is what vendors.default_account_id
    // in schema.sql was added for, and until now nothing ever read it.
    const vendor = matchVendor(values.vendor, state.vendors);
    const vendorId = vendor ? vendor.id : null;
    if (!opening && vendorId !== lastVendorId) {
      lastVendorId = vendorId;
      if (vendor && vendor.default_account_id
          && spendAccounts().some((a) => a.id === vendor.default_account_id)) {
        api.set('account_id', vendor.default_account_id);
      }
    }

    // Money out of a card left on a card. Only ever set for an account whose
    // subtype answers the question — a member's capital account means they
    // paid it personally, and how is theirs to say.
    if (!opening && values.paid_from_account_id !== lastPaidFrom) {
      lastPaidFrom = values.paid_from_account_id;
      const account = state.accounts.find((a) => a.id === values.paid_from_account_id);
      const method = defaultMethodFor(account);
      if (method) api.set('method', method);
    }

    const account = state.accounts.find((a) => a.id === values.account_id) || null;
    const needed = Boolean(account && account.needs_substantiation);

    // The miles box belongs to one account and looks like a demand everywhere
    // else. Shown anyway where a value is already in it, so an edit can never
    // strand a number the books were built on.
    api.show('miles', (account && account.code === MILEAGE_ACCOUNT_CODE)
      || Boolean(values.miles));

    // Same three fields either way; what changes is whether the summary line
    // says the IRS is waiting on them. substantiationGaps is the authority the
    // expense list already reports against, so the form and the list cannot
    // disagree about what is missing.
    const gaps = substantiationGaps({
      place: values.place,
      business_purpose: values.business_purpose,
      attendees: values.attendees,
      miles: values.miles,
    }, account);

    if (!needed) {
      api.note('story', 'Optional for this category — worth a line anyway.');
    } else if (gaps.length) {
      api.note('story', `${accountLabel(account)} needs ${gaps.join(', ')}.`);
    } else {
      api.note('story', `${accountLabel(account)} — all three recorded.`);
    }

    // Opened, never closed. A section that shut itself while somebody was
    // reading it would be worse than one that never opened.
    if (needed || values.place || values.business_purpose || values.attendees) {
      api.openGroup('story');
    }
  };
}

/**
 * The vendor a typed name means, adding one where the name is new.
 *
 * Auto-creating is the hinge the rest of this turns on. The category prefill
 * reads vendors.default_account_id, and a vendor table nobody ever fills in
 * has nothing to read — which is exactly where this ledger was: zero vendors,
 * a column added for this job, and a select of saved vendors that was always
 * empty. Recording an expense is now what populates it, so the second Adobe
 * charge is a date and an amount.
 *
 * Nothing here can fail the expense. A name that lost a race with the unique
 * index on lower(name), or a write refused outright, falls back to
 * vendor_name — the column that exists so that adding a vendor record is a
 * choice rather than a toll gate on recording a receipt.
 */
async function resolveVendor(name, accountId) {
  const typed = String(name || '').trim();
  if (!typed) return { vendor_id: null, vendor_name: null, created: null };

  const existing = matchVendor(typed, state.vendors);
  if (existing) {
    // A vendor added through the Vendors panel usually has no category on it.
    // Filling that blank from the first expense booked against it is what
    // makes the second one fill itself. Never overwrites a chosen category.
    if (!existing.default_account_id && accountId) {
      try {
        await saveVendor(existing.id, { default_account_id: accountId });
      } catch {
        // A category that did not stick costs one select next time.
      }
    }
    return { vendor_id: existing.id, vendor_name: null, created: null };
  }

  try {
    const id = await saveVendor(null, { name: typed, default_account_id: accountId || null });
    return { vendor_id: id, vendor_name: null, created: typed };
  } catch {
    return { vendor_id: null, vendor_name: typed, created: null };
  }
}

function expensePatch(values, vendorRef = {}) {
  if (!values.account_id) throw new Error('Pick a category.');
  if (!values.paid_from_account_id) throw new Error('Pick what paid for it.');

  const miles = values.miles === '' ? null : Number(values.miles);
  if (miles !== null && (!Number.isFinite(miles) || miles < 0)) {
    throw new Error('That mileage is not a number.');
  }

  // A mileage claim can price itself. Entering 46 miles and nothing else is the
  // whole interaction, which is the only way a mileage log ever gets kept.
  const rate = (state.settings && state.settings.mileage_rate_cents) || 70;
  let amount = parseMoney(values.amount);
  if (amount === null && miles) amount = mileageAmount(miles, rate);

  if (amount === null) throw new Error('That amount is not a number.');
  if (amount === 0) throw new Error('An expense of nothing is not an expense.');

  return {
    spent_on: values.spent_on,
    amount_cents: amount,
    place: values.place || null,
    business_purpose: values.business_purpose || null,
    attendees: values.attendees || null,
    miles,
    vendor_id: vendorRef.vendor_id || null,
    vendor_name: vendorRef.vendor_id ? null : (vendorRef.vendor_name || null),
    account_id: values.account_id,
    paid_from_account_id: values.paid_from_account_id,
    description: values.description || null,
    method: values.method,
    reference: values.reference || null,
    client_id: values.client_id || null,
    billable: Boolean(values.billable) && Boolean(values.client_id),
  };
}

async function addExpense() {
  if (!spendAccounts().length || !payFromAccounts().length) {
    toast('The chart needs at least one expense account and one account to pay '
        + 'from before an expense can be recorded.', 'error');
    return;
  }

  let added = null;

  const result = await formModal({
    title: 'Record an expense',
    submitLabel: 'Record it',
    intro: 'Money already spent. It posts itself to the books: what it was for '
         + 'goes up, and what paid for it goes down.',
    ...expenseForm(),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor, values.account_id);
      added = vendorRef.created;
      await saveExpense(null,
        { ...expensePatch(values, vendorRef), created_by: state.profileId });
      rememberPrefs({ paidFrom: values.paid_from_account_id, method: values.method });
    },
  });

  if (result) {
    await refresh(renderExpenses);
    toast(added
      ? `Expense recorded. ${added} is saved as a vendor — its category fills itself next time.`
      : 'Expense recorded.', 'ok');
  }
}

async function editExpense(row) {
  const result = await formModal({
    title: 'Edit expense',
    intro: 'Changing this rewrites its entry in the books.',
    ...expenseForm(row),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor, values.account_id);
      await saveExpense(row.id, expensePatch(values, vendorRef));
    },
    onDelete: async () => { await deleteExpense(row.id); },
    deleteLabel: 'Delete expense',
  });

  if (result) {
    await refresh(renderExpenses);
    toast(result === 'deleted' ? 'Expense deleted.' : 'Expense updated.', 'ok');
  }
}

// Receipts
// ---------------------------------------------------------------------------

/**
 * Shrink and file a batch of photographs against one expense.
 *
 * Every image is shrunk before it leaves the browser: a phone photograph is
 * 4–8 MB and a legible receipt is about 300 KB. A small thumbnail goes up
 * alongside it so the gallery does not have to download the full-size one to
 * show a postage stamp. Neither step can fail the upload — a format the
 * browser cannot decode goes up untouched.
 *
 * A file that fails becomes a toast, never a throw: this runs after the
 * expense row exists, and a photograph that would not upload must not undo —
 * or double — the record it belongs to.
 */
async function uploadReceipts(expenseId, files, startPosition = 0) {
  let position = startPosition;

  for (const original of files) {
    try {
      if (original.size > MAX_UPLOAD_BYTES * 4) {
        throw new Error(`${original.name} is ${fmtBytes(original.size)}, which is more `
          + 'than this can shrink. Photograph it again at a lower resolution.');
      }

      // eslint-disable-next-line no-await-in-loop
      const { file } = await shrinkImage(original);
      // eslint-disable-next-line no-await-in-loop
      const thumb = await makeThumbnail(file);

      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`${original.name} is still ${fmtBytes(file.size)} after `
          + `shrinking. The limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`);
      }

      const stem = `${expenseId}/${crypto.randomUUID()}`;
      const path = `${stem}-${safeName(file.name)}`;

      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (error) throw new Error(errorMessage(error));

      let thumbPath = null;
      if (thumb) {
        thumbPath = `${stem}-thumb.jpg`;
        // A missing thumbnail is a cosmetic problem, so a failure here must not
        // lose the receipt that already uploaded.
        // eslint-disable-next-line no-await-in-loop
        const thumbUpload = await supabase.storage
          .from(RECEIPT_BUCKET)
          .upload(thumbPath, thumb, { contentType: 'image/jpeg' });
        if (thumbUpload.error) thumbPath = null;
      }

      // eslint-disable-next-line no-await-in-loop
      await addReceipt({
        expense_id: expenseId,
        storage_path: path,
        thumb_path: thumbPath,
        name: original.name,
        size_bytes: file.size,
        mime_type: file.type || null,
        captured_on: original.lastModified
          ? new Date(original.lastModified).toISOString().slice(0, 10)
          : null,
        position,
      });
      position += 1;
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  return position - startPosition;
}

/**
 * Photograph a receipt, or pick several off the phone, for a row that exists.
 *
 * Two entry points on purpose. `capture` opens the camera straight away, which
 * is the one that matters — a receipt filed at the table is a receipt that gets
 * filed at all. The other opens the library, for the evening spent working
 * through a drawer of paper.
 */
async function captureReceipts(row, { fromCamera = false } = {}) {
  const files = await pickFile({
    accept: 'application/pdf,image/*',
    multiple: !fromCamera,
    capture: fromCamera ? 'environment' : '',
  });

  const chosen = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!chosen.length) return;

  toast(`Uploading ${chosen.length} ${chosen.length === 1 ? 'photo' : 'photos'}…`);
  const filed = await uploadReceipts(row.id, chosen, (row.expense_receipts || []).length);

  await refresh(renderExpenses);
  if (filed) toast('Receipt filed.', 'ok');
}

/**
 * The other way round: start from the photograph.
 *
 * "Record an expense, find its row, add the photo" is three steps, and the
 * third is the one that gets skipped at a lunch counter. This is one step —
 * pick or take the picture first, and the form builds the expense around it,
 * with the date read off the photograph. The receipt files itself the moment
 * the expense is recorded.
 */
async function snapExpense() {
  if (!spendAccounts().length || !payFromAccounts().length) {
    toast('The chart needs at least one expense account and one account to pay '
        + 'from before an expense can be recorded.', 'error');
    return;
  }

  const files = await pickFile({ accept: 'application/pdf,image/*', multiple: true });
  const chosen = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!chosen.length) return;

  // A photo from the library knows the day the receipt was actually
  // photographed, which beats defaulting to today and being quietly wrong.
  let spentOn;
  const shotAt = chosen[0].lastModified ? new Date(chosen[0].lastModified) : null;
  if (shotAt && !Number.isNaN(shotAt.getTime())) {
    spentOn = [
      shotAt.getFullYear(),
      String(shotAt.getMonth() + 1).padStart(2, '0'),
      String(shotAt.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const result = await formModal({
    title: 'Record it from the receipt',
    submitLabel: 'Record it',
    intro: (chosen.length === 1
      ? 'One photograph ready — it files itself when you record the expense. '
      : `${chosen.length} photographs ready — they file themselves when you record the expense. `)
      + 'The date is read off the photo; correct it if the receipt is older.',
    ...expenseForm({ spent_on: spentOn }),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor, values.account_id);
      const id = await saveExpense(null,
        { ...expensePatch(values, vendorRef), created_by: state.profileId });
      rememberPrefs({ paidFrom: values.paid_from_account_id, method: values.method });
      // uploadReceipts toasts its own failures and never throws — the expense
      // is already recorded, and a retry of this form would record it twice.
      await uploadReceipts(id, chosen, 0);
    },
  });

  if (result) {
    await refresh(renderExpenses);
    toast('Expense recorded, receipt filed.', 'ok');
  }
}

/** A short-lived signed URL, the same way every other private file in the portal
 *  is read. The bucket is never public. */
async function signedUrl(path) {
  const { data, error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .createSignedUrl(path, 300);
  if (error) throw new Error(errorMessage(error));
  return data.signedUrl;
}

async function openReceipt(receipt) {
  try {
    window.open(await signedUrl(receipt.storage_path), '_blank', 'noopener');
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

async function removeReceipt(receipt) {
  const ok = await confirmModal({
    title: `Remove ${receipt.name}?`,
    body: 'The photograph is deleted. If this is the only proof of the expense, the '
      + 'deduction goes with it.',
    confirmLabel: 'Remove receipt',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await supabase.storage.from(RECEIPT_BUCKET).remove(
      [receipt.storage_path, receipt.thumb_path].filter(Boolean),
    );
    await deleteReceipt(receipt.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  await refresh(renderExpenses);
  toast('Receipt removed.', 'ok');
}

/**
 * The gallery for one expense.
 *
 * Thumbnails are fetched through signed URLs the moment the row opens, which is
 * why they are small: twelve full-size photographs would be twelve megabytes to
 * look at twelve stamps.
 */
function receiptGallery(row) {
  const receipts = (row.expense_receipts || [])
    .slice()
    .sort((a, b) => a.position - b.position);

  const strip = el('div', { class: 'receipt-strip' });

  receipts.forEach((receipt) => {
    const isImage = /^image\//.test(receipt.mime_type || '');
    const tile = el('button', {
      class: 'receipt',
      type: 'button',
      title: receipt.name,
      'aria-label': `Open ${receipt.name}`,
      onclick: () => openReceipt(receipt),
    }, [
      isImage
        ? el('span', { class: 'receipt__img', 'data-loading': 'true' })
        : el('span', { class: 'receipt__doc', text: 'PDF' }),
    ]);

    // Signed URLs expire, so they are fetched when the gallery draws rather
    // than stored anywhere.
    if (isImage) {
      signedUrl(receipt.thumb_path || receipt.storage_path)
        .then((url) => {
          const img = el('img', { src: url, alt: receipt.name, loading: 'lazy' });
          mount(tile, img);
        })
        .catch(() => {
          mount(tile, el('span', { class: 'receipt__doc', text: 'gone' }));
        });
    }

    strip.append(el('span', { class: 'receipt-wrap' }, [
      tile,
      el('button', {
        class: 'receipt__remove',
        type: 'button',
        text: '×',
        'aria-label': `Remove ${receipt.name}`,
        onclick: () => removeReceipt(receipt),
      }),
    ]));
  });

  // Deliberately quiet. These sit on every row of a long table, and two loud
  // buttons per row would make the receipts the loudest thing on a screen about
  // money. The camera comes first because that is the one that matters at the
  // table; the label says "Photo" rather than "Take a photo" for the same
  // reason — a row is not where a sentence goes.
  strip.append(el('span', { class: 'receipt-actions' }, [
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Photo',
      'aria-label': `Photograph a receipt for this ${formatMoney(row.amount_cents)} expense`,
      onclick: () => captureReceipts(row, { fromCamera: true }),
    }),
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: 'Upload',
      'aria-label': `Upload a receipt for this ${formatMoney(row.amount_cents)} expense`,
      onclick: () => captureReceipts(row, { fromCamera: false }),
    }),
  ]));

  return strip;
}

// The expense list
// ---------------------------------------------------------------------------

const HEADINGS = ['Date', 'Paid to', 'Category', 'Paid with', 'Amount', 'Receipts', ''];

/** The account an expense was booked to, for the substantiation check. */
function accountFor(row) {
  return state.accounts.find((a) => a.id === row.account_id) || null;
}

function filtered() {
  const needle = state.search.trim().toLowerCase();

  return state.expenses.filter((row) => {
    if (state.accountId && row.account_id !== state.accountId) return false;
    if (state.enteredBy && row.created_by !== state.enteredBy) return false;
    if (!needle) return true;

    // Everything a person might remember about it a year later, which is the
    // whole point of "recall them any time": who, what, where, and who with.
    const haystack = [
      (row.vendors && row.vendors.name) || row.vendor_name,
      row.description,
      row.reference,
      row.place,
      row.business_purpose,
      row.attendees,
      row.account && row.account.name,
      (row.clients && row.clients.name),
      row.creator && row.creator.full_name,
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(needle);
  });
}

function expenseRow(row) {
  const vendor = (row.vendors && row.vendors.name) || row.vendor_name || '—';
  const gaps = substantiationGaps(row, accountFor(row));

  return el('tr', {}, [
    el('td', { class: 'is-tight', text: fmtDate(row.spent_on) }),
    el('td', { class: 'is-roomy' }, [
      el('span', { class: 'sow-cell__name', text: vendor }),
      row.description ? el('span', { class: 'sow-cell__desc', text: row.description }) : null,
      // The story, where there is one. Shown rather than hidden behind an edit,
      // because the point of recording it is being able to read it later.
      row.business_purpose
        ? el('span', { class: 'sow-cell__desc', text: row.business_purpose })
        : null,
      row.attendees ? el('span', { class: 'sow-cell__desc', text: `With ${row.attendees}` }) : null,
      row.place ? el('span', { class: 'sow-cell__desc', text: row.place }) : null,
      row.miles ? el('span', { class: 'sow-cell__desc', text: `${row.miles} miles` }) : null,
      el('span', { class: 'sow-cell__desc', text: `Entered by ${personName(row.creator)}` }),
      gaps.length
        ? el('span', {
          // --wrap because this one is a sentence, not a status word: nowrap
          // made it 451px wide and took the page sideways on a phone.
          class: 'pill pill--amber pill--wrap',
          text: `Missing ${gaps.join(', ')}`,
        })
        : null,
    ]),
    el('td', { class: 'is-tight' }, [
      el('span', { text: row.account ? accountLabel(row.account) : '—' }),
      row.clients
        ? el('span', { class: 'sow-cell__desc',
          text: `${row.clients.name}${row.billable ? ' · to bill back' : ''}` })
        : null,
    ]),
    el('td', { class: 'is-tight' }, [
      el('span', { text: row.paid_from ? row.paid_from.name : '—' }),
      el('span', { class: 'sow-cell__desc', text: methodLabel(row.method) }),
    ]),
    el('td', { class: 'is-numeric', text: formatMoney(row.amount_cents) }),
    el('td', {}, [receiptGallery(row)]),
    el('td', {}, [
      el('button', {
        class: 'btn btn--ghost btn--tiny',
        type: 'button',
        text: 'Edit',
        'aria-label': `Edit the ${formatMoney(row.amount_cents)} expense for ${vendor}`,
        onclick: () => editExpense(row),
      }),
    ]),
  ]);
}

function renderExpenses() {
  const rows = filtered();

  if (!state.expenses.length) {
    mount(expenseTable, el('p', {
      class: 'empty',
      text: 'No expenses recorded in this period. Every one you record is a cost '
          + 'the studio does not pay tax on.',
    }));
    return;
  }

  if (!rows.length) {
    mount(expenseTable, el('p', { class: 'empty', text: 'Nothing matches that search. Try fewer letters, or clear the filters.' }));
    return;
  }

  const total = rows.reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  const noReceipt = rows.filter((row) => !(row.expense_receipts || []).length).length;
  const unsubstantiated = rows.filter(
    (row) => substantiationGaps(row, accountFor(row)).length,
  ).length;

  const problems = [];
  if (noReceipt) problems.push(`${noReceipt} with no receipt`);
  if (unsubstantiated) {
    problems.push(`${unsubstantiated} missing the who, what or where the IRS asks for`);
  }

  mount(expenseTable,
    table(HEADINGS, rows.map(expenseRow), { wide: true }),
    el('p', {
      class: problems.length ? 'notice notice--warn' : 'progress__label',
      text: `${rows.length} of ${state.expenses.length} shown · ${formatMoney(total)} total`
          + (problems.length
            ? ` · ${problems.join(' · ')}`
            : ' · every one has its receipt and its story'),
    }),
  );
}

function buildFilters() {
  const from = el('input', {
    type: 'date', id: 'exp-from', value: state.from,
    onchange: async (event) => { state.from = event.target.value; await refresh(renderExpenses); },
  });
  const to = el('input', {
    type: 'date', id: 'exp-to', value: state.to,
    onchange: async (event) => { state.to = event.target.value; await refresh(renderExpenses); },
  });
  const search = el('input', {
    type: 'search', id: 'exp-search', placeholder: 'Vendor, description, reference',
    oninput: (event) => { state.search = event.target.value; renderExpenses(); },
  });
  const account = el('select', {
    id: 'exp-account',
    onchange: (event) => { state.accountId = event.target.value; renderExpenses(); },
  }, [
    el('option', { value: '', text: 'Every category' }),
    ...spendAccounts().map((a) => el('option', { value: a.id, text: accountLabel(a) })),
  ]);
  const who = el('select', {
    id: 'exp-who',
    onchange: (event) => { state.enteredBy = event.target.value; renderExpenses(); },
  }, [
    el('option', { value: '', text: 'Anyone' }),
    ...state.owners.map((member) => el('option', {
      value: member.profile_id,
      text: (member.profiles && member.profiles.full_name) || memberName(member),
    })),
  ]);

  return el('div', { class: 'filters' }, [
    el('div', { class: 'form-field' }, [el('label', { for: 'exp-from', text: 'From' }), from]),
    el('div', { class: 'form-field' }, [el('label', { for: 'exp-to', text: 'To' }), to]),
    el('div', { class: 'form-field' }, [el('label', { for: 'exp-search', text: 'Search' }), search]),
    el('div', { class: 'form-field' }, [el('label', { for: 'exp-account', text: 'Category' }), account]),
    el('div', { class: 'form-field' }, [el('label', { for: 'exp-who', text: 'Entered by' }), who]),
  ]);
}

function exportCsv() {
  downloadCsv(`njd-expenses-${todayIso()}.csv`,
    ['Date', 'Entered by', 'Vendor', 'Description', 'Category code', 'Category',
      'Paid from', 'Method', 'Reference', 'Client', 'Billable', 'Where',
      'Business purpose', 'Who was there', 'Miles', 'Amount', 'Receipts'],
    filtered().map((row) => [
      row.spent_on,
      personName(row.creator),
      (row.vendors && row.vendors.name) || row.vendor_name || '',
      row.description || '',
      (row.account && row.account.code) || '',
      (row.account && row.account.name) || '',
      (row.paid_from && row.paid_from.name) || '',
      methodLabel(row.method),
      row.reference || '',
      (row.clients && row.clients.name) || '',
      row.billable ? 'yes' : 'no',
      row.place || '',
      row.business_purpose || '',
      row.attendees || '',
      row.miles == null ? '' : row.miles,
      (row.amount_cents / 100).toFixed(2),
      (row.expense_receipts || []).length,
    ]));
}

// The subscription stack
// ---------------------------------------------------------------------------

/** Record buttons in flight, so a double tap cannot book a month twice. */
const recordingIds = new Set();

function monthName(dateIso) {
  return new Date(`${dateIso}T12:00:00`).toLocaleString([], { month: 'long' });
}

/**
 * Record the oldest month a template is waiting on.
 *
 * One month per tap, deliberately: a lapse backfills as a visible walk —
 * June, tap, July, tap, August — rather than as a silent burst of rows, and
 * each expense lands dated the day the charge actually hit the card.
 */
async function recordRecurring(template) {
  const status = recurringStatus(template, todayIso());
  if (!status.due || recordingIds.has(template.id)) return;
  recordingIds.add(template.id);

  try {
    await saveExpense(null, {
      created_by: state.profileId,
      spent_on: status.dueOn,
      vendor_id: template.vendor_id || null,
      vendor_name: template.vendor_id ? null : (template.vendor_name || null),
      account_id: template.account_id,
      paid_from_account_id: template.paid_from_account_id,
      amount_cents: template.amount_cents,
      description: template.name,
      method: template.method,
      client_id: template.client_id || null,
      billable: Boolean(template.billable) && Boolean(template.client_id),
    });
    await saveRecurring(template.id, { last_recorded_on: status.dueOn });
  } catch (error) {
    toast(errorMessage(error), 'error');
    recordingIds.delete(template.id);
    return;
  }

  recordingIds.delete(template.id);
  await refresh(renderAll);

  const after = recurringStatus(
    { ...template, last_recorded_on: status.dueOn }, todayIso(),
  );
  toast(`${template.name} recorded for ${monthName(status.dueOn)}.`
    + (after.due ? ` ${monthName(after.dueOn)} is still waiting — tap again.` : ''), 'ok');
}

async function editRecurring(row = null) {
  const vendors = state.vendors.filter((v) => !v.archived_at || (row && v.id === row.vendor_id));

  const result = await formModal({
    title: row ? row.name : 'Add a subscription',
    submitLabel: row ? 'Save' : 'Add',
    intro: 'A template, not automation: the charge is surfaced when its day comes '
         + 'and recorded with a tap, so a cancelled subscription can never keep '
         + 'billing the books unattended.',
    fields: [
      { name: 'name', label: 'What it is', type: 'text', required: true,
        value: row ? row.name : '',
        hint: '"Adobe Creative Cloud". Becomes the expense\'s description.' },
      { name: 'amount', label: 'Amount each month', type: 'text', inputmode: 'decimal',
        required: true,
        value: row && row.amount_cents ? formatMoney(row.amount_cents).replace(/^\$/, '') : '' },
      {
        name: 'vendor_id',
        label: 'Who it is paid to',
        type: 'select',
        value: row ? row.vendor_id || '' : '',
        options: [
          { value: '', label: 'Not a saved vendor' },
          ...vendors.map((v) => ({ value: v.id, label: v.name })),
        ],
      },
      { name: 'vendor_name', label: 'Or type a name', type: 'text',
        value: row ? row.vendor_name || '' : '',
        hint: 'Only read when no vendor is picked above.' },
      {
        name: 'account_id',
        label: 'Category',
        type: 'select',
        value: row ? row.account_id || '' : '',
        options: categoryOptions(),
      },
      {
        name: 'paid_from_account_id',
        label: 'What pays for it',
        type: 'select',
        value: row ? row.paid_from_account_id || '' : '',
        options: payFromOptions(),
      },
      {
        name: 'method',
        label: 'How',
        type: 'select',
        value: row ? row.method : 'card',
        options: PAYMENT_METHODS,
      },
      { name: 'day_of_month', label: 'Day of the month it bills', type: 'text',
        inputmode: 'numeric', required: true,
        value: row ? String(row.day_of_month) : '1',
        hint: '1 to 31. A 31 bills short months on their last day.' },
      {
        name: 'client_id',
        label: 'For a client',
        type: 'select',
        value: row ? row.client_id || '' : '',
        options: [
          { value: '', label: 'An overhead, not a job cost' },
          ...state.clients.map((c) => ({ value: c.id, label: c.name })),
        ],
      },
      { name: 'billable', label: 'Meant to be billed back to them', type: 'checkbox',
        value: row ? Boolean(row.billable) : false },
      row ? { name: 'active', label: 'Active — surface it when it falls due',
        type: 'checkbox', value: Boolean(row.active) } : null,
    ].filter(Boolean),
    onSubmit: async (values) => {
      if (!values.account_id) throw new Error('Pick a category.');
      if (!values.paid_from_account_id) throw new Error('Pick what pays for it.');

      const amount = parseMoney(values.amount);
      if (amount === null) throw new Error('That amount is not a number.');
      if (amount === 0) throw new Error('A subscription of nothing is not a subscription.');

      const day = Number(values.day_of_month);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error('The billing day is a number from 1 to 31.');
      }

      await saveRecurring(row ? row.id : null, {
        name: values.name.trim(),
        vendor_id: values.vendor_id || null,
        vendor_name: values.vendor_id ? null : (values.vendor_name || null),
        account_id: values.account_id,
        paid_from_account_id: values.paid_from_account_id,
        amount_cents: amount,
        method: values.method,
        day_of_month: day,
        client_id: values.client_id || null,
        billable: Boolean(values.billable) && Boolean(values.client_id),
        active: row ? Boolean(values.active) : true,
      });
    },
    onDelete: row ? async () => { await deleteRecurring(row.id); } : undefined,
    deleteLabel: 'Delete subscription',
    confirmDelete: {
      body: 'The template goes; every expense it already recorded stays on the books.',
    },
  });

  if (result) {
    await refresh(renderAll);
    toast(result === 'deleted' ? 'Subscription deleted.' : 'Subscription saved.', 'ok');
  }
}

function recurringRow(template) {
  const status = recurringStatus(template, todayIso());
  const account = state.accounts.find((a) => a.id === template.account_id);
  const vendor = (template.vendors && template.vendors.name) || template.vendor_name;

  let standing;
  if (!template.active) {
    standing = el('span', { class: 'pill', text: 'Paused' });
  } else if (status.due) {
    standing = el('span', {
      class: 'pill pill--amber pill--wrap',
      text: status.behind > 1
        ? `${status.behind} months waiting — oldest is ${monthName(status.dueOn)}`
        : `Due — ${monthName(status.dueOn)} not recorded yet`,
    });
  } else {
    standing = el('span', {
      class: 'progress__label',
      text: template.last_recorded_on
        ? `Recorded for ${monthName(template.last_recorded_on)}`
        : `First bill ${fmtDate(status.dueOn)}`,
    });
  }

  return el('tr', {}, [
    el('td', { class: 'is-roomy' }, [
      el('span', { class: 'sow-cell__name', text: template.name }),
      vendor ? el('span', { class: 'sow-cell__desc', text: vendor }) : null,
      template.clients
        ? el('span', { class: 'sow-cell__desc',
          text: `${template.clients.name}${template.billable ? ' · to bill back' : ''}` })
        : null,
    ]),
    el('td', { class: 'is-tight' }, [
      el('span', { text: account ? accountLabel(account) : '—' }),
      el('span', { class: 'sow-cell__desc',
        text: `Day ${template.day_of_month} · ${methodLabel(template.method)}` }),
    ]),
    el('td', { class: 'is-numeric', text: formatMoney(template.amount_cents) }),
    el('td', {}, [standing]),
    el('td', {}, [
      el('span', { class: 'btn-row' }, [
        template.active && status.due
          ? el('button', {
            class: 'btn btn--small',
            type: 'button',
            text: `Record ${monthName(status.dueOn)}`,
            'aria-label': `Record ${template.name} for ${monthName(status.dueOn)}`,
            onclick: () => recordRecurring(template),
          })
          : null,
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit the subscription ${template.name}`,
          onclick: () => editRecurring(template),
        }),
      ]),
    ]),
  ]);
}

function renderRecurring() {
  if (!state.recurring.length) {
    mount(recurringTable, el('p', {
      class: 'empty',
      text: 'Nothing recurring yet. The monthly stack — Adobe, Figma, hosting — is '
          + 'the spend most reliably forgotten, and a missed subscription is a '
          + 'missed deduction. Add each one once and this panel does the remembering.',
    }));
    return;
  }

  const due = state.recurring
    .reduce((count, t) => count + (recurringStatus(t, todayIso()).due ? 1 : 0), 0);

  mount(recurringTable,
    table(['Subscription', 'Books to', 'Amount', 'Standing', ''],
      state.recurring.map(recurringRow), { wide: true }),
    el('p', {
      class: due ? 'notice notice--warn' : 'progress__label',
      text: due
        ? `${due} waiting to be recorded.`
        : 'Every subscription is recorded up to date.',
    }));
}

// Vendors
// ---------------------------------------------------------------------------

async function editVendor(row = null) {
  const result = await formModal({
    title: row ? row.name : 'Add a vendor',
    submitLabel: row ? 'Save' : 'Add',
    intro: 'Kept light on purpose — this is not a second CRM. It exists so that '
         + '"what did we spend at Adobe this year" has an answer, and so that '
         + 'January\'s 1099 filing is a report rather than a memory test.',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, value: row ? row.name : '' },
      { name: 'email', label: 'Email', type: 'email', value: row ? row.email || '' : '' },
      { name: 'phone', label: 'Phone', type: 'text', value: row ? row.phone || '' : '' },
      {
        name: 'default_account_id',
        label: 'Their bills usually go to',
        type: 'select',
        value: row ? row.default_account_id || '' : '',
        options: [
          { value: '', label: 'No usual category' },
          ...spendAccounts().map((a) => ({ value: a.id, label: accountLabel(a) })),
        ],
      },
      { name: 'files_1099', label: 'Needs a 1099 at year end', type: 'checkbox',
        value: row ? Boolean(row.files_1099) : false },
      { name: 'tax_id_on_file', label: 'W-9 collected', type: 'checkbox',
        value: row ? Boolean(row.tax_id_on_file) : false },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2,
        value: row ? row.notes || '' : '' },
    ],
    onSubmit: async (values) => {
      await saveVendor(row ? row.id : null, {
        name: values.name.trim(),
        email: values.email || null,
        phone: values.phone || null,
        default_account_id: values.default_account_id || null,
        files_1099: Boolean(values.files_1099),
        tax_id_on_file: Boolean(values.tax_id_on_file),
        notes: values.notes || null,
      });
    },
  });

  if (result) {
    await refresh(renderVendors);
    toast('Vendor saved.', 'ok');
  }
}

function renderVendors() {
  const rows = state.vendors.filter((row) => !row.archived_at);

  if (!rows.length) {
    mount(vendorTable, el('p', {
      class: 'empty',
      text: 'No vendors yet. Adding one is optional — an expense can name anybody — '
          + 'but a contractor who might need a 1099 is worth having here.',
    }));
    return;
  }

  const spent = new Map();
  state.expenses.forEach((row) => {
    if (!row.vendor_id) return;
    spent.set(row.vendor_id, (spent.get(row.vendor_id) || 0) + (Number(row.amount_cents) || 0));
  });

  mount(vendorTable, table(['Vendor', 'Usually', '1099', 'Paid this period', ''],
    rows.map((row) => {
      const account = state.accounts.find((a) => a.id === row.default_account_id);
      return el('tr', {}, [
        el('td', {}, [
          el('span', { class: 'sow-cell__name', text: row.name }),
          row.email ? el('span', { class: 'sow-cell__desc', text: row.email }) : null,
        ]),
        el('td', { text: account ? accountLabel(account) : '—' }),
        el('td', {}, [
          row.files_1099
            ? el('span', {
              class: row.tax_id_on_file ? 'pill pill--green' : 'pill pill--amber',
              text: row.tax_id_on_file ? 'W-9 on file' : 'No W-9',
            })
            : el('span', { class: 'progress__label', text: '—' }),
        ]),
        el('td', { class: 'is-numeric', text: formatMoney(spent.get(row.id) || 0) }),
        el('td', {}, [
          el('button', {
            class: 'btn btn--ghost btn--tiny',
            type: 'button',
            text: 'Edit',
            'aria-label': `Edit ${row.name}`,
            onclick: () => editVendor(row),
          }),
        ]),
      ]);
    })));
}

function renderAll() {
  renderExpenses();
  renderRecurring();
  renderVendors();
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  // Who recorded it. Set on insert only — an edit by a colleague must not
  // quietly reassign whose expense it was, and the mileage log reads this
  // column to say whose miles a vehicle line covers.
  state.profileId = ctx.profile.id;

  state.from = yearStart();
  state.to = todayIso();

  try {
    await loadAll();
  } catch (error) {
    renderError(error);
    return;
  }

  mount(panels.expenses,
    panelHead('Expenses', el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--small', type: 'button', text: 'Snap a receipt',
        onclick: snapExpense }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Record an expense',
        onclick: addExpense }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Export CSV',
        onclick: exportCsv }),
    ]), 'Money already out of the door. Each one posts itself to the books. '
      + 'Snap a receipt starts from the photograph and builds the expense around it.'),
    buildFilters(),
    expenseTable,
  );

  mount(panels.recurring,
    panelHead('Subscriptions & recurring', el('button', { class: 'btn btn--small',
      type: 'button', text: 'Add a subscription', onclick: () => editRecurring() }),
    'The monthly stack, recorded with a tap when each one falls due. Templates '
    + 'rather than automation: nothing writes to the books unattended, so a '
    + 'cancelled subscription can never keep billing itself.'),
    recurringTable,
  );

  mount(panels.vendors,
    panelHead('Vendors', el('button', { class: 'btn btn--small', type: 'button',
      text: 'Add a vendor', onclick: () => editVendor() }),
    'Anyone unincorporated paid $600 or more for services in a calendar year '
    + 'needs a 1099-NEC. Flagging them here is what makes January easy.'),
    vendorTable,
  );

  mount(byId('portal-root'),
    el('p', { class: 'breadcrumb' }, [el('a', { href: '/portal/admin/ledger/', text: '← Ledger' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Expenses' }),
        el('p', { text: 'What the studio spends, and who it spends it with.' }),
      ]),
    ]),
    panels.expenses,
    panels.recurring,
    panels.vendors,
  );

  renderAll();

  // Arrived from the quick-add button's "Log an expense". Opening a form is a
  // door, not a judgment — nothing is written until the person submits it — but
  // the parameter is still stripped so a refresh does not reopen a form they
  // just cancelled.
  if (shouldAutoOpen(window.location.search, 'new')) {
    window.history.replaceState({}, '', window.location.pathname);
    addExpense();
  }
}

main();
