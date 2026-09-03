// ---------------------------------------------------------------------------
// What the business spends, and who it spends it with.
//
// Recording an expense is the one bookkeeping habit that has to be
// frictionless or it does not happen, and an expense that does not get
// recorded is a deduction the business pays tax on for no reason. So the form
// is short: a date, an amount, who it went to, what it was for. Everything
// else — the client it belongs to, whether it gets billed back, the where and
// why the IRS asks for on a meal — is optional and sits behind a summary line.
//
// Three panels on one page, with a jump bar between them: the expenses
// themselves, the subscriptions that land every month, and the vendors those
// go to. Every write goes through expenses-data.js; every sum goes through
// expenses-model.js, where node --test can hold it to account.
//
// The receipt is worth the extra step. A deduction without one is a deduction
// that does not survive an audit, and photographing it now costs nothing.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { bootstrap, renderError } from './shell.js';
import {
  el, mount, byId, toast, busy, formModal, confirmModal, modalShell,
  fmtDate, panelHead, table, figure, figureRow, filterField,
} from './ui.js';
import { icon } from './icons.js';
import { formatMoney } from './money.js';
import { isoToday } from './doc-common.js';
import { downloadCsv } from './csv.js';
import { pickFile } from './files.js';
import { sectionNav } from './section-nav.js';
import {
  PAYMENT_METHODS,
  RECEIPT_ACCEPT,
  categoryOptions,
  expensePatch,
  filterExpenses,
  formatSigned,
  matchVendor,
  methodLabel,
  monthName,
  MONTH_NAMES,
  receiptMime,
  receiptsOf,
  recentValues,
  recurringPatch,
  recurringStatus,
  scheduleCLabel,
  substantiationGaps,
  sumCents,
  vendorNameOf,
  vendorTotals,
  yearOptions,
} from './expenses-model.js';
import {
  addReceipt,
  archiveVendor,
  deleteExpense,
  deleteReceipt,
  deleteRecurring,
  loadCategories,
  loadClients,
  loadEarliestYear,
  loadExpenses,
  loadNecThreshold,
  loadReceipts,
  loadRecurring,
  loadVendors,
  receiptUrl,
  recordRecurring,
  resolveVendor,
  restoreVendor,
  saveExpense,
  saveRecurring,
  saveVendor,
} from './expenses-data.js';

const state = {
  profileId: null,
  categories: [],
  vendors: [],
  clients: [],
  expenses: [],
  recurring: [],
  necThreshold: 0,
  earliestYear: null,
  // The list filters. The year decides what is loaded; the rest narrow it in
  // the browser, so typing in the search box never waits on the network.
  year: '',
  month: '',
  categoryId: '',
  clientId: '',
  vendorId: '',
  search: '',
  showArchivedVendors: false,
};

const panels = {
  expenses: el('section', { class: 'panel' }),
  recurring: el('section', { class: 'panel' }),
  vendors: el('section', { class: 'panel' }),
};

const figuresBox = el('div', {});
const expenseTable = el('div', {});
const recurringTable = el('div', {});
const vendorTable = el('div', {});

// The three filter selects whose option lists move as vendors and categories
// are added. Kept so a re-render can repopulate them without rebuilding the
// bar — which would take the cursor out of the search box mid-word.
const filterSelects = {};

function currentYear() {
  return Number(isoToday().slice(0, 4));
}

function categoryById(id) {
  return state.categories.find((row) => row.id === id) || null;
}

function activeVendors() {
  return state.vendors.filter((row) => !row.archived_at);
}

function clientOptions(blankLabel) {
  return [
    { value: '', label: blankLabel },
    ...state.clients.map((client) => ({ value: client.id, label: client.name })),
  ];
}

/** Every supplier the books have heard of, saved or typed once, for the
 *  vendor box's datalist. Saved names first, in the casing they were saved. */
function vendorSuggestions() {
  const seen = new Set();
  const out = [];
  [...activeVendors().map((v) => v.name), ...recentValues(state.expenses, 'vendor_name')]
    .forEach((name) => {
      const key = String(name || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(name);
    });
  return out;
}

async function loadAll() {
  const [categories, vendors, clients, expenses, recurring, necThreshold, earliestYear] =
    await Promise.all([
      loadCategories({ includeArchived: true }),
      loadVendors({ includeArchived: true }),
      loadClients(),
      loadExpenses({ year: state.year }),
      loadRecurring(),
      loadNecThreshold(),
      loadEarliestYear(),
    ]);

  Object.assign(state, {
    categories, vendors, clients, expenses, recurring, necThreshold, earliestYear,
  });
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
 * The expense form: the whole shape formModal needs — fields, sections and
 * the watcher that drives one from another — because the three are one
 * design and reading them apart is how they drift.
 *
 * Six questions in the open and the rest behind two summary lines. The
 * vendor names its own category (vendors.default_category_id), and the
 * substantiation section opens itself when the category is one the IRS asks
 * about. Nothing here appears out of nowhere: the sections are on the screen
 * from the start, named, and say on their own summary line what is waiting.
 */
function expenseForm(row = {}) {
  const openingVendor = row.vendor_id
    ? ((state.vendors.find((v) => v.id === row.vendor_id) || {}).name || '')
    : (row.vendor_name || '');

  return {
    groups: [
      {
        key: 'story',
        label: 'Where, why and who',
        hint: 'Optional for most categories.',
        open: Boolean(row.place || row.business_purpose || row.attendees),
      },
      {
        key: 'extras',
        label: 'Client, billing and reference',
        hint: 'Whose job it was, and anything to quote back.',
        open: Boolean(row.client_id || row.reference),
      },
    ],

    fields: [
      { name: 'spent_on', label: 'Date paid', type: 'date', required: true,
        value: row.spent_on || isoToday() },
      { name: 'amount', label: 'Amount', type: 'text', inputmode: 'decimal', required: true,
        value: row.amount_cents ? (row.amount_cents / 100).toFixed(2) : '',
        hint: 'A refund from a supplier is a negative amount.' },
      {
        name: 'vendor',
        label: 'Paid to',
        type: 'text',
        value: openingVendor,
        suggestions: vendorSuggestions(),
        autocapitalize: 'words',
        hint: 'A name used before fills the category in for you. A new one is '
            + 'saved as a vendor, so the next time it does the same.',
      },
      {
        name: 'category_id',
        label: 'Category',
        type: 'select',
        required: true,
        value: row.category_id || '',
        options: [
          { value: '', label: 'Pick a category' },
          ...categoryOptions(state.categories, { keepId: row.category_id || null }),
        ],
      },
      { name: 'description', label: 'What it was', type: 'text',
        value: row.description || '',
        suggestions: recentValues(state.expenses, 'description') },
      { name: 'method', label: 'Paid by', type: 'select',
        value: row.method || 'card', options: PAYMENT_METHODS },

      // The three the IRS asks for on a meal, a trip or a gift.
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
        label: 'Business purpose',
        type: 'text',
        group: 'story',
        value: row.business_purpose || '',
        suggestions: recentValues(state.expenses, 'business_purpose'),
        hint: 'In a few words — "discussing the spring rebrand". This is the '
            + 'field a deduction is most often disallowed for missing.',
      },
      {
        name: 'attendees',
        label: 'Who was there',
        type: 'text',
        group: 'story',
        value: row.attendees || '',
        suggestions: recentValues(state.expenses, 'attendees'),
        hint: 'Names and how they relate to the business — "Dana Reid (prospective '
            + 'client, Acme Co)". Asked for on meals and gifts.',
      },

      {
        name: 'client_id',
        label: 'For a client',
        type: 'select',
        group: 'extras',
        value: row.client_id || '',
        options: clientOptions('An overhead, not a job cost'),
      },
      { name: 'billable', label: 'Bill it back to them', type: 'checkbox',
        group: 'extras', value: Boolean(row.billable) },
      { name: 'reference', label: 'Reference', type: 'text', group: 'extras',
        value: row.reference || '', hint: 'An order or receipt number.' },
    ],

    onChange: expenseWatch(row),
  };
}

/**
 * The part that answers a question with another question's answer.
 *
 * The category prefill is keyed on *what changed*, not on what is empty:
 * filling only-when-blank would leave the category on the first vendor's
 * after you corrected the vendor, and re-imposing it on every keystroke would
 * fight anyone who deliberately booked an Adobe charge somewhere unusual. So
 * it remembers which vendor it last acted on and moves only when that moves.
 *
 * The opening call arrives with `name === null`. It seeds the tracker and
 * sets the sections, and deliberately prefills nothing: an expense being
 * edited was booked the way it was booked.
 */
function expenseWatch(row = {}) {
  let lastVendorId = row.vendor_id || null;

  return (name, values, api) => {
    const opening = name === null;

    const vendor = matchVendor(state.vendors, values.vendor);
    const vendorId = vendor ? vendor.id : null;
    if (!opening && vendorId !== lastVendorId) {
      lastVendorId = vendorId;
      if (vendor && vendor.default_category_id && categoryById(vendor.default_category_id)) {
        api.set('category_id', vendor.default_category_id);
      }
    }

    const category = categoryById(values.category_id);
    const wantsStory = Boolean(category && category.needs_substantiation);
    const wantsWho = Boolean(category && category.needs_attendees);
    const asks = wantsStory || wantsWho;

    // A category with no flags leaves all three on offer, quietly. One with
    // flags shows the ones it asks for and hides the rest — unless a value is
    // already in one, so an edit can never strand something the books hold.
    api.show('place', !asks || wantsStory || Boolean(values.place));
    api.show('business_purpose', !asks || wantsStory || Boolean(values.business_purpose));
    api.show('attendees', !asks || wantsWho || Boolean(values.attendees));

    // substantiationGaps is the authority the list already reports against,
    // so the form and the list cannot disagree about what is missing. It is
    // a warning on the summary line, never a reason the form refuses to save.
    const gaps = substantiationGaps(values, category);
    if (!asks) {
      api.note('story', 'Optional for this category — worth a line anyway.');
    } else if (gaps.length) {
      api.note('story', `${category.name} usually needs ${gaps.join(', ')}. `
        + 'You can still save without it.');
    } else {
      api.note('story', `${category.name} — all recorded.`);
    }

    // Opened, never closed. A section that shut itself while somebody was
    // reading it would be worse than one that never opened.
    if (asks) api.openGroup('story');
  };
}

/** After a save: say what the IRS would still ask for, as a nudge, not a
 *  refusal. */
function gapsToast(patch) {
  const gaps = substantiationGaps(patch, categoryById(patch.category_id));
  if (!gaps.length) return null;
  return `Still missing ${gaps.join(', ')} — edit it when you have a minute.`;
}

async function addExpense() {
  if (!state.categories.some((c) => !c.archived_at)) {
    toast('Add at least one expense category under Admin before recording an expense.', 'error');
    return;
  }

  let created = false;
  let nudge = null;

  const result = await formModal({
    title: 'Add an expense',
    submitLabel: 'Record it',
    intro: 'Money already spent. Say who got it and what it was for; the receipt can follow.',
    ...expenseForm(),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor,
        { vendors: state.vendors, defaultCategoryId: values.category_id });
      created = vendorRef.created;
      const patch = expensePatch(values, vendorRef);
      await saveExpense(null, { ...patch, created_by: state.profileId });
      nudge = gapsToast(patch);
    },
  });

  if (result) {
    await refresh(renderExpenses);
    toast(created
      ? `Expense recorded. ${result.vendor.trim()} is saved as a vendor.`
      : 'Expense recorded.', 'ok');
    if (nudge) toast(nudge);
  }
}

async function editExpense(row) {
  let nudge = null;

  const result = await formModal({
    title: 'Edit expense',
    ...expenseForm(row),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor,
        { vendors: state.vendors, defaultCategoryId: values.category_id });
      const patch = expensePatch(values, vendorRef);
      await saveExpense(row.id, patch);
      nudge = gapsToast(patch);
    },
  });

  if (result) {
    await refresh(renderExpenses);
    toast('Expense updated.', 'ok');
    if (nudge) toast(nudge);
  }
}

async function removeExpense(row) {
  const receipts = receiptsOf(row).length;
  const ok = await confirmModal({
    title: `Delete the ${formatMoney(row.amount_cents)} expense for ${vendorNameOf(row) || 'this vendor'}?`,
    body: [
      receipts
        ? `Its ${receipts === 1 ? 'receipt is' : `${receipts} receipts are`} deleted with it.`
        : '',
      'The deduction goes with it. This cannot be undone.',
    ],
    confirmLabel: 'Delete expense',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await deleteExpense(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }

  await refresh(renderExpenses);
  toast('Expense deleted.', 'ok');
}

/**
 * The other way round: start from the photograph.
 *
 * "Add an expense, find its row, add the photo" is three steps, and the third
 * is the one that gets skipped at a lunch counter. This is one step — the
 * camera opens straight away, and the form builds the expense around the
 * picture. The receipt files itself the moment the expense is recorded.
 */
async function snapExpense() {
  if (!state.categories.some((c) => !c.archived_at)) {
    toast('Add at least one expense category under Admin before recording an expense.', 'error');
    return;
  }

  const file = await pickFile({ accept: RECEIPT_ACCEPT, capture: 'environment' });
  if (!file) return;
  if (!receiptMime(file)) {
    toast(`${file.name} is not a photo or a PDF, which is all a receipt can be.`, 'error');
    return;
  }

  // A photo from the library knows the day it was taken, which beats
  // defaulting to today and being quietly wrong.
  let spentOn = isoToday();
  if (file.lastModified) {
    const shot = new Date(file.lastModified);
    if (!Number.isNaN(shot.getTime())) spentOn = isoToday(shot);
  }

  let filed = false;
  let nudge = null;

  const result = await formModal({
    title: 'Record it from the receipt',
    submitLabel: 'Record it',
    intro: 'The photograph files itself when you record the expense. The date is '
         + 'read off the photo; correct it if the receipt is older.',
    ...expenseForm({ spent_on: spentOn }),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor,
        { vendors: state.vendors, defaultCategoryId: values.category_id });
      const patch = expensePatch(values, vendorRef);
      const id = await saveExpense(null, { ...patch, created_by: state.profileId });
      nudge = gapsToast(patch);
      // The expense is recorded; a photograph that will not upload must not
      // undo it, and a retry of this form would record it twice. So the
      // failure is a toast, and the row's Receipts button is the retry.
      try {
        await addReceipt(id, file, { position: 0, uploadedBy: state.profileId });
        filed = true;
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    },
  });

  if (result) {
    await refresh(renderExpenses);
    toast(filed
      ? 'Expense recorded, receipt filed.'
      : 'Expense recorded. The receipt did not upload — open Receipts on the row to try again.',
    filed ? 'ok' : '');
    if (nudge) toast(nudge);
  }
}

// Receipts
// ---------------------------------------------------------------------------

/**
 * The gallery for one expense: every receipt as a tile, the full-size one a
 * tap away, and the two ways of adding another.
 *
 * Signed URLs are minted as the gallery draws and put straight on the tiles
 * as ordinary links, so opening a receipt is a genuine click on an <a> —
 * which is the one thing a phone browser never pop-up-blocks. They last five
 * minutes, which is longer than a gallery stays open.
 */
async function openReceipts(row) {
  let changed = false;

  const shell = modalShell({
    title: `Receipts — ${vendorNameOf(row) || 'expense'}, ${formatSigned(row.amount_cents)}`,
    onClose: () => { if (changed) refresh(renderExpenses); },
  });
  shell.dialog.classList.add('modal__dialog--wide');

  const strip = el('div', { class: 'receipt-strip receipt-strip--gallery' });
  const status = el('p', { class: 'progress__label' });
  let count = 0;

  shell.body.append(
    el('p', {
      class: 'progress__label',
      text: [fmtDate(row.spent_on), row.category && row.category.name, row.description]
        .filter(Boolean).join(' · '),
    }),
    strip,
    status,
  );

  function tile(receipt) {
    const isImage = /^image\//.test(receipt.mime_type || '');

    // No href until the URL arrives: a link to nowhere is worse than a tile
    // that does nothing for the hundred milliseconds it takes.
    const link = el('a', {
      class: 'receipt',
      target: '_blank',
      rel: 'noopener',
      title: receipt.name,
      'aria-label': `Open ${receipt.name}`,
    }, [
      isImage
        ? el('span', { class: 'receipt__img' })
        : el('span', { class: 'receipt__doc', text: 'PDF' }),
    ]);

    const gone = () => mount(link, el('span', { class: 'receipt__doc', text: 'gone' }));

    receiptUrl(receipt.storage_path)
      .then((url) => { link.href = url; })
      .catch(gone);

    if (isImage) {
      receiptUrl(receipt.thumb_path || receipt.storage_path)
        .then((url) => mount(link, el('img', { src: url, alt: receipt.name, loading: 'lazy' })))
        .catch(gone);
    }

    const remove = el('button', {
      class: 'receipt__remove',
      type: 'button',
      'aria-label': `Remove ${receipt.name}`,
      onclick: busy(async () => {
        const ok = await confirmModal({
          title: `Remove ${receipt.name}?`,
          body: 'The photograph is deleted. If this is the only proof of the expense, '
              + 'the deduction goes with it.',
          confirmLabel: 'Remove receipt',
          tone: 'danger',
        });
        if (!ok) return;
        try {
          await deleteReceipt(receipt);
        } catch (error) {
          toast(errorMessage(error), 'error');
          return;
        }
        changed = true;
        toast('Receipt removed.', 'ok');
        await draw();
      }),
    }, [icon('x', { size: 14 })]);

    return el('span', { class: 'receipt-wrap' }, [link, remove]);
  }

  async function draw() {
    let receipts;
    try {
      receipts = await loadReceipts(row.id);
    } catch (error) {
      shell.showError(error);
      return;
    }
    count = receipts.length;
    mount(strip, receipts.map(tile));
    status.textContent = count
      ? `${count} on file. Tap one to open it full size.`
      : 'No receipt yet. A deduction without one is a deduction that does not survive an audit.';
  }

  /** Photograph one, or pick several off the phone. `capture` opens the
   *  camera straight away, which is the one that matters at the table. */
  async function add({ fromCamera }) {
    const picked = await pickFile({
      accept: RECEIPT_ACCEPT,
      multiple: !fromCamera,
      capture: fromCamera ? 'environment' : '',
    });
    const chosen = (Array.isArray(picked) ? picked : [picked]).filter(Boolean);
    if (!chosen.length) return;

    status.textContent = `Uploading ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}…`;
    let position = count;
    for (const file of chosen) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await addReceipt(row.id, file, { position, uploadedBy: state.profileId });
        position += 1;
        changed = true;
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }
    await draw();
  }

  shell.foot.append(
    el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Take a photo',
      onclick: busy(() => add({ fromCamera: true })),
    }),
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Upload files',
      onclick: busy(() => add({ fromCamera: false })),
    }),
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Close',
      onclick: () => shell.close(null),
    }),
  );

  shell.open();
  await draw();
}

// The expense list
// ---------------------------------------------------------------------------

const HEADINGS = ['Date', 'Paid to', 'Category', 'What for', 'Client', 'Amount', 'Receipts', ''];

function filtered() {
  return filterExpenses(state.expenses, {
    month: state.month,
    categoryId: state.categoryId,
    clientId: state.clientId,
    vendorId: state.vendorId,
    search: state.search,
  });
}

function clientCell(row) {
  if (!row.client) return ['—'];
  let pill = null;
  if (row.billed_invoice_id) pill = el('span', { class: 'pill pill--green', text: 'Billed' });
  else if (row.billable) pill = el('span', { class: 'pill pill--blue', text: 'Billable' });
  return [
    el('span', { class: 'row-cell__name', text: row.client.name }),
    pill,
  ];
}

function expenseRow(row) {
  const vendor = vendorNameOf(row) || '—';
  const gaps = substantiationGaps(row, row.category);
  const receipts = receiptsOf(row).length;

  return el('tr', {}, [
    el('td', { class: 'is-tight', text: fmtDate(row.spent_on) }),
    el('td', {}, [
      el('span', { class: 'row-cell__name', text: vendor }),
      el('span', { class: 'row-cell__desc', text: methodLabel(row.method)
        + (row.reference ? ` · ${row.reference}` : '') }),
    ]),
    el('td', { class: 'is-tight' }, [
      el('span', { text: row.category ? row.category.name : '—' }),
      row.category
        ? el('span', { class: 'row-cell__desc', text: scheduleCLabel(row.category.schedule_c_line) })
        : null,
    ]),
    el('td', { class: 'is-roomy' }, [
      el('span', { class: 'row-cell__name', text: row.description || '—' }),
      // The story, where there is one. Shown rather than hidden behind an
      // edit, because the point of recording it is being able to read it later.
      row.business_purpose
        ? el('span', { class: 'row-cell__desc', text: row.business_purpose })
        : null,
      row.place ? el('span', { class: 'row-cell__desc', text: row.place }) : null,
      row.attendees ? el('span', { class: 'row-cell__desc', text: `With ${row.attendees}` }) : null,
      gaps.length
        ? el('span', {
          // --wrap because this one is a sentence, not a status word: nowrap
          // would take the page sideways on a phone.
          class: 'pill pill--amber pill--wrap',
          text: `Missing ${gaps.join(', ')}`,
        })
        : null,
    ]),
    el('td', {}, clientCell(row)),
    el('td', { class: 'is-numeric', text: formatSigned(row.amount_cents) }),
    el('td', { class: 'is-tight' }, [
      receipts
        ? el('span', { text: String(receipts) })
        : el('span', { class: 'pill pill--amber', text: 'None' }),
    ]),
    el('td', {}, [
      el('span', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit the ${formatMoney(row.amount_cents)} expense for ${vendor}`,
          onclick: () => editExpense(row),
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Receipts',
          'aria-label': `Receipts for the ${formatMoney(row.amount_cents)} expense for ${vendor}`,
          onclick: () => openReceipts(row),
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Delete',
          'aria-label': `Delete the ${formatMoney(row.amount_cents)} expense for ${vendor}`,
          onclick: busy(() => removeExpense(row)),
        }),
      ]),
    ]),
  ]);
}

/** The four numbers over the list, for the loaded year. */
function renderFigures() {
  const year = String(state.year);
  const today = isoToday();
  const thisYear = year === today.slice(0, 4);
  const thisMonthRows = thisYear
    ? state.expenses.filter((row) => String(row.spent_on).slice(0, 7) === today.slice(0, 7))
    : [];
  const unreceipted = state.expenses.filter((row) => !receiptsOf(row).length).length;
  const unbilled = state.expenses.filter((row) => row.billable && !row.billed_invoice_id);

  mount(figuresBox, figureRow([
    figure(`Spent in ${year}`, formatSigned(sumCents(state.expenses)),
      `${state.expenses.length} ${state.expenses.length === 1 ? 'expense' : 'expenses'}`),
    figure('This month',
      thisYear ? formatSigned(sumCents(thisMonthRows)) : '—',
      thisYear ? monthName(today) : `Viewing ${year}`),
    figure('No receipt', String(unreceipted),
      unreceipted ? 'Tap Receipts on a row to add one' : 'Every expense has one',
      unreceipted ? 'bad' : undefined),
    figure('To bill back', formatSigned(sumCents(unbilled)),
      unbilled.length
        ? `${unbilled.length} not yet on an invoice`
        : 'Nothing waiting for an invoice'),
  ]));
}

/** Repopulate a filter select without losing what it is set to. */
function setOptions(select, options) {
  if (!select) return;
  const keep = select.value;
  mount(select, options.map((option) => el('option', { value: option.value, text: option.label })));
  select.value = options.some((option) => option.value === keep) ? keep : '';
}

function refreshFilterOptions() {
  setOptions(filterSelects.category, [
    { value: '', label: 'Every category' },
    ...categoryOptions(state.categories, { keepId: state.categoryId || null }),
  ]);
  setOptions(filterSelects.client, clientOptions('Every client'));
  setOptions(filterSelects.vendor, [
    { value: '', label: 'Every vendor' },
    ...state.vendors
      .filter((v) => !v.archived_at || v.id === state.vendorId)
      .map((v) => ({ value: v.id, label: v.name })),
  ]);
}

function renderExpenses() {
  renderFigures();
  refreshFilterOptions();

  const rows = filtered();

  if (!state.expenses.length) {
    mount(expenseTable, el('p', {
      class: 'empty',
      text: `No expenses recorded in ${state.year}. Every one you record is a cost `
          + 'the business does not pay tax on.',
    }));
    return;
  }

  if (!rows.length) {
    mount(expenseTable, el('p', {
      class: 'empty',
      text: 'Nothing matches those filters. Try fewer letters, or clear them.',
    }));
    return;
  }

  const noReceipt = rows.filter((row) => !receiptsOf(row).length).length;
  const unsubstantiated = rows.filter(
    (row) => substantiationGaps(row, row.category).length,
  ).length;

  const problems = [];
  if (noReceipt) problems.push(`${noReceipt} with no receipt`);
  if (unsubstantiated) problems.push(`${unsubstantiated} missing the where, why or who`);

  mount(expenseTable,
    table(HEADINGS, rows.map(expenseRow), { wide: true }),
    el('p', {
      class: problems.length ? 'notice notice--warn' : 'progress__label',
      text: `${rows.length} of ${state.expenses.length} shown · ${formatSigned(sumCents(rows))} total`
          + (problems.length
            ? ` · ${problems.join(' · ')}`
            : ' · every one has its receipt and its story'),
    }));
}

function buildFilters() {
  const year = el('select', {
    id: 'exp-year',
    onchange: async (event) => {
      state.year = Number(event.target.value);
      await refresh(renderExpenses);
    },
  }, yearOptions(currentYear(), state.earliestYear).map((y) => el('option', {
    value: String(y), text: String(y), selected: y === Number(state.year),
  })));

  const month = el('select', {
    id: 'exp-month',
    onchange: (event) => { state.month = event.target.value; renderExpenses(); },
  }, [
    el('option', { value: '', text: 'Every month' }),
    ...MONTH_NAMES.map((name, index) => el('option', {
      value: String(index + 1), text: name,
    })),
  ]);

  filterSelects.category = el('select', {
    id: 'exp-category',
    onchange: (event) => { state.categoryId = event.target.value; renderExpenses(); },
  });
  filterSelects.client = el('select', {
    id: 'exp-client',
    onchange: (event) => { state.clientId = event.target.value; renderExpenses(); },
  });
  filterSelects.vendor = el('select', {
    id: 'exp-vendor',
    onchange: (event) => { state.vendorId = event.target.value; renderExpenses(); },
  });

  const search = el('input', {
    type: 'search',
    id: 'exp-search',
    placeholder: 'Vendor, description, place, who',
    oninput: (event) => { state.search = event.target.value; renderExpenses(); },
  });

  return el('div', { class: 'filters' }, [
    filterField('exp-year', 'Year', year),
    filterField('exp-month', 'Month', month),
    filterField('exp-category', 'Category', filterSelects.category),
    filterField('exp-client', 'Client', filterSelects.client),
    filterField('exp-vendor', 'Vendor', filterSelects.vendor),
    filterField('exp-search', 'Search', search),
  ]);
}

function exportCsv() {
  const rows = filtered();
  if (!rows.length) {
    toast('Nothing to export — the list is empty.', 'error');
    return;
  }

  downloadCsv(`wo-expenses-${state.year}.csv`,
    ['Date', 'Vendor', 'Category', 'Schedule C line', 'Description', 'Method',
      'Reference', 'Client', 'Billable', 'Billed', 'Where', 'Business purpose',
      'Who was there', 'Amount', 'Receipts', 'Missing'],
    rows.map((row) => [
      row.spent_on,
      vendorNameOf(row),
      (row.category && row.category.name) || '',
      (row.category && row.category.schedule_c_line) || '',
      row.description || '',
      methodLabel(row.method),
      row.reference || '',
      (row.client && row.client.name) || '',
      row.billable ? 'yes' : 'no',
      row.billed_invoice_id ? 'yes' : 'no',
      row.place || '',
      row.business_purpose || '',
      row.attendees || '',
      ((Number(row.amount_cents) || 0) / 100).toFixed(2),
      receiptsOf(row).length,
      substantiationGaps(row, row.category).join(', '),
    ]));
}

// The subscription stack
// ---------------------------------------------------------------------------

/** Record buttons in flight, so a double tap cannot book a month twice. */
const recordingIds = new Set();

/**
 * Record the oldest month a template is waiting on.
 *
 * One month per tap, deliberately: a lapse backfills as a visible walk —
 * June, tap, July, tap, August — rather than as a silent burst of rows, and
 * each expense lands dated the day the charge actually hit the card.
 */
async function recordTemplate(template) {
  const status = recurringStatus(template, isoToday());
  if (!status.due || recordingIds.has(template.id)) return;
  recordingIds.add(template.id);

  try {
    await recordRecurring(template, status.dueOn, { createdBy: state.profileId });
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  } finally {
    recordingIds.delete(template.id);
  }

  await refresh(renderAll);

  const after = recurringStatus({ ...template, last_recorded_on: status.dueOn }, isoToday());
  toast(`${template.name} recorded for ${monthName(status.dueOn)}.`
    + (after.due ? ` ${monthName(after.dueOn)} is still waiting — tap again.` : ''), 'ok');
}

async function pauseTemplate(template) {
  try {
    await saveRecurring(template.id, { active: !template.active });
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh(renderRecurring);
  toast(template.active ? `${template.name} paused.` : `${template.name} resumed.`, 'ok');
}

async function editRecurring(row = null) {
  const openingVendor = row && row.vendor_id
    ? ((state.vendors.find((v) => v.id === row.vendor_id) || {}).name || '')
    : ((row && row.vendor_name) || '');

  const result = await formModal({
    title: row ? row.name : 'Add a subscription',
    submitLabel: row ? 'Save' : 'Add',
    intro: 'A template, not automation: the charge is surfaced when its day comes '
         + 'and recorded with a tap, so a cancelled subscription can never keep '
         + 'billing the books unattended.',
    fields: [
      { name: 'name', label: 'What it is', type: 'text', required: true,
        value: row ? row.name : '',
        hint: '"Adobe Creative Cloud", "Netlify Pro". Becomes the expense\'s description.' },
      { name: 'amount', label: 'Amount each month', type: 'text', inputmode: 'decimal',
        required: true,
        value: row && row.amount_cents ? (row.amount_cents / 100).toFixed(2) : '' },
      {
        name: 'vendor',
        label: 'Paid to',
        type: 'text',
        value: openingVendor,
        suggestions: vendorSuggestions(),
        autocapitalize: 'words',
        hint: 'A new name is saved as a vendor.',
      },
      {
        name: 'category_id',
        label: 'Category',
        type: 'select',
        required: true,
        value: row ? row.category_id || '' : '',
        options: [
          { value: '', label: 'Pick a category' },
          ...categoryOptions(state.categories, { keepId: row ? row.category_id : null }),
        ],
      },
      { name: 'method', label: 'Paid by', type: 'select',
        value: row ? row.method : 'card', options: PAYMENT_METHODS },
      { name: 'day_of_month', label: 'Day of the month it bills', type: 'text',
        inputmode: 'numeric', required: true,
        value: row ? String(row.day_of_month) : '1',
        hint: '1 to 31. A 31 bills short months on their last day.' },
      {
        name: 'client_id',
        label: 'For a client',
        type: 'select',
        value: row ? row.client_id || '' : '',
        options: clientOptions('An overhead, not a job cost'),
      },
      { name: 'billable', label: 'Bill it back to them', type: 'checkbox',
        value: row ? Boolean(row.billable) : false },
      row ? { name: 'active', label: 'Active — surface it when it falls due',
        type: 'checkbox', value: Boolean(row.active) } : null,
    ].filter(Boolean),
    onSubmit: async (values) => {
      const vendorRef = await resolveVendor(values.vendor,
        { vendors: state.vendors, defaultCategoryId: values.category_id });
      const patch = recurringPatch(values, vendorRef);
      if (!row) patch.active = true;
      await saveRecurring(row ? row.id : null,
        row ? patch : { ...patch, created_by: state.profileId });
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
  const status = recurringStatus(template, isoToday());
  const vendor = (template.vendor && template.vendor.name) || template.vendor_name;

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
        ? `Recorded for ${monthName(template.last_recorded_on, { withYear: true })}`
        : `First bill ${fmtDate(status.dueOn)}`,
    });
  }

  return el('tr', {}, [
    el('td', { class: 'is-roomy' }, [
      el('span', { class: 'row-cell__name', text: template.name }),
      vendor ? el('span', { class: 'row-cell__desc', text: vendor }) : null,
      template.client
        ? el('span', { class: 'row-cell__desc',
          text: `${template.client.name}${template.billable ? ' · to bill back' : ''}` })
        : null,
    ]),
    el('td', { class: 'is-tight' }, [
      el('span', { text: template.category ? template.category.name : '—' }),
      el('span', { class: 'row-cell__desc',
        text: `Day ${template.day_of_month} · ${methodLabel(template.method)}` }),
    ]),
    el('td', { class: 'is-numeric', text: formatSigned(template.amount_cents) }),
    el('td', {}, [standing]),
    el('td', {}, [
      el('span', { class: 'btn-row' }, [
        template.active && status.due
          ? el('button', {
            class: 'btn btn--small',
            type: 'button',
            text: `Record ${monthName(status.dueOn)}`,
            'aria-label': `Record ${template.name} for ${monthName(status.dueOn)}`,
            onclick: busy(() => recordTemplate(template), { label: 'Recording…' }),
          })
          : null,
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit the subscription ${template.name}`,
          onclick: () => editRecurring(template),
        }),
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: template.active ? 'Pause' : 'Resume',
          'aria-label': `${template.active ? 'Pause' : 'Resume'} the subscription ${template.name}`,
          onclick: busy(() => pauseTemplate(template)),
        }),
      ]),
    ]),
  ]);
}

function renderRecurring() {
  if (!state.recurring.length) {
    mount(recurringTable, el('p', {
      class: 'empty',
      text: 'Nothing recurring yet. The monthly stack — software, hosting, domains, '
          + 'app-store and API fees — is the spend most reliably forgotten, and a '
          + 'missed subscription is a missed deduction. Add each one once and this '
          + 'panel does the remembering.',
    }));
    return;
  }

  const due = state.recurring
    .reduce((count, t) => count + (recurringStatus(t, isoToday()).due ? 1 : 0), 0);

  mount(recurringTable,
    table(['Subscription', 'Category', 'Amount', 'Standing', ''],
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
    intro: 'Kept light on purpose. It exists so that "what did we spend at Adobe '
         + 'this year" has an answer, and so that January\'s 1099 filing is a '
         + 'report rather than a memory test.',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true,
        value: row ? row.name : '', autocapitalize: 'words' },
      { name: 'email', label: 'Email', type: 'email', value: row ? row.email || '' : '' },
      { name: 'phone', label: 'Phone', type: 'text', inputmode: 'tel',
        value: row ? row.phone || '' : '' },
      { name: 'website', label: 'Website', type: 'text', value: row ? row.website || '' : '' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2,
        value: row ? row.address || '' : '',
        hint: 'What goes on the 1099, for a contractor.' },
      {
        name: 'default_category_id',
        label: 'Their bills usually go to',
        type: 'select',
        value: row ? row.default_category_id || '' : '',
        options: [
          { value: '', label: 'No usual category' },
          ...categoryOptions(state.categories, { keepId: row ? row.default_category_id : null }),
        ],
      },
      { name: 'files_1099', label: 'Needs a 1099-NEC at year end', type: 'checkbox',
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
        website: values.website || null,
        address: values.address || null,
        default_category_id: values.default_category_id || null,
        files_1099: Boolean(values.files_1099),
        tax_id_on_file: Boolean(values.tax_id_on_file),
        notes: values.notes || null,
      });
    },
  });

  if (result) {
    await refresh(renderAll);
    toast('Vendor saved.', 'ok');
  }
}

async function retireVendor(row) {
  const ok = await confirmModal({
    title: `Archive ${row.name}?`,
    body: 'Every expense already booked to them stays as it is, and the 1099 report '
        + 'for past years still names them. They just stop being offered.',
    confirmLabel: 'Archive vendor',
  });
  if (!ok) return;

  try {
    await archiveVendor(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh(renderAll);
  toast(`${row.name} archived.`, 'ok');
}

async function unretireVendor(row) {
  try {
    await restoreVendor(row.id);
  } catch (error) {
    toast(errorMessage(error), 'error');
    return;
  }
  await refresh(renderAll);
  toast(`${row.name} restored.`, 'ok');
}

function vendorRow(row, totals) {
  const total = totals.get(row.id) || null;
  const category = categoryById(row.default_category_id);

  let tax = el('span', { class: 'progress__label', text: '—' });
  if (row.files_1099) {
    tax = el('span', {
      class: row.tax_id_on_file ? 'pill pill--green' : 'pill pill--amber',
      text: row.tax_id_on_file ? 'W-9 on file' : 'No W-9',
    });
  }

  return el('tr', { class: row.archived_at ? 'is-archived' : null }, [
    el('td', {}, [
      el('span', { class: 'row-cell__name', text: row.name }),
      row.email ? el('span', { class: 'row-cell__desc', text: row.email }) : null,
      row.phone ? el('span', { class: 'row-cell__desc', text: row.phone }) : null,
      row.archived_at ? el('span', { class: 'pill', text: 'Archived' }) : null,
    ]),
    el('td', { text: category ? category.name : '—' }),
    el('td', {}, [
      tax,
      total && total.reportable
        ? el('span', {
          class: 'row-cell__desc',
          text: `Over ${formatMoney(state.necThreshold)} — 1099 due`,
        })
        : null,
    ]),
    el('td', { class: 'is-numeric', text: formatSigned(total ? total.total_cents : 0) }),
    el('td', {}, [
      el('span', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Edit',
          'aria-label': `Edit ${row.name}`,
          onclick: () => editVendor(row),
        }),
        row.archived_at
          ? el('button', {
            class: 'btn btn--ghost btn--tiny',
            type: 'button',
            text: 'Restore',
            'aria-label': `Restore ${row.name}`,
            onclick: busy(() => unretireVendor(row)),
          })
          : el('button', {
            class: 'btn btn--ghost btn--tiny',
            type: 'button',
            text: 'Archive',
            'aria-label': `Archive ${row.name}`,
            onclick: busy(() => retireVendor(row)),
          }),
      ]),
    ]),
  ]);
}

function renderVendors() {
  const rows = state.vendors.filter((row) => state.showArchivedVendors || !row.archived_at);

  const toggle = el('label', { class: 'check' }, [
    el('input', {
      type: 'checkbox',
      checked: state.showArchivedVendors,
      onchange: (event) => {
        state.showArchivedVendors = event.target.checked;
        renderVendors();
      },
    }),
    'Show archived vendors',
  ]);

  if (!rows.length) {
    mount(vendorTable, el('p', {
      class: 'empty',
      text: 'No vendors yet. Adding one is optional — an expense can name anybody, and '
          + 'a new name saves itself — but a contractor who might need a 1099 is worth '
          + 'setting up here with the box ticked.',
    }), toggle);
    return;
  }

  // Paid this year, keyed by vendor, with the 1099 arithmetic attached.
  const totals = new Map(
    vendorTotals(state.expenses, state.vendors, state.year, state.necThreshold)
      .map((row) => [row.vendor.id, row]),
  );
  const missing = rows.filter((row) => {
    const total = totals.get(row.id);
    return total && total.missing_tax_id;
  }).length;

  mount(vendorTable,
    table(['Vendor', 'Usually', '1099', `Paid in ${state.year}`, ''],
      rows.map((row) => vendorRow(row, totals)), { wide: true }),
    el('p', {
      class: missing ? 'notice notice--warn' : 'progress__label',
      text: missing
        ? `${missing} ${missing === 1 ? 'contractor is' : 'contractors are'} over the `
          + `${formatMoney(state.necThreshold)} threshold with no W-9 on file. `
          + 'Collect it now, not in January.'
        : `Anyone paid ${formatMoney(state.necThreshold)} or more for services in a `
          + 'calendar year needs a 1099-NEC. Flagging them here is what makes January easy.',
    }),
    toggle);
}

function renderAll() {
  renderExpenses();
  renderRecurring();
  renderVendors();
}

async function main() {
  const ctx = await bootstrap({ requireAdmin: true });
  if (!ctx) return;

  // Who recorded it. Set on insert only — an edit by the bookkeeper must not
  // quietly reassign whose expense it was. An audit column, never shown.
  state.profileId = ctx.profile.id;
  state.year = currentYear();

  try {
    await loadAll();
  } catch (error) {
    renderError(error);
    return;
  }

  mount(panels.expenses,
    panelHead('Expenses', el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn btn--small', type: 'button', text: 'Add expense',
        onclick: addExpense }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Snap a receipt',
        onclick: snapExpense }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Export CSV',
        onclick: exportCsv }),
    ]), 'Money already out of the door, recorded when it was paid. Snap a receipt '
      + 'starts from the photograph and builds the expense around it.'),
    figuresBox,
    buildFilters(),
    expenseTable,
  );

  mount(panels.recurring,
    panelHead('Subscriptions & recurring', el('button', { class: 'btn btn--small',
      type: 'button', text: 'Add a subscription', onclick: () => editRecurring() }),
    'The monthly stack — licences, hosting, domains, app-store and API fees — recorded '
    + 'with a tap when each one falls due. Templates rather than automation: nothing '
    + 'writes to the books unattended.'),
    recurringTable,
  );

  mount(panels.vendors,
    panelHead('Vendors', el('button', { class: 'btn btn--small', type: 'button',
      text: 'Add a vendor', onclick: () => editVendor() }),
    'Who the business pays. Tick the 1099 box on a contractor, and the W-9 box once '
    + 'you have it.'),
    vendorTable,
  );

  mount(byId('portal-root'),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Expenses' }),
        el('p', { text: 'What the business spends, and who it spends it with.' }),
      ]),
    ]),
    // The jump bar pins under the header; the panels must be direct children
    // of #portal-root for its scroll-spy to measure them.
    sectionNav([
      { id: 'expenses', label: 'Expenses', target: panels.expenses },
      { id: 'recurring', label: 'Subscriptions', target: panels.recurring },
      { id: 'vendors', label: 'Vendors', target: panels.vendors },
    ]),
    panels.expenses,
    panels.recurring,
    panels.vendors,
  );

  renderAll();
}

main();
